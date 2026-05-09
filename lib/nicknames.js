/**
 * Project nicknames: many-to-one nickname → slug map managed from Telegram.
 *
 * Storage: ~/.local/state/belfry/nicknames.json (0600), alongside the registry
 * token and reply-tracker. Persisted file is authoritative; belfry.jsonc's
 * `nicknames` block is a bootstrap default applied only for entries the
 * persisted file doesn't already cover (so Telegram-side edits never get
 * overwritten by a re-read of the config).
 *
 * Validation in set():
 *   - Nickname shape: [a-z0-9][a-z0-9-]{0,31}. Lowercase enforced.
 *   - Reserved commands (status, nick, unnick, nicks) — those are router
 *     prefix tokens and cannot double as a nickname.
 *   - Slug must currently exist in the dashboard (caller injects
 *     getActiveSlugs). Avoids dangling nicks pointing at nothing.
 *   - Nickname cannot equal an active slug (slug always wins on the prefix
 *     path; the nickname would never resolve).
 *
 * Returns `{ ok, reason }` from mutators so the Telegram handler can echo a
 * concrete error back to the user instead of failing silently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const NICK_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED = new Set(['status', 'nick', 'unnick', 'nicks']);

export class NicknameRegistry {
  constructor({ persistPath, getActiveSlugs = () => new Set(), log = () => {} } = {}) {
    this.persistPath = persistPath;
    this.getActiveSlugs = getActiveSlugs;
    this.log = log;
    this.map = new Map(); // nickname (lowercased) → slug
  }

  /** Load persisted state. Idempotent. Missing file is fine. */
  load() {
    if (!this.persistPath) return;
    let raw;
    try {
      raw = fs.readFileSync(this.persistPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`nicknames read failed: ${err.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log(`nicknames parse failed: ${err.message} — ignoring file`);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [nick, slug] of Object.entries(parsed)) {
      if (typeof slug !== 'string' || slug.length === 0) continue;
      const lower = String(nick).toLowerCase();
      if (!NICK_RE.test(lower)) continue;
      this.map.set(lower, slug);
    }
  }

  /**
   * Merge bootstrap defaults from config. Only applies entries the persisted
   * file doesn't already cover. Persisted writes after this call.
   */
  bootstrap(defaults) {
    if (!defaults || typeof defaults !== 'object') return;
    let added = 0;
    let skipped = 0;
    for (const [nick, slug] of Object.entries(defaults)) {
      if (typeof slug !== 'string' || slug.length === 0) {
        skipped++;
        continue;
      }
      const lower = String(nick).toLowerCase();
      if (!NICK_RE.test(lower)) {
        this.log(`nicknames bootstrap: skipped invalid nickname '${nick}'`);
        skipped++;
        continue;
      }
      if (this.map.has(lower)) continue; // persisted entry wins, no log
      if (RESERVED.has(lower)) {
        this.log(`nicknames bootstrap: skipped reserved nickname '${lower}'`);
        skipped++;
        continue;
      }
      this.map.set(lower, slug);
      added++;
    }
    if (added > 0) this.persist();
    if (added > 0 || skipped > 0) {
      this.log(`nicknames bootstrap: ${added} applied, ${skipped} skipped`);
    }
  }

  /** Case-insensitive lookup. Returns slug or null. */
  resolve(token) {
    if (typeof token !== 'string') return null;
    return this.map.get(token.toLowerCase()) ?? null;
  }

  /**
   * Add or update. Returns `{ ok: true }` on success, `{ ok: false, reason }`
   * with a human-readable explanation on rejection.
   */
  set(nickname, slug) {
    if (typeof nickname !== 'string' || typeof slug !== 'string') {
      return { ok: false, reason: 'usage: /nick <nickname> <slug>' };
    }
    const lower = nickname.toLowerCase();
    if (!NICK_RE.test(lower)) {
      return { ok: false, reason: `invalid nickname '${nickname}'. Allowed: [a-z0-9][a-z0-9-]{0,31}.` };
    }
    if (RESERVED.has(lower)) {
      return { ok: false, reason: `'${lower}' is reserved (router command).` };
    }
    const active = this.getActiveSlugs();
    if (!active.has(slug)) {
      const list = [...active].sort().join(', ');
      return { ok: false, reason: `no active session named '${slug}'. Active: ${list || '(none)'}.` };
    }
    if (active.has(lower) && lower !== slug) {
      return { ok: false, reason: `nickname '${lower}' collides with active slug — slugs always win on routing, so this nickname would never resolve.` };
    }
    this.map.set(lower, slug);
    this.persist();
    return { ok: true };
  }

  /** Remove. Returns true if the entry existed. */
  unset(nickname) {
    if (typeof nickname !== 'string') return false;
    const lower = nickname.toLowerCase();
    const had = this.map.delete(lower);
    if (had) this.persist();
    return had;
  }

  /** Snapshot of all entries as `{ nickname: slug }`. */
  list() {
    return Object.fromEntries(this.map);
  }

  /** Nicknames pointing at a given slug. Sorted for stable output. */
  reverseLookup(slug) {
    const out = [];
    for (const [nick, target] of this.map) {
      if (target === slug) out.push(nick);
    }
    return out.sort();
  }

  /**
   * Sync write. Volume is low (one write per management command, not per
   * Telegram update), so no debounce — keeps the on-disk state authoritative
   * after every change.
   */
  persist() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true, mode: 0o700 });
      const json = JSON.stringify(Object.fromEntries(this.map), null, 2);
      fs.writeFileSync(this.persistPath, json, { mode: 0o600 });
    } catch (err) {
      this.log(`nicknames write failed: ${err.message}`);
    }
  }
}
