/**
 * Daemon-side handlers for the brain MCP's HTTP endpoints. The brain
 * subprocess (a long-running claude --resume) calls into bin/belfry-brain-mcp.js
 * which proxies to these handlers via /brain/*.
 *
 * Pure factory: bin/belfry.js wires every dependency (registry, watcher,
 * nicknames, recent-messages, telegram sender, help-text getter), and this
 * module returns one function per tool. The Registry mounts them when the
 * daemon supplies a `brainHandlers` constructor option.
 *
 * Each handler returns a JSON-serializable value. Errors throw — caller
 * (Registry.handleBrain) maps to HTTP 4xx/5xx with a short error body.
 */

import { getHelpText } from './help-text.js';

const MAX_TEXT_OUT = 4096; // Telegram cap; reuse here so brain can't ask us to send oversize bodies

export function makeBrainHandlers({
  watcher,
  getWatcher,
  recentMessages,
  nicknames,
  registry,
  sendTelegram,
  log = () => {},
}) {
  // Some daemon-side deps (watcher specifically) get constructed AFTER
  // makeBrainHandlers is called — bin/belfry.js builds the registry early
  // so the brain MCP plugin can connect, but the watcher needs other
  // pieces that are built later. Resolve watcher fresh each call.
  const w = () => (typeof getWatcher === 'function' ? getWatcher() : watcher);
  return {
    /** Read: list active sessions with last-outbound metadata. */
    listSessions() {
      const cur = w();
      const slugs = cur && typeof cur.getActiveSlugsFromCache === 'function'
        ? [...cur.getActiveSlugsFromCache()]
        : [];
      return slugs.map((slug) => {
        const last = recentMessages?.recent?.(slug, 1)?.[0];
        return {
          slug,
          last_outbound_ts: last?.ts ?? null,
          last_outbound_kind: last?.kind ?? null,
        };
      });
    },

    /** Read: full status JSON for one slug. Reads disk via watcher's helpers. */
    getSession({ slug }) {
      if (typeof slug !== 'string' || slug.length === 0) {
        throw new Error('slug required');
      }
      const cur = w();
      const active = cur?.getActiveSlugsFromCache?.() ?? new Set();
      if (!active.has(slug)) return { error: `no active session named '${slug}'` };
      try {
        // Read from the watcher's in-memory cache (lastSeen). chokidar
        // populates this on every status JSON write so the value is
        // current within one event-loop tick of disk truth in the steady
        // state. We don't disk-read on miss — if the slug is in
        // active-set but lastSeen has no entry, return an explicit "no
        // cached status" error so the caller can fall back / retry.
        const cached = cur?.lastSeen?.get?.(slug);
        if (cached) return cached;
        return { error: `no cached status for '${slug}'` };
      } catch (err) {
        return { error: err.message };
      }
    },

    /** Read: recent outbound messages for a slug, newest first. */
    recentMessages({ slug, n }) {
      if (typeof slug !== 'string' || slug.length === 0) {
        throw new Error('slug required');
      }
      const cap = typeof n === 'number' ? n : 10;
      return recentMessages?.recent?.(slug, cap) ?? [];
    },

    /** Read: nickname → slug map. */
    nicknames() {
      return nicknames?.list?.() ?? {};
    },

    /** Read: canonical help text by topic. */
    help({ topic }) {
      if (typeof topic !== 'string') throw new Error('topic required');
      const out = getHelpText(topic);
      if (out === null) return { error: `unknown help topic '${topic}'` };
      return { text: out };
    },

    /** Action: forward body into a session as user input. */
    deliver({ slug, body, reply_to_message_id }) {
      if (typeof slug !== 'string' || slug.length === 0) throw new Error('slug required');
      if (typeof body !== 'string' || body.length === 0) throw new Error('body required');
      const fanout = registry.deliver(
        slug,
        body,
        typeof reply_to_message_id === 'number' && reply_to_message_id > 0 ? reply_to_message_id : null,
        null,
      );
      log(`brain deliver → ${slug} (${fanout} instance(s), ${body.length} chars)`);
      return { fanout };
    },

    /** Action: send a Telegram message (optionally a quote-reply). */
    async reply({ text, reply_to_message_id }) {
      if (typeof text !== 'string' || text.length === 0) throw new Error('text required');
      const trimmed = text.length > MAX_TEXT_OUT ? text.slice(0, MAX_TEXT_OUT - 1) + '…' : text;
      const result = await sendTelegram({
        text: trimmed,
        replyToMessageId:
          typeof reply_to_message_id === 'number' && reply_to_message_id > 0 ? reply_to_message_id : undefined,
      });
      log(`brain reply (${trimmed.length} chars, msg ${result?.message_id})`);
      return { message_id: result?.message_id ?? null };
    },

    /** Action: polite decline, posted to Telegram. */
    async decline({ message, reply_to_message_id }) {
      if (typeof message !== 'string' || message.length === 0) throw new Error('message required');
      const trimmed = message.length > MAX_TEXT_OUT ? message.slice(0, MAX_TEXT_OUT - 1) + '…' : message;
      const result = await sendTelegram({
        text: trimmed,
        replyToMessageId:
          typeof reply_to_message_id === 'number' && reply_to_message_id > 0 ? reply_to_message_id : undefined,
      });
      log(`brain decline (${trimmed.length} chars)`);
      return { sent: true, message_id: result?.message_id ?? null };
    },
  };
}
