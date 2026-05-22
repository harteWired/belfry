/**
 * Per-slug dedup for ready pings, keyed on `last_response` text equality
 * with an extra "just-sent" stash to suppress reply-tool echoes.
 *
 * Two duplicate scenarios this catches:
 *
 *   1. /loop watchdog turns. Pure-tool turns produce no new assistant
 *      text, so the hook preserves the prior `last_response`. The watcher
 *      then re-fires onUpdate at the watchdog cadence (every ~10 min for
 *      belfry-doctor), and pre-dedup we'd send the same body each time.
 *      Suppressed here via content equality of `last_response` strings.
 *
 *   2. Reply-tool send followed by a ready ping for the same content.
 *      When the model calls `mcp__belfry__reply`, sendOutbound ships the
 *      text to Telegram (msg N). The Stop hook then captures the same
 *      text into `last_response` and the watcher emits a ready ping
 *      carrying it (msg N+1). v0.1.3 missed this because it keyed on
 *      `last_response_at` (which advances on every turn). v0.1.4 keys on
 *      text and additionally consults `recordJustSent` — sendOutbound
 *      stashes (slug → text, ts) on every send; a matching ready ping
 *      within the recency window is suppressed.
 *
 * Only used for ready transitions. error and waiting always fire — they
 * are rare and represent state the user must see regardless.
 *
 * Stateful (two Maps), so the caller holds an instance for the lifetime
 * of the daemon. Restart resets the dedup; first ping after a restart
 * always fires, which is desirable (it confirms belfry is back).
 */
export class PingDedup {
  /**
   * @param {object} [opts]
   * @param {number} [opts.replyEchoWindowMs] — how long after sendOutbound
   *   a matching ready ping is suppressed as a reply-tool echo. Default 10s.
   *   Outside the window we still suppress via plain content equality, so
   *   this only governs the first ping after a reply-tool send.
   * @param {() => number} [opts.now] — injectable clock for tests.
   */
  constructor({ replyEchoWindowMs = 10_000, now = () => Date.now() } = {}) {
    this.lastBySlug = new Map();      // slug → last_response text we last pinged
    this.justSentBySlug = new Map();  // slug → { text, ts }
    this.window = replyEchoWindowMs;
    this.now = now;
  }

  /**
   * Record that we just shipped `text` to Telegram for `slug`. The next
   * ready ping that arrives for this slug with matching `last_response`
   * within `replyEchoWindowMs` will be suppressed.
   *
   * @param {string} slug
   * @param {unknown} text
   */
  recordJustSent(slug, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    this.justSentBySlug.set(slug, { text, ts: this.now() });
  }

  /**
   * Returns true if this ready ping should be skipped.
   *
   * @param {string} slug
   * @param {unknown} lastResponse — the dashboard JSON's `last_response`
   *   string. Missing or non-string → never dedup.
   * @returns {boolean}
   */
  shouldSkip(slug, lastResponse) {
    if (typeof lastResponse !== 'string' || lastResponse.length === 0) {
      return false;
    }
    // Reply-tool echo suppression: matches the text we just sent, within
    // the recency window. Update lastBySlug too so a /loop watchdog tick
    // carrying the same content is also suppressed via the content path.
    const stash = this.justSentBySlug.get(slug);
    if (stash && stash.text === lastResponse && this.now() - stash.ts <= this.window) {
      this.lastBySlug.set(slug, lastResponse);
      return true;
    }
    // Content equality: same body as the last ping we sent for this slug.
    if (this.lastBySlug.get(slug) === lastResponse) return true;
    this.lastBySlug.set(slug, lastResponse);
    return false;
  }
}
