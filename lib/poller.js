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
import { voiceErrorReply } from './voice.js';

const DEFAULT_LONG_POLL_SECONDS = 30;
const ERROR_BACKOFF_MS = 2000;
// Window of recent update_ids we've already dispatched. Defends against
// Telegram returning the same update twice — which we observed in the
// duplicate-reply bug (2026-05-11): one user message produced both a
// `deliver` route and an `unmatched` route, each in a separate process()
// call. Telegram's contract is unique-update-id, but the underlying cause
// hasn't been root-caused (could be Telegram retransmit on partial ack,
// could be a second poller transient, could be a retry path we haven't
// found). A small ring buffer is cheap insurance.
const RECENT_UPDATE_IDS_CAP = 256;

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
    onResumeRequest = null,
    onFullExpand = null,
    resolveNickname = () => null,
    resolveTopic = () => null,
    hasFullStash = () => false,
    attachmentDir = null, // path on disk where downloaded photos land; null disables attachments
    handleVoice = null, // ({message}) → {text}|{error}|null — voice-note transcription (see lib/voice.js)
    sendVoiceReply = null, // ({text, replyToMessageId}) → void — emits the transcript echo + voice-error replies
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
    this.onResumeRequest = onResumeRequest;
    this.onFullExpand = onFullExpand;
    this.resolveNickname = resolveNickname;
    this.resolveTopic = resolveTopic;
    this.hasFullStash = hasFullStash;
    this.attachmentDir = attachmentDir;
    this.handleVoice = handleVoice;
    this.sendVoiceReply = sendVoiceReply;
    this.log = log;
    this.fetchFn = fetchFn;
    this.longPollSeconds = longPollSeconds;
    this.offset = 0;
    this.running = false;
    this.controller = null;
    // Insertion-order Map of recently-seen update_ids → true. Bounded
    // ring buffer keeping us from re-dispatching the same update if
    // Telegram returns it twice.
    this.recentUpdateIds = new Map();
  }

  /**
   * Returns true if this update_id has already been dispatched. On miss,
   * records it (and evicts the oldest if full). Non-numeric update_ids
   * are not tracked — they shouldn't exist in valid Telegram updates and
   * always passing them through preserves prior behavior in tests/edge
   * cases.
   */
  markAndCheckDuplicate(updateId) {
    if (typeof updateId !== 'number') return false;
    if (this.recentUpdateIds.has(updateId)) return true;
    this.recentUpdateIds.set(updateId, true);
    if (this.recentUpdateIds.size > RECENT_UPDATE_IDS_CAP) {
      // Map iteration is insertion order — first key is the oldest.
      const oldest = this.recentUpdateIds.keys().next().value;
      this.recentUpdateIds.delete(oldest);
    }
    return false;
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
      // Skip if we've already dispatched this update_id. Telegram's API
      // contract says update_ids are unique, but we've observed duplicate
      // dispatch in production (the 2026-05-11 duplicate-reply bug). Better
      // to no-op a repeat than to fire two replies for one user message.
      if (this.markAndCheckDuplicate(update.update_id)) {
        this.log(`poller: duplicate update_id ${update.update_id} — skipping`);
        if (typeof update.update_id === 'number' && update.update_id >= this.offset) {
          this.offset = update.update_id + 1;
        }
        continue;
      }
      // Fire-and-forget — process() is async to support photo downloads.
      // Offset advance must happen synchronously so subsequent tick()
      // calls don't replay this update.
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
      // Tokens are 16-char hex (8 random bytes). Reject anything else as
      // foreign / spoofed before doing the Map lookup. Defense in depth —
      // chat-ID gate already protects against external attackers.
      if (!/^[0-9a-f]{16}$/.test(token)) return;
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
    // Chat-ID check before any side-effect work (photo download, etc.).
    // Without this, a stranger who knows the bot's @username can DM a 4 MB
    // photo and force the daemon to fetch + write to disk before route()
    // drops the message at routing time. The chat-ID is the trust boundary;
    // gate everything that touches network / disk on it.
    if (update?.message?.chat?.id !== undefined && update.message.chat.id !== this.expectedChatId) {
      return;
    }

    // Voice-note path. Telegram delivers voice messages with no `text` field,
    // so they'd otherwise fall through route() and get dropped. Transcribing
    // turns them into ordinary text updates which then flow through quote-
    // reply / prefix / agent routing the same as a typed message. The handler
    // also handles the "voice support is off" reply when no key is configured.
    if (update?.message?.voice && this.handleVoice) {
      const result = await this.handleVoice({ message: update.message });
      if (result?.error) {
        await this.sendVoiceReply?.({
          text: voiceErrorReply(result),
          replyToMessageId: update.message.message_id,
        });
        this.log(`voice dropped (msg ${update.message.message_id}): ${result.error}`);
        return;
      }
      if (!result?.text) return;
      this.log(`voice transcribed (msg ${update.message.message_id}, ${result.text.length} chars)`);
      // Echo the transcript so the user can verify Whisper got it right
      // and quote-reply with a correction if not.
      await this.sendVoiceReply?.({
        text: `🎙 "${truncate(result.text, 200)}"`,
        replyToMessageId: update.message.message_id,
      });
      // Inject the transcript into the update so the rest of the routing
      // pipeline treats this as a normal text message. Clearing .voice
      // keeps later defensive checks (and any future re-entry) honest.
      update = { ...update, message: { ...update.message, text: result.text, voice: undefined } };
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
      resolveTopic: this.resolveTopic,
      hasFullStash: this.hasFullStash,
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
    if (routed.action === 'resume') {
      if (!this.onResumeRequest) {
        this.log(`resume dropped — no handler wired`);
        return;
      }
      Promise.resolve(this.onResumeRequest(routed))
        .catch((err) => this.log(`resume handler error: ${err.message}`));
      return;
    }
    if (routed.action === 'full-expand') {
      if (!this.onFullExpand) {
        this.log(`full-expand dropped — no handler wired (msg ${routed.targetMessageId})`);
        return;
      }
      Promise.resolve(this.onFullExpand({
        targetMessageId: routed.targetMessageId,
        messageId: routed.messageId,
      })).catch((err) => this.log(`full-expand handler error: ${err.message}`));
      return;
    }
    if (routed.action === 'unmatched') {
      if (!this.onUnmatched) return; // silent drop — agent (#13) not wired
      Promise.resolve(this.onUnmatched({ text: routed.text, messageId: routed.messageId }))
        .catch((err) => this.log(`unmatched handler error: ${err.message}`));
      return;
    }
    // Only download the photo once we know the message is going to be
    // delivered to a session. Reserved-command / unmatched / status paths
    // get dropped without writing to disk.
    const imagePath = await this.maybeDownloadPhoto(update.message);
    const attachment = imagePath ? { imagePath } : null;
    const fanout = this.target.deliver(routed.slug, routed.text, routed.messageId ?? null, attachment);
    this.log(`routed ${routed.slug} → ${fanout} instance(s) (${routed.text.length} chars${imagePath ? ', +image' : ''})`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, cap) {
  if (text.length <= cap) return text;
  return text.slice(0, cap - 1) + '…';
}
