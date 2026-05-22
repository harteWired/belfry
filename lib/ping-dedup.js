/**
 * Per-slug dedup for ready pings, keyed on `last_response_at`.
 *
 * Suppresses repeat pings when the dashboard's assistant response hasn't
 * advanced since the last time we pinged this slug — observed 2026-05-22
 * where /loop watchdog turns (pure-tool, no assistant text) repeatedly
 * triggered identical Telegram pings carrying stale prior-turn text.
 *
 * Only used for ready transitions. error and waiting always fire — they
 * are rare and represent state the user must see regardless of whether
 * the message body changed.
 *
 * Stateful (a Map), so the caller holds an instance for the lifetime of
 * the daemon. Restart resets the dedup; first ping after a restart
 * always fires, which is desirable (it confirms belfry is back).
 */
export class PingDedup {
  constructor() {
    this.lastBySlug = new Map();
  }

  /**
   * Returns true if this ping should be skipped. Updates internal state
   * to record that this slug has now been pinged at `lastResponseAt`.
   *
   * @param {string} slug
   * @param {unknown} lastResponseAt — the dashboard JSON's last_response_at,
   *   typically a Unix-seconds number. If not a finite number we don't
   *   dedup (we can't compare what we don't have).
   * @returns {boolean}
   */
  shouldSkip(slug, lastResponseAt) {
    if (typeof lastResponseAt !== 'number' || !Number.isFinite(lastResponseAt)) {
      return false;
    }
    if (this.lastBySlug.get(slug) === lastResponseAt) return true;
    this.lastBySlug.set(slug, lastResponseAt);
    return false;
  }
}
