/**
 * In-memory LRU mapping outbound Telegram message_id → slug, optionally
 * persisted to disk so quote-replies survive daemon restarts.
 *
 * Populated when belfry sends a message to Telegram, consulted when an
 * inbound reply quotes one. Capped to prevent unbounded growth in
 * long-lived daemon runs.
 *
 * Persistence is best-effort and synchronous (a JSON file rewritten on
 * every record). The file is small (one entry ≈ 30 bytes; default cap
 * is 500) and writes are paced by outbound Telegram sends, so cost is
 * negligible. Load failures and write failures are logged and ignored —
 * the worst case degrades to the prior in-memory-only behaviour.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_CAPACITY = 500;

export class ReplyTracker {
  constructor({ capacity = DEFAULT_CAPACITY, persistPath = null, log = () => {} } = {}) {
    this.capacity = capacity;
    this.persistPath = persistPath;
    this.log = log;
    /** Map iteration order is insertion order — used for LRU eviction. */
    this.map = new Map();
    this.dirEnsured = false;
    if (persistPath) this.#load();
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
    this.#save();
  }

  lookup(messageId) {
    if (typeof messageId !== 'number') return null;
    return this.map.get(messageId) ?? null;
  }

  size() {
    return this.map.size;
  }

  #load() {
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'number' &&
          typeof entry[1] === 'string' &&
          entry[1].length > 0
        ) {
          this.map.set(entry[0], entry[1]);
        }
      }
      // Enforce capacity in case the persisted file was written by a build
      // with a higher cap than this one.
      while (this.map.size > this.capacity) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
      this.log(`reply-tracker: loaded ${this.map.size} entries from ${this.persistPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log(`reply-tracker: load failed (${err.message}) — starting empty`);
      }
    }
  }

  #save() {
    if (!this.persistPath) return;
    try {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
        this.dirEnsured = true;
      }
      const tmp = `${this.persistPath}.tmp`;
      // 0600: file holds slug names (project identifiers) — restrict to owner.
      writeFileSync(tmp, JSON.stringify([...this.map]), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (err) {
      this.log(`reply-tracker: save failed: ${err.message}`);
    }
  }
}
