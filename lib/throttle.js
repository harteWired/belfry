/**
 * Per-slug coalesce + throttle.
 *
 * Two windows per slug:
 *
 *   1. coalesce  — short (default 5s). Multiple events within this window
 *                  collapse into one send describing the latest state. Stops
 *                  fan-out bursts (10 subagent permission prompts in 200ms)
 *                  from each producing a Telegram message.
 *
 *   2. throttle  — long (default 30s). Hard ceiling: at most one send per
 *                  slug per throttle window. Subsequent events while the
 *                  throttle is active are dropped (the latest state was
 *                  already conveyed).
 *
 * The dispatch callback receives the "latest event" for the slug at the end
 * of the coalesce window. After dispatch, the throttle window starts and
 * blocks further sends until it expires.
 */
export class Throttle {
  constructor({ coalesceMs, throttleMs, dispatch, now = Date.now }) {
    this.coalesceMs = coalesceMs;
    this.throttleMs = throttleMs;
    this.dispatch = dispatch;
    this.now = now;
    /** slug → { latestEvent, coalesceTimer, throttledUntil } */
    this.state = new Map();
  }

  enqueue(slug, event) {
    const entry = this.state.get(slug) ?? {
      latestEvent: null,
      coalesceTimer: null,
      throttledUntil: 0,
    };

    if (this.now() < entry.throttledUntil) {
      // Throttle window active — drop. The event the user already saw at
      // dispatch time was the most-recent state; if the current event flips
      // back later (e.g. ready→working→ready), that next ready will fire
      // after the window expires.
      return { dropped: true, reason: 'throttled' };
    }

    entry.latestEvent = event;
    if (entry.coalesceTimer === null) {
      entry.coalesceTimer = setTimeout(() => {
        const ev = entry.latestEvent;
        entry.coalesceTimer = null;
        entry.latestEvent = null;
        entry.throttledUntil = this.now() + this.throttleMs;
        this.state.set(slug, entry);
        this.dispatch(slug, ev);
      }, this.coalesceMs);
    }
    this.state.set(slug, entry);
    return { dropped: false };
  }

  clearAll() {
    for (const entry of this.state.values()) {
      if (entry.coalesceTimer) clearTimeout(entry.coalesceTimer);
    }
    this.state.clear();
  }
}
