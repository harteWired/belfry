/**
 * In-memory LRU mapping outbound Telegram message_id → slug.
 *
 * Populated when belfry sends a message to Telegram, consulted when an
 * inbound reply quotes one. Capped to prevent unbounded growth in
 * long-lived daemon runs.
 *
 * Lossy by design: if a reply quotes a message belfry sent before its
 * last restart, the lookup misses and the router falls back to the
 * /<slug-name> prefix path (or drops the message). Acceptable for a
 * single-user daemon — restarts are rare, and the user can always
 * re-trigger the slug to get a fresh quoteable message.
 */

const DEFAULT_CAPACITY = 500;

export class ReplyTracker {
  constructor({ capacity = DEFAULT_CAPACITY } = {}) {
    this.capacity = capacity;
    /** Map iteration order is insertion order — used for LRU eviction. */
    this.map = new Map();
  }

  record(messageId, slug) {
    if (typeof messageId !== 'number' || typeof slug !== 'string' || slug.length === 0) {
      return;
    }
    // Re-insert to bump recency.
    if (this.map.has(messageId)) this.map.delete(messageId);
    this.map.set(messageId, slug);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  lookup(messageId) {
    if (typeof messageId !== 'number') return null;
    return this.map.get(messageId) ?? null;
  }

  size() {
    return this.map.size;
  }
}
