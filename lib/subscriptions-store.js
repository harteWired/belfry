/**
 * Live, persisted subscription overrides (#40 — /watch from Telegram).
 *
 * Watch state (which slugs get proactive ready/error/waiting pings) normally
 * lives in the hand-edited ~/.claude/belfry.jsonc `subscriptions` block, read
 * once at boot. That makes toggling a project's watch state from the phone
 * impossible (edit file + restart). This store layers a machine-managed
 * overrides file ON TOP of the loaded config so /watch can:
 *   - apply changes LIVE — it mutates the same `subscriptions` object the
 *     daemon's shouldFire/isSubscribed read, so pings start/stop immediately;
 *   - PERSIST them — without rewriting the user's commented JSONC. The overrides
 *     file (~/.claude/belfry-subscriptions.json) is the only thing this writes.
 *
 * Override file shape: { "<slug>": { "events": ["ready","error"] } | false }
 *   - { events } → watch the slug with those events (adds/replaces a sub)
 *   - false      → explicitly UNwatch (overrides a jsonc subscription off)
 * Applied over the live subscriptions object at construction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { VALID_EVENTS } from './config.js';

export const DEFAULT_OVERRIDES_PATH = path.join(os.homedir(), '.claude', 'belfry-subscriptions.json');
/** Toggling a project ON watches the two events worth a proactive ping. */
export const DEFAULT_WATCH_EVENTS = ['ready', 'error'];

export class SubscriptionsStore {
  /**
   * @param {object}  opts
   * @param {object}  opts.subscriptions  the LIVE config.subscriptions object — mutated in place
   * @param {string}  [opts.persistPath]
   * @param {Function} [opts.log]
   */
  constructor({ subscriptions, persistPath = DEFAULT_OVERRIDES_PATH, log = () => {} } = {}) {
    this.subscriptions = subscriptions && typeof subscriptions === 'object' ? subscriptions : {};
    this.persistPath = persistPath;
    this.log = log;
    /** @type {Record<string, {events:string[]} | false>} */
    this.overrides = {};
    this.load();
  }

  /** Read the overrides file and apply each over the live subscriptions object. */
  load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`subscription overrides unreadable (${err.message}) — ignoring`);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    let applied = 0;
    for (const [slug, val] of Object.entries(parsed)) {
      if (val === false) {
        this.overrides[slug] = false;
        delete this.subscriptions[slug];
        applied++;
      } else if (val && Array.isArray(val.events)) {
        const events = sanitizeEvents(val.events);
        if (events.length === 0) continue;
        this.overrides[slug] = { events };
        this.subscriptions[slug] = mergeSub(this.subscriptions[slug], events);
        applied++;
      }
    }
    if (applied) this.log(`subscriptions: applied ${applied} override(s) from ${this.persistPath}`);
  }

  isWatched(slug) {
    return Boolean(this.subscriptions[slug]);
  }

  /** Watch `slug` with `events` (default ready+error). Live + persisted. */
  watch(slug, events = DEFAULT_WATCH_EVENTS) {
    const ev = sanitizeEvents(events);
    const use = ev.length ? ev : DEFAULT_WATCH_EVENTS;
    this.subscriptions[slug] = mergeSub(this.subscriptions[slug], use);
    this.overrides[slug] = { events: use };
    this.persist();
    return this.subscriptions[slug];
  }

  /** Unwatch `slug`. Live + persisted (records an explicit-off override so a
   *  jsonc-configured subscription stays off across restarts). */
  unwatch(slug) {
    delete this.subscriptions[slug];
    this.overrides[slug] = false;
    this.persist();
  }

  /** Flip watch state. Returns the NEW state (true = now watched). */
  toggle(slug, events = DEFAULT_WATCH_EVENTS) {
    if (this.isWatched(slug)) {
      this.unwatch(slug);
      return false;
    }
    this.watch(slug, events);
    return true;
  }

  /** Sorted list of currently-watched slugs. */
  list() {
    return Object.keys(this.subscriptions).filter((s) => this.subscriptions[s]).sort();
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.overrides, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log(`subscriptions: persist failed (${err.message})`);
    }
  }
}

function sanitizeEvents(events) {
  if (!Array.isArray(events)) return [];
  return [...new Set(events.map((e) => String(e).toLowerCase().trim()).filter((e) => VALID_EVENTS.has(e)))];
}

/** Build a subscription record, preserving any existing summarize/digest/topic. */
function mergeSub(existing, events) {
  return {
    events,
    summarize: existing?.summarize === true,
    digest: existing?.digest === true,
    topic: typeof existing?.topic === 'number' ? existing.topic : null,
  };
}
