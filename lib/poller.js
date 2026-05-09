/**
 * Telegram getUpdates long-poll loop.
 *
 * Single instance per daemon — Telegram delivers each update to whichever
 * client polls first, so a second poller would steal messages.
 *
 * Loop:
 *   1. POST /getUpdates with offset = lastSeen + 1, timeout = 30s.
 *   2. For each update, run through router; if it routes, hand the
 *      (slug, text) pair to the target (Registry in production).
 *   3. Update offset to the highest update_id seen.
 *   4. On error: log, sleep with backoff, retry.
 *
 * The `target` interface is small on purpose:
 *   - `deliver(slug, text, messageId) → number` (fan-out count for delivery)
 *   - `knownSlugs() → Set<string>` (for the `/<slug-name> body` prefix path)
 *
 * Optional `onStatusRequest({slug, messageId})` is called when the user sends
 * `/status [slug]`. Provided by the daemon, not the registry.
 *
 * fetchFn is injectable for tests. Defaults to global fetch.
 */

import { route } from './router.js';
import { downloadFile } from './telegram.js';

const DEFAULT_LONG_POLL_SECONDS = 30;
const ERROR_BACKOFF_MS = 2000;

export class Poller {
  constructor({
    botToken,
    expectedChatId,
    replyTracker,
    target,
    onStatusRequest = null,
    onNickRequest = null,
    onHelpRequest = null,
    onUnmatched = null,
    onApproval = null,
    resolveNickname = () => null,
    attachmentDir = null,
    log = () => {},
    fetchFn = globalThis.fetch,
    longPollSeconds = DEFAULT_LONG_POLL_SECONDS,
  }) {
    this.botToken = botToken;
    this.expectedChatId = expectedChatId;
    this.replyTracker = replyTracker;
    this.target = target;
    this.onStatusRequest = onStatusRequest;
    this.onNickRequest = onNickRequest;
    this.onHelpRequest = onHelpRequest;
    this.onUnmatched = onUnmatched;
    this.onApproval = onApproval;
    this.resolveNickname = resolveNickname;
    this.attachmentDir = attachmentDir; // path on disk where downloaded photos / voice land; null disables attachments
    this.log = log;
    this.fetchFn = fetchFn;
    this.longPollSeconds = longPollSeconds;
    this.offset = 0;
    this.running = false;
    this.controller = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  async stop() {
    this.running = false;
    if (this.controller) this.controller.abort();
  }

  async loop() {
    // Prime the offset so we don't replay the last 24h of unconfirmed updates
    // into the inbox on every restart. Best-effort — if Telegram is unreachable
    // we just fall through and the normal error-backoff loop takes over.
    await this.primeOffset();
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        if (err.name === 'AbortError') return;
        this.log(`poller error: ${err.message}`);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  /**
   * One-shot priming call. `offset: -1` returns the most recent update (or
   * nothing if the queue is empty); we advance past it so the first real tick
   * only sees genuinely new messages. Failures here are logged and ignored —
   * the worst case is one restart's worth of stale-message replay, which the
   * normal loop already handles.
   */
  async primeOffset() {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] }),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (!json?.ok || !Array.isArray(json.result) || json.result.length === 0) return;
      const last = json.result[json.result.length - 1];
      if (typeof last?.update_id === 'number') {
        this.offset = last.update_id + 1;
        this.log(`primed offset to ${this.offset} (skipped ${json.result.length} backlog message(s))`);
      }
    } catch (err) {
      this.log(`prime failed: ${err.message}`);
    }
  }

  async tick() {
    this.controller = new AbortController();
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;
    const body = JSON.stringify({
      offset: this.offset,
      timeout: this.longPollSeconds,
      allowed_updates: ['message', 'callback_query'],
    });
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: this.controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`getUpdates ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.result)) {
      throw new Error(`getUpdates returned ${JSON.stringify(json).slice(0, 200)}`);
    }
    for (const update of json.result) {
      // Fire-and-forget — process() is async to support photo/voice
      // downloads. Offset advance must happen synchronously so subsequent
      // tick() calls don't replay this update.
      this.process(update).catch((err) => this.log(`process error: ${err.message}`));
      if (typeof update.update_id === 'number' && update.update_id >= this.offset) {
        this.offset = update.update_id + 1;
      }
    }
  }

  /**
   * Best-effort photo extraction. Returns a path on disk if the message has
   * a photo and we managed to download it; null on any failure. Photos are
   * sized in tiers — pick the largest that fits the cap.
   */
  async maybeDownloadPhoto(message) {
    if (!this.attachmentDir) return null;
    if (!Array.isArray(message?.photo) || message.photo.length === 0) return null;
    // Telegram returns sizes ascending. Largest is last.
    const largest = message.photo[message.photo.length - 1];
    if (!largest?.file_id) return null;
    try {
      return await downloadFile({
        botToken: this.botToken,
        fileId: largest.file_id,
        destDir: this.attachmentDir,
        destName: `photo-${Date.now()}-${message.message_id ?? 'x'}`,
        fetchImpl: this.fetchFn,
      });
    } catch (err) {
      this.log(`photo download failed (msg ${message.message_id}): ${err.message}`);
      return null;
    }
  }

  async process(update) {
    // callback_query updates carry inline-button taps. Telegram delivers them
    // as a sibling to `message`, never together — so we branch here before
    // the message-path routing. Only accept callbacks from BELFRY_CHAT_ID.
    if (update?.callback_query) {
      const cq = update.callback_query;
      if (cq.message?.chat?.id !== this.expectedChatId) return;
      const data = typeof cq.data === 'string' ? cq.data : '';
      if (!data.startsWith('belfry:')) return;
      const parts = data.split(':');
      if (parts.length !== 3) return;
      const [, verb, token] = parts;
      if (!this.onApproval) {
        this.log(`callback_query dropped — no approval handler wired (verb ${verb})`);
        return;
      }
      Promise.resolve(this.onApproval({
        callbackQueryId: cq.id,
        verb,
        token,
        chatId: cq.message.chat.id,
        messageId: cq.message.message_id,
      })).catch((err) => this.log(`approval handler error: ${err.message}`));
      return;
    }
    let imagePath = null;
    if (update?.message) {
      imagePath = await this.maybeDownloadPhoto(update.message);
    }
    const routed = route({
      update,
      expectedChatId: this.expectedChatId,
      replyTracker: this.replyTracker,
      // Pass a live accessor instead of materializing a Set per update —
      // route() only reaches the prefix-path branch on a small minority of
      // updates, so the Set's allocation is wasted on chat-id mismatches,
      // empty text, /status, and quote-reply matches.
      hasSlug: (s) => (this.target.hasSlug ? this.target.hasSlug(s) : this.target.knownSlugs().has(s)),
      resolveNickname: this.resolveNickname,
    });
    if (!routed) return;
    if (routed.action === 'status') {
      if (!this.onStatusRequest) {
        this.log(`status request dropped — no handler wired (slug=${routed.slug ?? '*'})`);
        return;
      }
      Promise.resolve(this.onStatusRequest({ slug: routed.slug, messageId: routed.messageId }))
        .catch((err) => this.log(`status handler error: ${err.message}`));
      this.log(`status request slug=${routed.slug ?? '*'} (msg ${routed.messageId})`);
      return;
    }
    if (routed.action === 'nick-set' || routed.action === 'nick-unset' || routed.action === 'nick-list') {
      if (!this.onNickRequest) {
        this.log(`${routed.action} dropped — no handler wired`);
        return;
      }
      Promise.resolve(this.onNickRequest(routed))
        .catch((err) => this.log(`nick handler error: ${err.message}`));
      return;
    }
    if (routed.action === 'help') {
      if (!this.onHelpRequest) {
        this.log(`help dropped — no handler wired`);
        return;
      }
      Promise.resolve(this.onHelpRequest(routed))
        .catch((err) => this.log(`help handler error: ${err.message}`));
      return;
    }
    if (routed.action === 'unmatched') {
      if (!this.onUnmatched) return; // silent drop — agent (#13) not wired
      Promise.resolve(this.onUnmatched({ text: routed.text, messageId: routed.messageId }))
        .catch((err) => this.log(`unmatched handler error: ${err.message}`));
      return;
    }
    const attachment = imagePath ? { imagePath } : null;
    const fanout = this.target.deliver(routed.slug, routed.text, routed.messageId ?? null, attachment);
    this.log(`routed ${routed.slug} → ${fanout} instance(s) (${routed.text.length} chars${imagePath ? ', +image' : ''})`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
