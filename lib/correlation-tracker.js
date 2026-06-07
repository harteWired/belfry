/**
 * CorrelationTracker — daemon-side request/reply correlation for agent-to-agent
 * messaging (#36 Tier 1; prerequisite for the bidirectional bridge in #29).
 *
 * When a message is relayed to an agent that will reply asynchronously (e.g. a
 * deployed Agent-SDK app reached via its inbox webhook, or a peer session whose
 * answer must route back to the original asker), the daemon needs to remember
 * WHERE the reply should go. `open(origin)` mints a short correlation id and
 * stashes the opaque routing context; the reply carries that id back, and
 * `resolve(id)` returns the context so the daemon can route the answer to the
 * original requester (a Telegram message, or another slug/host on the mesh).
 *
 * `origin` is opaque to this module — typically
 *   { kind: 'telegram', messageId } or { kind: 'agent', slug, host }
 * but the tracker neither inspects nor depends on its shape.
 *
 * Single-consume: resolve() removes the entry (one request → one reply). Entries
 * expire after a TTL so an agent that never answers doesn't leak, and the set is
 * bounded so a flood can't grow memory without limit. Timers + id generation are
 * injectable so tests are deterministic (no wall clock, no randomness).
 */

export const DEFAULT_CORRELATION_TTL_MS = 10 * 60_000; // 10 min
export const DEFAULT_MAX_PENDING = 1000;

export class CorrelationTracker {
  constructor({
    ttlMs = DEFAULT_CORRELATION_TTL_MS,
    maxPending = DEFAULT_MAX_PENDING,
    genId = defaultGenId,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onExpire = null,
    log = () => {},
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxPending = Math.max(1, maxPending);
    this.genId = genId;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onExpire = onExpire;
    this.log = log;
    /** @type {Map<string, { origin: any, timer: any }>} insertion-ordered */
    this.pending = new Map();
  }

  get size() {
    return this.pending.size;
  }

  has(id) {
    return this.pending.has(id);
  }

  /**
   * Register a pending request expecting a reply. Returns a fresh correlation
   * id. Evicts the oldest pending entry first if at capacity (its waiter will
   * never resolve — better to drop the stalest than to grow unbounded).
   */
  open(origin) {
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.log(`correlation: capacity ${this.maxPending} reached — evicting oldest ${oldest}`);
        this._drop(oldest, true);
      }
    }
    let id = this.genId();
    // Astronomically unlikely with random ids, but guarantee uniqueness.
    while (this.pending.has(id)) id = this.genId();
    const timer = this.setTimer(() => this._drop(id, true), this.ttlMs);
    timer?.unref?.();
    this.pending.set(id, { origin, timer });
    return id;
  }

  /**
   * Consume the pending entry for `id`, returning its origin context (and
   * cancelling its timeout), or null if unknown/expired. One reply per request.
   */
  resolve(id) {
    const entry = this.pending.get(id);
    if (!entry) return null;
    if (entry.timer != null) this.clearTimer(entry.timer);
    this.pending.delete(id);
    return entry.origin;
  }

  /** Look at an origin without consuming it. */
  peek(id) {
    return this.pending.get(id)?.origin ?? null;
  }

  /** Drop a pending entry without firing onExpire (caller-initiated cancel). */
  cancel(id) {
    return this._drop(id, false);
  }

  /** Cancel every pending entry (shutdown). */
  cancelAll() {
    for (const id of [...this.pending.keys()]) this._drop(id, false);
  }

  _drop(id, expired) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (entry.timer != null) this.clearTimer(entry.timer);
    this.pending.delete(id);
    if (expired && this.onExpire) {
      try {
        this.onExpire(id, entry.origin);
      } catch {
        // onExpire is daemon-side; a throw must never break the tracker.
      }
    }
    return true;
  }
}

function defaultGenId() {
  // 12 hex chars (~48 bits) — ample for concurrent in-flight correlations, and
  // short enough to ride compactly on a channel tag / A2A envelope field.
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
