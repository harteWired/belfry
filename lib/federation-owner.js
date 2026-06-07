/**
 * Floating Telegram-owner election (#29). Telegram allows only ONE getUpdates
 * poller per bot token — a second concurrent caller gets HTTP 409 Conflict.
 * That constraint IS the election, with no coordinator: every daemon attempts
 * the poll; whoever's getUpdates succeeds owns the bot; the others get 409,
 * stand by, and retry later so they take over within seconds if the owner dies.
 *
 * This is the pure decision core. Feed it poll outcomes; it returns the current
 * role and how long to wait before the next attempt. The actual getUpdates call
 * and the loop that consumes `waitMs` live in the poller. Jitter source is
 * injectable for deterministic tests.
 *
 * Why outbound isn't gated: only getUpdates (inbound polling) is exclusive —
 * sendMessage works from any node — so replies/pings are never blocked by not
 * being the owner. Only the inbound poll cares about this state.
 */

export const ROLE_OWNER = 'owner';
export const ROLE_STANDBY = 'standby';
export const ROLE_UNKNOWN = 'unknown';

export const DEFAULT_STANDBY_INTERVAL_MS = 15_000;
export const DEFAULT_ERROR_BACKOFF_MS = 3_000;

export class TelegramOwner {
  constructor({
    standbyIntervalMs = DEFAULT_STANDBY_INTERVAL_MS,
    errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
    jitter = 0.2,
    rand = Math.random,
  } = {}) {
    this.standbyIntervalMs = standbyIntervalMs;
    this.errorBackoffMs = errorBackoffMs;
    this.jitter = jitter;
    this.rand = rand;
    this.role = ROLE_UNKNOWN;
  }

  isOwner() {
    return this.role === ROLE_OWNER;
  }

  /**
   * Record a poll outcome and get the next move.
   * @param {'ok'|'conflict'|'error'} result
   *   ok       → getUpdates succeeded: we own the bot; poll again immediately.
   *   conflict → 409: another node owns it; stand by and retry after the
   *              standby interval (so we take over if it later dies).
   *   error    → network/other failure: don't claim ownership. If we were the
   *              owner, demote to unknown (our long-poll may have dropped) and
   *              retry soon to re-establish; otherwise keep the prior role.
   * @returns {{ role: string, waitMs: number, changed: boolean }}
   */
  record(result) {
    const prev = this.role;
    let waitMs;
    if (result === 'ok') {
      this.role = ROLE_OWNER;
      waitMs = 0;
    } else if (result === 'conflict') {
      this.role = ROLE_STANDBY;
      waitMs = this._jittered(this.standbyIntervalMs);
    } else {
      this.role = prev === ROLE_OWNER ? ROLE_UNKNOWN : prev;
      waitMs = this._jittered(this.errorBackoffMs);
    }
    return { role: this.role, waitMs, changed: this.role !== prev };
  }

  _jittered(base) {
    return Math.round(base * (1 + this.jitter * this.rand()));
  }
}
