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

export class RecentMessages {
  constructor({ ringSize = DEFAULT_RING_SIZE } = {}) {
    this.ringSize = ringSize;
    /** slug → array (oldest first, newest last). */
    this.bySlug = new Map();
  }

  /**
   * Append one outbound event to the slug's ring. `kind` is a coarse tag
   * (e.g. `event`, `digest`, `auto-reply`) so the agent can tell whether
   * a row was a status ping vs a full digest.
   */
  push(slug, { kind, text, ts = Date.now() }) {
    if (!slug || typeof text !== 'string') return;
    let buf = this.bySlug.get(slug);
    if (!buf) {
      buf = [];
      this.bySlug.set(slug, buf);
    }
    buf.push({ kind, text, ts });
    if (buf.length > this.ringSize) buf.splice(0, buf.length - this.ringSize);
  }

  /** Newest-first window of up to `n` items. */
  recent(slug, n = 10) {
    const buf = this.bySlug.get(slug);
    if (!buf || buf.length === 0) return [];
    const start = Math.max(0, buf.length - n);
    return buf.slice(start).reverse();
  }

  /** All slugs that have any history. */
  knownSlugs() {
    return [...this.bySlug.keys()];
  }
}
