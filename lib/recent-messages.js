/**
 * Per-slug in-memory ring of recent outbound belfry messages. The
 * conversational agent reads these to answer "what's been happening with
 * X?" without going to disk. ~64 entries per slug is plenty for "what
 * happened today" — anything older is paged off.
 *
 * State is intentionally non-persistent. A daemon restart drops all rings;
 * the user can /status to seed context if needed. We don't write history to
 * disk because the dashboard JSON already lives there and persisting message
 * snippets duplicates the prompt/response payload that's already on /tmp.
 */

const DEFAULT_RING_SIZE = 64;

/**
 * Fixed-size circular buffer per slug. Push is O(1) — we write to
 * buf[head % ringSize] and bump head. recent() reconstructs newest-first
 * order by walking backwards from head.
 *
 * Avoids the splice(0, …) shift that the previous Array-backed
 * implementation did on every push when the buffer was full.
 */
class Ring {
  constructor(size) {
    this.size = size;
    this.buf = new Array(size);
    this.head = 0; // next write index (monotonic)
    this.count = 0; // entries currently stored, capped at size
  }

  push(item) {
    this.buf[this.head % this.size] = item;
    this.head++;
    if (this.count < this.size) this.count++;
  }

  /** Newest-first up to n. */
  recent(n) {
    const out = [];
    const want = Math.min(n, this.count);
    for (let i = 0; i < want; i++) {
      out.push(this.buf[(this.head - 1 - i + this.size) % this.size]);
    }
    return out;
  }
}

export class RecentMessages {
  constructor({ ringSize = DEFAULT_RING_SIZE } = {}) {
    this.ringSize = ringSize;
    /** slug → Ring */
    this.bySlug = new Map();
  }

  /**
   * Append one outbound event to the slug's ring. `kind` is a coarse tag
   * (e.g. `event`, `digest`, `outbound`) so the agent can tell whether a
   * row was a status ping vs a full digest.
   */
  push(slug, { kind, text, ts = Date.now() }) {
    if (!slug || typeof text !== 'string') return;
    let ring = this.bySlug.get(slug);
    if (!ring) {
      ring = new Ring(this.ringSize);
      this.bySlug.set(slug, ring);
    }
    ring.push({ kind, text, ts });
  }

  /** Newest-first window of up to `n` items. */
  recent(slug, n = 10) {
    const ring = this.bySlug.get(slug);
    if (!ring || ring.count === 0 || n <= 0) return [];
    return ring.recent(n);
  }

  /** All slugs that have any history. */
  knownSlugs() {
    return [...this.bySlug.keys()];
  }
}
