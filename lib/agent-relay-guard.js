/**
 * AgentRelayGuard — flood / loop protection for agent-to-agent messages (#36).
 *
 * `send_to(slug, text)` lets one local session message another. That opens a
 * cycle risk: A messages B, B's model answers by messaging A, A answers B …
 * Each hop is an independent model turn, so a hop counter can't be trusted to
 * break the loop (the model would have to faithfully thread it). This guard is
 * therefore model-INDEPENDENT — it bounds the blast radius from the daemon side
 * regardless of what the sessions do:
 *
 *   1. Per-source token bucket — caps how fast any one slug can relay. A
 *      runaway A↔B ping-pong is throttled to the refill rate (slow enough to
 *      notice and kill, bounded in volume) instead of saturating the fleet.
 *   2. Echo dedup — drops an identical (from→to, text) within a short TTL,
 *      which is exactly the signature of a tight reflection loop.
 *
 * Precise cycle detection (chain ids / depth across turns) is a follow-up;
 * this is the cheap, robust v1 backstop. `now` is injectable for tests.
 */

/** djb2 hash → base36. Cheap, dependency-free; used to key the echo-dedup on
 *  the FULL message text instead of a prefix, so two distinct peer messages
 *  that share a long prefix aren't falsely collapsed into one (review #36). */
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const DEFAULT_CAPACITY = 5; // burst allowance per source slug
export const DEFAULT_REFILL_PER_SEC = 0.2; // sustained: ~1 relay / 5s per source
export const DEFAULT_DUP_TTL_MS = 10_000; // identical from→to text dropped within 10s
export const DEFAULT_MAX_TRACKED = 512; // bound on dedup-map / bucket-map size

export class AgentRelayGuard {
  constructor({
    capacity = DEFAULT_CAPACITY,
    refillPerSec = DEFAULT_REFILL_PER_SEC,
    dupTtlMs = DEFAULT_DUP_TTL_MS,
    maxTracked = DEFAULT_MAX_TRACKED,
    now = () => Date.now(),
  } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.dupTtlMs = dupTtlMs;
    this.maxTracked = maxTracked;
    this.now = now;
    /** @type {Map<string, { tokens: number, last: number }>} per-source buckets */
    this.buckets = new Map();
    /** @type {Map<string, number>} dedup key → expiry ts */
    this.recent = new Map();
  }

  /**
   * Decide whether `fromSlug` may relay `text` to `toSlug` right now.
   * Returns { ok: true } or { ok: false, reason: 'rate' | 'duplicate' }.
   * On an allow it consumes a token and records the message for dedup.
   */
  check(fromSlug, toSlug, text) {
    const t = this.now();
    // Echo dedup first — a reflected message shouldn't even cost a token.
    // Key on a hash of the FULL text (not a prefix) so distinct messages
    // sharing a long prefix aren't falsely treated as the same.
    const key = `${fromSlug}>${toSlug}:${text.length}:${hashText(text)}`;
    const expiry = this.recent.get(key);
    if (expiry !== undefined && expiry > t) {
      return { ok: false, reason: 'duplicate' };
    }
    // Token bucket for the source.
    let bucket = this.buckets.get(fromSlug);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: t };
      this.buckets.set(fromSlug, bucket);
    } else {
      const elapsedSec = Math.max(0, (t - bucket.last) / 1000);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
      bucket.last = t;
    }
    if (bucket.tokens < 1) {
      return { ok: false, reason: 'rate' };
    }
    bucket.tokens -= 1;
    this.recent.set(key, t + this.dupTtlMs);
    this._sweep(t);
    return { ok: true };
  }

  /** Drop expired dedup entries; hard-cap both maps so a churn of distinct
   *  slugs/messages can't grow memory without bound. */
  _sweep(t) {
    if (this.recent.size > this.maxTracked) {
      for (const [k, exp] of this.recent) {
        if (exp <= t) this.recent.delete(k);
      }
      // Still over after expiry sweep → evict oldest insertions (Map is ordered).
      while (this.recent.size > this.maxTracked) {
        const oldest = this.recent.keys().next().value;
        if (oldest === undefined) break;
        this.recent.delete(oldest);
      }
    }
    if (this.buckets.size > this.maxTracked) {
      // Prefer evicting IDLE buckets (fully refilled, or untouched for longer
      // than the dedup window) so eviction never resets an active flooder's
      // exhausted bucket back to full capacity (review #36).
      for (const [slug, b] of this.buckets) {
        if (this.buckets.size <= this.maxTracked) break;
        if (b.tokens >= this.capacity || t - b.last >= this.dupTtlMs) {
          this.buckets.delete(slug);
        }
      }
      // Last resort if everything is active: evict oldest-inserted.
      while (this.buckets.size > this.maxTracked) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
  }
}
