/**
 * Per-slug inbox for inbound Telegram messages.
 *
 * Two queues per slug:
 *
 *   continuation — messages that should be fed to Claude as the next prompt
 *                  at the next Stop boundary. Drained by the Stop hook.
 *   interrupt    — messages that should cancel Claude's current direction
 *                  at the next PreToolUse boundary. Drained by the
 *                  PreToolUse hook (Phase 2).
 *
 * Drain semantics: returns all queued messages joined by a blank line and
 * clears the queue. Multiple replies arriving for one slug between drains
 * are treated as one thought sent in pieces.
 *
 * In-memory only — daemon restart loses pending content. Acceptable for
 * single-user single-host design.
 */

const VALID_QUEUES = new Set(['continuation', 'interrupt']);

export class Inbox {
  constructor() {
    /** slug → { continuation: string[], interrupt: string[] } */
    this.queues = new Map();
  }

  push(slug, queue, text) {
    if (!VALID_QUEUES.has(queue)) {
      throw new Error(`unknown queue: ${queue}`);
    }
    if (typeof text !== 'string' || text.length === 0) return;
    let entry = this.queues.get(slug);
    if (!entry) {
      entry = { continuation: [], interrupt: [] };
      this.queues.set(slug, entry);
    }
    entry[queue].push(text);
  }

  /**
   * Destructive read. Returns the joined queue contents and clears it.
   * Returns null if the queue is empty.
   */
  drain(slug, queue) {
    if (!VALID_QUEUES.has(queue)) {
      throw new Error(`unknown queue: ${queue}`);
    }
    const entry = this.queues.get(slug);
    if (!entry || entry[queue].length === 0) return null;
    const text = entry[queue].join('\n\n');
    entry[queue] = [];
    return text;
  }

  /**
   * Non-destructive read for cheap short-circuit checks. Returns the joined
   * queue contents without clearing.
   */
  peek(slug, queue) {
    if (!VALID_QUEUES.has(queue)) {
      throw new Error(`unknown queue: ${queue}`);
    }
    const entry = this.queues.get(slug);
    if (!entry || entry[queue].length === 0) return null;
    return entry[queue].join('\n\n');
  }
}
