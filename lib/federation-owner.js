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
    now = () => Date.now(),
  } = {}) {
    this.standbyIntervalMs = standbyIntervalMs;
    this.errorBackoffMs = errorBackoffMs;
    this.jitter = jitter;
    this.rand = rand;
    this.now = now;
    this.role = ROLE_UNKNOWN;
    /**
     * Timestamp of the last poll that *reached Telegram* — an `ok` (we own it)
     * OR a `conflict`/409 (someone else owns it, but we proved we can talk to
     * the getUpdates endpoint). Federation advertises this as `reachableAt` so a
     * lower-priority standby can tell "the primary is reachable and ready"
     * (yield to it on recovery — handback) from "the primary is up on the mesh
     * but can't reach Telegram" (take over — the Daedalus-egress-dead case).
     *
     * It is advanced ONLY by a real poll round-trip (`record`), never by the
     * local `preempt()` decision — choosing not to poll proves nothing about
     * reachability. 0 = never reached Telegram (initial / sustained errors).
     */
    this.reachableAt = 0;
  }

  isOwner() {
    return this.role === ROLE_OWNER;
  }

  /**
   * Record a real poll outcome and get the next move.
   * @param {'ok'|'conflict'|'error'} result
   *   ok       → getUpdates succeeded: we own the bot; poll again immediately.
   *              Advances reachableAt.
   *   conflict → 409: another node owns it; stand by and retry after the
   *              standby interval (so we take over if it later dies). Advances
   *              reachableAt — a 409 still proves we reached Telegram.
   *   error    → network/other failure: don't claim ownership, and do NOT
   *              advance reachableAt (we never reached Telegram). If we were the
   *              owner, demote to unknown (our long-poll may have dropped) and
   *              retry soon to re-establish; otherwise keep the prior role.
   * @returns {{ role: string, waitMs: number, changed: boolean }}
   */
  record(result) {
    const prev = this.role;
    let waitMs;
    if (result === 'ok') {
      this.role = ROLE_OWNER;
      this.reachableAt = this.now();
      waitMs = 0;
    } else if (result === 'conflict') {
      this.role = ROLE_STANDBY;
      this.reachableAt = this.now();
      waitMs = this._jittered(this.standbyIntervalMs);
    } else {
      this.role = prev === ROLE_OWNER ? ROLE_UNKNOWN : prev;
      waitMs = this._jittered(this.errorBackoffMs);
    }
    return { role: this.role, waitMs, changed: this.role !== prev };
  }

  /**
   * Stand down because a higher-priority host owns (or is ready to own) the bot
   * — a purely LOCAL decision made by the priority gate before any poll. Unlike
   * a 409 `record('conflict')`, this involves no Telegram round-trip, so it must
   * NOT touch `reachableAt`: a preempted standby that isn't polling has not
   * proven it can reach Telegram and must not advertise that it can.
   * @returns {{ role: string, waitMs: number, changed: boolean }}
   */
  preempt() {
    const prev = this.role;
    this.role = ROLE_STANDBY;
    return { role: this.role, waitMs: this._jittered(this.standbyIntervalMs), changed: this.role !== prev };
  }

  _jittered(base) {
    return Math.round(base * (1 + this.jitter * this.rand()));
  }
}
