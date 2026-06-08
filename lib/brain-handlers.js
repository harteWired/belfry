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
  // (messageId, outcome) → void. Upgrades the originating message's routing-
  // status reaction after the brain resolves a slug the deterministic router
  // couldn't (#34). null when reactions are off. Fire-and-forget by contract.
  reactRouting = null,
  log = () => {},
}) {
  // Some daemon-side deps (watcher specifically) get constructed AFTER
  // makeBrainHandlers is called — bin/belfry.js builds the registry early
  // so the brain MCP plugin can connect, but the watcher needs other
  // pieces that are built later. Resolve watcher fresh each call.
  const w = () => (typeof getWatcher === 'function' ? getWatcher() : watcher);
  // Turn-scoped flag: set to true whenever an action tool (deliver / reply
  // / decline) fires. agent-handler clears it before calling brain.send
  // and checks it after, to suppress the text-fallback when the brain
  // already produced a user-visible action via a tool. Without this gate
  // the brain occasionally emits text alongside a tool call, surfacing
  // two replies for one user message (the 2026-05-11 duplicate-reply bug).
  let actionFired = false;
  return {
    /** Reset the turn-scoped action-fired flag. agent-handler calls this
     *  immediately before brain.send() so the post-turn check is fresh. */
    resetActionFlag() {
      actionFired = false;
    },
    /** True if any action tool fired since the last resetActionFlag(). */
    didActionFire() {
      return actionFired;
    },
    /** Read: list sessions with reachability + last-outbound metadata. */
    listSessions() {
      const cur = w();
      // Source the set from the REGISTRY (sessions with a live belfry-mcp spoke
      // that can actually receive messages) UNIONed with the dashboard cache.
      // Registry alone would miss spoke-less status-only sessions; the cache
      // alone is both incomplete (chokidar 4 skips idle files at startup — see
      // watcher.seedCache) and polluted with stale/non-session files. The union
      // hides nothing, and the `reachable` flag lets the model distinguish a
      // messageable session from a merely-observed one.
      const reachable = typeof registry?.knownSlugs === 'function' ? registry.knownSlugs() : new Set();
      const observed = cur && typeof cur.getActiveSlugsFromCache === 'function'
        ? cur.getActiveSlugsFromCache()
        : new Set();
      const slugs = new Set([...reachable, ...observed]);
      return [...slugs].sort().map((slug) => {
        const last = recentMessages?.recent?.(slug, 1)?.[0];
        return {
          slug,
          reachable: reachable.has(slug),
          status: cur?.lastSeen?.get?.(slug)?.status ?? null,
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
      const observed = cur?.getActiveSlugsFromCache?.() ?? new Set();
      const reachable = typeof registry?.knownSlugs === 'function' ? registry.knownSlugs() : new Set();
      // A slug is valid if it's a live spoke (reachable) OR observed via the
      // dashboard — matching what listSessions surfaces. Reject only truly
      // unknown slugs.
      if (!observed.has(slug) && !reachable.has(slug)) {
        return { error: `no active session named '${slug}'` };
      }
      try {
        // Prefer the watcher's in-memory cache (lastSeen), now seeded at startup
        // so idle sessions are present. A reachable spoke with no dashboard file
        // has no cached status — report that explicitly rather than erroring, so
        // the caller knows the session exists but isn't writing the convention.
        const cached = cur?.lastSeen?.get?.(slug);
        if (cached) return cached;
        return { slug, reachable: reachable.has(slug), error: `no dashboard status for '${slug}'` };
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
      const originating =
        typeof reply_to_message_id === 'number' && reply_to_message_id > 0 ? reply_to_message_id : null;
      const fanout = registry.deliver(slug, body, originating, null);
      actionFired = true;
      log(`brain deliver → ${slug} (${fanout} instance(s), ${body.length} chars)`);
      // #34: the deterministic router already reacted 🤔 (unmatched) before
      // handing this message to the brain. Now that the brain has resolved a
      // slug, upgrade the originating message's reaction to reflect the full
      // pipeline outcome — 👀 (delivered) when a live session got it, 🤷
      // (dropped) when the slug resolved but nothing is registered. The 👀→🫡
      // reply-swap in sendOutbound then fires naturally when the session
      // answers (registry.deliver set the owes-reply marker on `originating`).
      // Fire-and-forget, same as the poller's reactToRouting.
      if (originating) reactRouting?.(originating, fanout > 0 ? 'delivered' : 'dropped');
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
      actionFired = true;
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
      actionFired = true;
      log(`brain decline (${trimmed.length} chars)`);
      return { sent: true, message_id: result?.message_id ?? null };
    },
  };
}
