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
    resolveNickname = () => null,
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
    this.resolveNickname = resolveNickname;
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
        body: JSON.stringify({ offset: -1, timeout: 0, allowed_updates: ['message'] }),
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
      allowed_updates: ['message'],
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
      this.process(update);
      if (typeof update.update_id === 'number' && update.update_id >= this.offset) {
        this.offset = update.update_id + 1;
      }
    }
  }

  process(update) {
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
    const fanout = this.target.deliver(routed.slug, routed.text, routed.messageId ?? null);
    this.log(`routed ${routed.slug} → ${fanout} instance(s) (${routed.text.length} chars)`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
