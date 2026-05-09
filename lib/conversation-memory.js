/**
 * Per-chat short-term conversation buffer for the conversational agent.
 * Belfry is single-user, single-chat — but keying by chat_id keeps the API
 * honest in case that changes, and avoids leaking turns from one chat into
 * another if it ever does.
 *
 * Bounded by both a turn count (recent N round-trips) and an idle window
 * (clear after K minutes of quiet so yesterday's thread doesn't lurk in
 * today's prompt). Non-persistent — a daemon restart wipes everything,
 * which is the right behavior for short-term context.
 */

const DEFAULT_MAX_TURNS = 6; // user + assistant counts as 2 turns
const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_IDLE_MS = 10 * 60_000; // 10 minutes

export class ConversationMemory {
  constructor({
    maxTurns = DEFAULT_MAX_TURNS,
    maxChars = DEFAULT_MAX_CHARS,
    idleMs = DEFAULT_IDLE_MS,
    now = () => Date.now(),
  } = {}) {
    this.maxTurns = maxTurns;
    this.maxChars = maxChars;
    this.idleMs = idleMs;
    this.now = now;
    /** chatId → { turns: Array, lastTs: number } */
    this.byChat = new Map();
  }

  /** Record a turn. Role is 'user' or 'assistant'. */
  push(chatId, { role, text }) {
    if (!chatId || typeof text !== 'string' || text.length === 0) return;
    if (role !== 'user' && role !== 'assistant') return;
    let entry = this.byChat.get(chatId);
    const ts = this.now();
    // GC stale buffer if the chat has been idle.
    if (entry && ts - entry.lastTs > this.idleMs) {
      entry = null;
      this.byChat.delete(chatId);
    }
    if (!entry) {
      entry = { turns: [], lastTs: ts };
      this.byChat.set(chatId, entry);
    }
    entry.turns.push({ role, text, ts });
    entry.lastTs = ts;
    this.trim(entry);
  }

  /** Newest-last list of recent turns for the chat. Honors idle expiry. */
  recent(chatId) {
    const entry = this.byChat.get(chatId);
    if (!entry) return [];
    if (this.now() - entry.lastTs > this.idleMs) {
      this.byChat.delete(chatId);
      return [];
    }
    return entry.turns;
  }

  /** Render recent turns as a context block for the classifier prompt. */
  contextBlock(chatId) {
    const turns = this.recent(chatId);
    if (turns.length === 0) return '';
    const lines = turns.map((t) =>
      t.role === 'user' ? `User: ${t.text}` : `Belfry: ${t.text}`,
    );
    return `Recent context (most recent last):\n${lines.join('\n')}`;
  }

  /** Drop the buffer for a chat (e.g. on explicit reset). */
  clear(chatId) {
    this.byChat.delete(chatId);
  }

  /**
   * Trim to maxTurns and maxChars in newest-first priority. If the newest
   * turn alone exceeds maxChars, truncate its text in place — without this,
   * a single huge pasted message would ship over budget on every subsequent
   * classify call until idle expiry.
   */
  trim(entry) {
    if (entry.turns.length > this.maxTurns) {
      entry.turns.splice(0, entry.turns.length - this.maxTurns);
    }
    let total = entry.turns.reduce((acc, t) => acc + t.text.length, 0);
    while (total > this.maxChars && entry.turns.length > 1) {
      const dropped = entry.turns.shift();
      total -= dropped.text.length;
    }
    // Only one turn left and it's still over budget: truncate the tail end
    // (newest text wins; the front of a long message is usually less
    // informative than the recent context).
    if (entry.turns.length === 1 && entry.turns[0].text.length > this.maxChars) {
      const t = entry.turns[0];
      t.text = t.text.slice(t.text.length - this.maxChars);
    }
  }
}
