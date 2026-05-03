/**
 * Telegram getUpdates long-poll loop.
 *
 * Single instance per daemon — Telegram delivers each update to whichever
 * client polls first, so a second poller would steal messages.
 *
 * Loop:
 *   1. POST /getUpdates with offset = lastSeen + 1, timeout = 30s.
 *   2. For each update, run through router; if it routes, push to inbox.
 *   3. Update offset to the highest update_id seen.
 *   4. On error: log, sleep with backoff, retry.
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
    knownSlugs,
    inbox,
    log = () => {},
    fetchFn = globalThis.fetch,
    longPollSeconds = DEFAULT_LONG_POLL_SECONDS,
  }) {
    this.botToken = botToken;
    this.expectedChatId = expectedChatId;
    this.replyTracker = replyTracker;
    this.knownSlugs = knownSlugs;
    this.inbox = inbox;
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
      knownSlugs: this.knownSlugs,
    });
    if (!routed) return;
    this.inbox.push(routed.slug, routed.queue, routed.text);
    this.log(`inbox push ${routed.slug}/${routed.queue} (${routed.text.length} chars)`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
