/**
 * BroadcastTracker — tracks an in-flight `/all` broadcast until every targeted
 * session has replied or a timeout fires, then hands the collected responses
 * to `onComplete` for a roll-up summary (#30).
 *
 * One tracker per daemon; it holds any number of concurrent broadcasts keyed
 * by their anchor Telegram message_id (the user's `/all` message, or — for a
 * local-CLI broadcast — the daemon's own confirmation message). Replies are
 * matched in by that id: when a session replies, the daemon resolves the
 * reply's originating message (the owes-reply marker == the broadcast anchor)
 * and calls `record(anchorId, slug, text)`. First reply per slug gates
 * completion; later replies from the same slug update the stored text.
 *
 * Timers are injectable (`setTimer`/`clearTimer`) so tests can fire the
 * timeout deterministically. Date.now()/new Date() are intentionally NOT used
 * here — completion is driven purely by record() and the injected timer.
 */

export const DEFAULT_BROADCAST_TIMEOUT_MS = 120_000;

export class BroadcastTracker {
  constructor({
    onComplete = null,
    defaultTimeoutMs = DEFAULT_BROADCAST_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.onComplete = onComplete;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /**
     * @type {Map<number, {
     *   messageId: number,
     *   expected: Set<string>,
     *   responses: Map<string, string>,
     *   timer: any,
     *   source: string,
     * }>}
     */
    this.active = new Map();
  }

  /**
   * Begin tracking a broadcast keyed by `id` (a positive Telegram message_id).
   * `expectedSlugs` is the set of slugs the fan-out actually reached. Re-using
   * an id replaces the prior broadcast on it (a re-sent `/all` supersedes).
   * A zero-reach broadcast completes immediately (timedOut:false, empty).
   */
  start(id, { expectedSlugs = [], timeoutMs = this.defaultTimeoutMs } = {}) {
    if (typeof id !== 'number' || id <= 0) return;
    this._clearTimer(id);
    const entry = {
      messageId: id,
      expected: new Set(expectedSlugs),
      responses: new Map(),
      timer: null,
    };
    this.active.set(id, entry);
    if (entry.expected.size === 0) {
      this._complete(id, { timedOut: false });
      return;
    }
    entry.timer = this.setTimer(() => this._complete(id, { timedOut: true }), timeoutMs);
    // Don't let a pending broadcast timeout keep the daemon process alive on
    // shutdown (real Node timers have unref; injected test timers may not).
    entry.timer?.unref?.();
  }

  /**
   * Record a session's reply against broadcast `id`. Returns true if `id` is an
   * active broadcast (so the caller knows the reply was part of a broadcast),
   * false otherwise. Completes the broadcast once every expected slug has at
   * least one response. A reply from a slug that wasn't in the expected set
   * (e.g. it registered after fan-out) is stored but does not gate completion.
   */
  record(id, slug, text) {
    const entry = this.active.get(id);
    if (!entry) return false;
    entry.responses.set(slug, text);
    if (entry.expected.has(slug) && this._allResponded(entry)) {
      this._complete(id, { timedOut: false });
    }
    return true;
  }

  /** True if `id` is currently being tracked. */
  has(id) {
    return this.active.has(id);
  }

  /** Drop a broadcast without firing onComplete (e.g. on daemon shutdown). */
  cancel(id) {
    this._clearTimer(id);
    this.active.delete(id);
  }

  /** Cancel every in-flight broadcast (shutdown). */
  cancelAll() {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }

  _allResponded(entry) {
    for (const s of entry.expected) {
      if (!entry.responses.has(s)) return false;
    }
    return true;
  }

  _clearTimer(id) {
    const entry = this.active.get(id);
    if (entry?.timer != null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  _complete(id, { timedOut }) {
    const entry = this.active.get(id);
    if (!entry) return;
    this._clearTimer(id);
    this.active.delete(id);
    const missing = [...entry.expected].filter((s) => !entry.responses.has(s));
    try {
      this.onComplete?.({
        messageId: entry.messageId,
        responses: entry.responses,
        expected: [...entry.expected],
        missing,
        timedOut,
      });
    } catch {
      // onComplete is daemon-side (builds + sends the summary). A synchronous
      // throw there must never crash the tracker; async rejections are the
      // daemon's own responsibility to catch.
    }
  }
}
