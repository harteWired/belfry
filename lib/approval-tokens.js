/**
 * Short-lived token store for approval buttons. When a `waiting` ping is
 * sent with inline buttons, we generate a token and put it in each button's
 * callback_data. On callback, the token resolves back to the originating
 * (slug, message_id) so we can deliver the answer to the right session and
 * edit the right message.
 *
 * Tokens are 8-byte hex (16 chars) — well under Telegram's 64-byte
 * callback_data cap. TTL is bounded; expired entries are GC'd lazily on
 * next access. Consumed-on-use to make double-taps idempotent.
 */

import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60_000; // 1h

export class ApprovalTokens {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, { slug, messageId, ts }>} */
    this.entries = new Map();
  }

  /**
   * Issue a fresh token. originalText is the full message body so the
   * approval handler can re-render it with an appended outcome trailer
   * after the keyboard is dropped (Telegram's editMessageText replaces
   * the body, so the handler has to supply the whole new text).
   */
  issue(slug, messageId, originalText = '') {
    const token = randomBytes(8).toString('hex');
    this.entries.set(token, { slug, messageId, originalText, ts: this.now() });
    return token;
  }

  /**
   * Look up and consume a token. Returns the entry or null if unknown or
   * expired. Once consumed, the token is gone — re-tapping the same button
   * gets null (handler should report "already answered").
   */
  consume(token) {
    if (typeof token !== 'string') return null;
    const entry = this.entries.get(token);
    if (!entry) return null;
    this.entries.delete(token);
    if (this.now() - entry.ts > this.ttlMs) return null;
    return entry;
  }

  /** Drop expired entries. Called occasionally; not a hot path. */
  gc() {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, entry] of this.entries) {
      if (entry.ts < cutoff) this.entries.delete(token);
    }
  }

  /** Snapshot for tests. */
  size() {
    return this.entries.size;
  }
}
