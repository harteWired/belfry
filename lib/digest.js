/**
 * Per-slug rollup digest buffer (#11).
 *
 * When a slug subscribes with `digest: true`, the watcher feeds events into
 * this class instead of the per-event throttle. Events accumulate per slug;
 * a flush fires either after `idleMs` of quiet OR after `windowMs` since the
 * first event in the current burst — whichever comes first.
 *
 * The flush callback receives the buffered list and is expected to call the
 * summarizer + composer + sendMessage. This class only does buffering and
 * timing — no awareness of model calls or Telegram.
 */
export class Digest {
  /**
   * @param {object} opts
   * @param {number} opts.idleMs - flush this long after the most recent enqueue
   * @param {number} opts.windowMs - flush at most this long after the first enqueue in a burst
   * @param {(slug: string, events: any[]) => Promise<void>|void} opts.flush
   * @param {() => number} [opts.now]
   */
  constructor({ idleMs, windowMs, flush, now = Date.now }) {
    if (!(idleMs > 0)) throw new Error('Digest: idleMs must be > 0');
    if (!(windowMs >= idleMs)) throw new Error('Digest: windowMs must be >= idleMs');
    this.idleMs = idleMs;
    this.windowMs = windowMs;
    this.flush = flush;
    this.now = now;
    /** slug → { events, idleTimer, windowTimer, firstAt } */
    this.state = new Map();
  }

  enqueue(slug, event) {
    let entry = this.state.get(slug);
    const t = this.now();
    if (!entry) {
      entry = {
        events: [],
        idleTimer: null,
        windowTimer: null,
        firstAt: t,
      };
      this.state.set(slug, entry);
      entry.windowTimer = setTimeout(() => this._flush(slug, 'window'), this.windowMs);
    }
    entry.events.push({ ...event, ts: t });
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this._flush(slug, 'idle'), this.idleMs);
  }

  _flush(slug /* , reason */) {
    const entry = this.state.get(slug);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.windowTimer) clearTimeout(entry.windowTimer);
    this.state.delete(slug);
    if (entry.events.length === 0) return;
    // Wrap in an async IIFE so synchronous throws AND rejected promises both
    // surface as a caught rejection. The flush callback is responsible for
    // its own error logging — we just keep errors from leaking out.
    (async () => this.flush(slug, entry.events))().catch(() => {});
  }

  /** Force-flush every pending slug. Used on shutdown. */
  flushAll() {
    for (const slug of [...this.state.keys()]) {
      this._flush(slug, 'flushAll');
    }
  }

  clearAll() {
    for (const entry of this.state.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.windowTimer) clearTimeout(entry.windowTimer);
    }
    this.state.clear();
  }
}
