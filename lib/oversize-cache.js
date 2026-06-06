/**
 * Bounded in-memory cache of original (pre-pack) reply texts, keyed by the
 * outbound Telegram message_id they were sent under. The daemon's `/send`
 * path packs oversized replies to fit within Telegram's 4096-char cap; the
 * full text is stashed here so the user can quote-reply with the word
 * "full" and get the original chunked back to them.
 *
 * No persistence: a daemon restart drops the stash. Recovering across
 * restarts isn't worth the complexity — the user can scroll the terminal
 * for the original or just ask again.
 *
 * Eviction: least-recently-inserted. The Map iterator returns entries in
 * insertion order, so deleting the first key drops the oldest. Calling
 * `get` does NOT bump the entry — there's no read-recency promotion. That
 * keeps the structure trivially correct under the common case (one
 * insert, one expansion, one drop).
 */
export class OversizeCache {
  constructor({ max = 50 } = {}) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('OversizeCache: max must be a positive integer');
    }
    this.max = max;
    this.map = new Map();
  }

  put(messageId, slug, fullText) {
    if (!Number.isInteger(messageId) || messageId < 1) return;
    if (typeof slug !== 'string' || slug.length === 0) return;
    if (typeof fullText !== 'string' || fullText.length === 0) return;
    // If we already had an entry for this id (Telegram would never re-use
    // a message_id, but the test surface might), drop the stale one so
    // insertion order is fresh.
    this.map.delete(messageId);
    this.map.set(messageId, { slug, text: fullText, ts: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get(messageId) {
    return this.map.get(messageId) ?? null;
  }

  has(messageId) {
    return this.map.has(messageId);
  }

  delete(messageId) {
    return this.map.delete(messageId);
  }

  get size() {
    return this.map.size;
  }
}
