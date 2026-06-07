/**
 * SendQueue — a single serial pacer for every outbound Telegram write (#35).
 *
 * Why this exists: belfry sends to ONE chat. Telegram's per-chat limit is ~1
 * message/second for private chats and — since the Feb 2025 layer-167 change —
 * ~1 message per 3 seconds (20/min) for groups and supergroups, with a 429 +
 * `retry_after` when you exceed it. A `/all` broadcast is loopback (no Telegram
 * traffic), but the N sessions it wakes all reply within a second or two, and
 * each reply, each 👀→🫡 reaction swap, each ready ping, and the broadcast
 * confirmation is a separate write to the same chat. Fired concurrently they
 * blow straight past the limit and 429 — which, before this queue, just threw
 * and dropped the message.
 *
 * Funnelling every write through one queue turns that burst into a paced
 * stream: tasks run one at a time, no closer together than `minIntervalMs`. On
 * a 429 the queue waits the server-supplied `retry_after` (plus jitter) and
 * retries the SAME task, and it raises an adaptive `floor` to that interval for
 * a cooldown window — so after the first 429 in a burst it self-tunes to the
 * chat's real limit and stops hitting it, then relaxes back to the base
 * interval once the chat goes quiet. No message is dropped for a transient
 * rate-limit; the only cost is latency, which is exactly what the limit demands.
 *
 * Timers and the clock are injectable (`sleep`/`now`/`rand`) so tests drive
 * pacing deterministically without real wall-clock waits.
 */

export const DEFAULT_SEND_INTERVAL_MS = 1100;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_JITTER = 0.1;

export class SendQueue {
  constructor({
    minIntervalMs = DEFAULT_SEND_INTERVAL_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    jitter = DEFAULT_JITTER,
    log = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    rand = () => Math.random(),
  } = {}) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.maxRetries = Math.max(0, maxRetries);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.jitter = Math.max(0, jitter);
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.rand = rand;
    this.queue = [];
    this.draining = false;
    this.lastSentAt = 0; // now()-stamp of the most recent send attempt
    this.floorMs = 0; // adaptive interval floor learned from a 429 retry_after
    this.floorUntil = 0; // now()-stamp the floor applies until
  }

  /** Number of tasks waiting (excludes the one currently in flight). */
  get size() {
    return this.queue.length;
  }

  /**
   * Enqueue an async task (a thunk that performs one Telegram write). Returns a
   * promise that resolves with the task's result, or rejects with its error —
   * the caller's `await sendMessage(...)` / `.catch(...)` behave exactly as they
   * did before the queue existed, just paced.
   */
  enqueue(taskFn, { label = '' } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, label, resolve, reject });
      this._drain();
    });
  }

  /** The interval to honour right now: base, or the adaptive floor if active. */
  _effectiveInterval() {
    if (this.floorMs > 0 && this.now() < this.floorUntil) {
      return Math.max(this.minIntervalMs, this.floorMs);
    }
    return this.minIntervalMs;
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        await this._pace();
        await this._run(item);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Wait until at least `_effectiveInterval()` has passed since the last send. */
  async _pace() {
    const interval = this._effectiveInterval();
    if (interval <= 0) return;
    const wait = this.lastSentAt + interval - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  async _run(item) {
    let attempt = 0;
    while (true) {
      this.lastSentAt = this.now();
      try {
        item.resolve(await item.taskFn());
        return;
      } catch (err) {
        const retryAfter = err && err.status === 429 ? Number(err.retryAfter) : NaN;
        if (Number.isFinite(retryAfter) && attempt < this.maxRetries) {
          attempt += 1;
          const base = Math.max(1, retryAfter) * 1000;
          const waitMs = Math.round(base * (1 + this.jitter * this.rand()));
          // Raise the adaptive floor so the rest of this burst paces at the
          // chat's real limit instead of repeatedly tripping it.
          this.floorMs = base;
          this.floorUntil = this.now() + this.cooldownMs;
          this.log(
            `send-queue: 429 on ${item.label || 'send'} — waiting ${waitMs}ms ` +
              `(retry ${attempt}/${this.maxRetries}); pacing floor → ${base}ms for ${this.cooldownMs}ms`,
          );
          await this.sleep(waitMs);
          continue; // retry the same task
        }
        item.reject(err);
        return;
      }
    }
  }
}
