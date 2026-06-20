/**
 * Route a Telegram update to either a delivery (session injection) or an
 * action (e.g. /status request, nickname management).
 *
 * Returns one of:
 *   - `{ action: 'deliver', slug, text, messageId }` — feed text into a session
 *   - `{ action: 'status', slug?, messageId }` — render a status digest
 *   - `{ action: 'nick-set', nickname, slug, messageId }`
 *   - `{ action: 'nick-unset', nickname, messageId }`
 *   - `{ action: 'nick-list', messageId }`
 *   - `{ action: 'help', topic?, messageId }` — show reference text for one topic
 *   - `{ action: 'full-expand', targetMessageId, messageId }` — user quote-replied
 *      "full" on a message that the daemon packed to fit Telegram's cap; resend
 *      the original chunked into multiple messages.
 *   - `{ action: 'unmatched', text, messageId }` — fell through all routes; the
 *      conversational agent (#13) handles this if wired, otherwise dropped.
 *   - `null` — chat-id mismatch, empty text, or absent message — drop silently
 *
 * Order:
 *   1. Filter by chat.id == expectedChatId.
 *   2. Require message.text to be a non-empty string.
 *   3. Reserved commands (status, nick, unnick, nicks, help — slash optional)
 *      take precedence over the prefix path.
 *   4. Quote-reply path: reply_to_message.message_id in reply tracker → deliver.
 *   5. Prefix path: /<token> body where token is either a known slug or a
 *      registered nickname. Slugs always win on collision; nicknames are a
 *      second-pass fallback so a slug literally named the same as a nickname
 *      still routes to itself.
 *   6. Unmatched: hand to the conversational agent if the caller wants it.
 *      Without an agent wired, the daemon drops these.
 */

// Slug shape mirrors PREFIX_RE: must start with an alphanumeric, then allow
// dashes/dots/underscores (slug.js can produce any of these via cwd basename).
// /status accepts either a slug or a nickname token in the optional argument.
//
// Reserved-command regexes accept an optional leading slash. Phone keyboards
// make the slash a tap-and-hold detour, so "status" / "nicks" / "help" work
// the same as "/status" / "/nicks" / "/help". Ambiguous-with-conversation
// shapes (the two-arg "nick a b" set) keep their tight arg-count requirement
// so "nick the variable was renamed" doesn't accidentally trigger a set.
const STATUS_RE = /^\/?status(?:\s+([a-z0-9][a-z0-9._-]*))?\s*$/i;
// The prefix token is a bare slug/nickname or a host-qualified federation
// address (`<letter>/<slug>`, #44) — so `/erebus-master hi` (bare remote name,
// resolved via the gossip map) and `/e/erebus-master hi` (explicit) both parse.
const PREFIX_RE = /^\/((?:[a-z0-9]\/)?[a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;
// The target may be a local slug or a host-qualified federation address
// (`<letter>/<slug>`, #44) so `/nick keeper e/erebus-master` parses.
const NICK_SET_RE = /^\/?nick\s+([a-z0-9][a-z0-9-]{0,31})\s+((?:[a-z0-9]\/)?[a-z0-9][a-z0-9._-]*)\s*$/i;
const UNNICK_RE = /^\/?unnick\s+([a-z0-9][a-z0-9-]{0,31})\s*$/i;
const NICKS_LIST_RE = /^\/?nicks\s*$/i;
const HELP_RE = /^\/?help(?:\s+([a-z0-9][a-z0-9-]*))?\s*$/i;
// /resume — three shapes: bare, with slug-or-nick, and with slug + uuid prefix.
const RESUME_RE = /^\/?resume(?:\s+([a-z0-9][a-z0-9._-]+)(?:\s+([a-f0-9]{4,}))?)?\s*$/i;
// /all <body> — broadcast to every registered session. The leading slash is
// REQUIRED (bare "all" is far too common in natural language — "all done",
// "all good" — to safely treat as a command). Captures the body to fan out.
const ALL_RE = /^\/all(?:\s+([\s\S]*))?$/i;
// /watch — manage proactive-ping subscriptions from Telegram (#40). Bare
// `/watch` opens the toggle menu; `/watch <slug> [events]` watches; `/unwatch
// <slug>` unwatches; `/watching` lists. Slash optional (phone keyboards).
const WATCH_RE = /^\/?watch(?:\s+([a-z0-9][a-z0-9._-]*)(?:\s+([a-z0-9 ,]+))?)?\s*$/i;
const UNWATCH_RE = /^\/?unwatch\s+([a-z0-9][a-z0-9._-]*)\s*$/i;
const WATCHING_RE = /^\/?watching\s*$/i;

// Reserved tokens that must never be routed to a session via the prefix
// path, even if a slug literally matches one. Without this guard, a
// malformed `/nick foo` (missing slug arg) — which doesn't match
// NICK_SET_RE — would fall through to PREFIX_RE and deliver `foo` to a
// hypothetical session named `nick`. The docstring contract promises that
// can't happen.
const RESERVED_PREFIX_TOKENS = new Set(['status', 'nick', 'unnick', 'nicks', 'help', 'resume', 'all', 'watch', 'unwatch', 'watching']);

/**
 * `hasSlug` is called only on the prefix-path branch — the last branch
 * checked. Most updates (wrong chat, no text, reserved command, quote-reply)
 * return before it's invoked, so callers should pass a cheap accessor (e.g.
 * a Map's `.has` bound) rather than materializing a Set on every route call.
 *
 * `resolveNickname(token) → slug | null` is consulted when `hasSlug` returns
 * false, so a registered nickname can stand in for the slug on the prefix path.
 *
 * `resolveFederated(token) → '<letter>/<slug>' | null` is consulted last, when
 * the token is neither a local slug nor a nickname. It resolves a bare slug
 * against the gossiped federation ownership map, so a session living on a peer
 * host routes by its real name (`erebus-master`), not only its nickname.
 * Returns null when federation is off, the slug is unknown, or it's ambiguous
 * (owned by 2+ hosts) — qualify with `<letter>/<slug>` or a nickname instead.
 *
 * Backwards compat: if `knownSlugs` (a Set) is passed instead of `hasSlug`,
 * we use it the same way. New callers should use `hasSlug`.
 */
// "full" as a single-word body, optionally surrounded by whitespace, with
// an optional leading slash to match phone-keyboard quirks. Case-insensitive.
const FULL_RE = /^\s*\/?full\s*$/i;

export function route({
  update,
  expectedChatId,
  replyTracker,
  hasSlug,
  knownSlugs,
  resolveNickname = () => null,
  resolveFederated = () => null,
  resolveTopic = () => null,
  hasFullStash = () => false,
}) {
  const message = update?.message;
  if (!message) return null;
  if (message.chat?.id !== expectedChatId) return null;
  // Photo messages carry routing instructions in `caption` rather than
  // `text`. Treat caption as text for routing; the attachment itself
  // flows separately via the deliver action's payload.
  const text = (typeof message.text === 'string' && message.text.length > 0)
    ? message.text
    : (typeof message.caption === 'string' ? message.caption : '');
  // Empty text is routable when the user signaled intent another way:
  //   - quote-reply on a belfry message (photo replying to a session)
  //   - the message landed in a topic that's bound to a slug (#15) — the
  //     topic IS the routing decision, regardless of text content
  // For everything else, no text means no route.
  const hasReplyTo = typeof message.reply_to_message?.message_id === 'number';
  const threadId = message.message_thread_id;
  const hasBoundTopic = typeof threadId === 'number' && !!resolveTopic(threadId);
  if (text.length === 0 && !hasReplyTo && !hasBoundTopic) return null;

  const messageId = typeof message.message_id === 'number' ? message.message_id : null;

  // /status [token] — reserved.
  const statusMatch = text.match(STATUS_RE);
  if (statusMatch) {
    const token = statusMatch[1] ? statusMatch[1] : null;
    // Resolve a nickname token to its slug here so the status handler doesn't
    // need to know about nicknames. If nothing resolves, pass the raw token
    // through and let the handler emit "no such session".
    const slug = token
      ? hasSlug && hasSlug(token)
        ? token
        : (resolveNickname(token) ?? token)
      : null;
    return { action: 'status', slug, messageId };
  }

  // /nicks — list reserved.
  if (NICKS_LIST_RE.test(text)) return { action: 'nick-list', messageId };

  // /nick <nickname> <slug>
  const nickSet = text.match(NICK_SET_RE);
  if (nickSet) {
    return { action: 'nick-set', nickname: nickSet[1], slug: nickSet[2], messageId };
  }

  // /unnick <nickname>
  const unNick = text.match(UNNICK_RE);
  if (unNick) return { action: 'nick-unset', nickname: unNick[1], messageId };

  // /help [topic]
  const helpMatch = text.match(HELP_RE);
  if (helpMatch) {
    const topic = helpMatch[1] ? helpMatch[1].toLowerCase() : null;
    return { action: 'help', topic, messageId };
  }

  // /resume [slug [uuid-prefix]]
  const resumeMatch = text.match(RESUME_RE);
  if (resumeMatch) {
    const slug = resumeMatch[1] ?? null;
    const uuid = resumeMatch[2] ?? null;
    return { action: 'resume', slug, uuid, messageId };
  }

  // /watching — list currently-watched. Checked before /watch so the longer
  // word isn't swallowed (it can't be — WATCH_RE requires whitespace after
  // "watch" — but order keeps intent obvious).
  if (WATCHING_RE.test(text)) return { action: 'watch-list', messageId };
  // /unwatch <slug>
  const unwatchM = text.match(UNWATCH_RE);
  if (unwatchM) return { action: 'watch-unset', slug: unwatchM[1].toLowerCase(), messageId };
  // /watch [slug [events]] — bare opens the menu; with a slug, watches.
  const watchM = text.match(WATCH_RE);
  if (watchM) {
    const slug = watchM[1] ? watchM[1].toLowerCase() : null;
    if (!slug) return { action: 'watch-menu', messageId };
    const events = watchM[2]
      ? watchM[2].split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
      : null;
    return { action: 'watch-set', slug, events, messageId };
  }

  // /all <body> — broadcast to every session. Slash-required (see ALL_RE) and
  // only when NOT a quote-reply: a quote means "talk to this one session", so a
  // quoted "/all x" skips broadcast and falls through to the quote-reply path
  // below (delivered as literal text to the quoted slug).
  if (typeof message.reply_to_message?.message_id !== 'number') {
    const allMatch = text.match(ALL_RE);
    if (allMatch) {
      const body = (allMatch[1] ?? '').trim();
      if (body.length > 0) return { action: 'broadcast', text: body, messageId };
      // Bare "/all" with no body → fall through to unmatched (no-op / agent hint).
    }
  }

  // Quote-reply path. Wins over topic routing because the quote is more
  // specific (the user explicitly named a message in the topic).
  const replyToId = message.reply_to_message?.message_id;
  if (typeof replyToId === 'number') {
    // "full" expansion is a special case of quote-reply: the user wants
    // the original (pre-packed) text of the quoted message redelivered as
    // chunks. The trigger is exact: the body must be just "full" (any
    // case) and the daemon must have a stash for the quoted message_id.
    // If the stash is gone (expired), fall through to normal delivery.
    if (FULL_RE.test(text) && hasFullStash(replyToId)) {
      return { action: 'full-expand', targetMessageId: replyToId, messageId };
    }
    const slug = replyTracker.lookup(replyToId);
    if (slug) {
      return { action: 'deliver', slug, text, messageId };
    }
  }

  // Forum-topic path: when message arrives in a topic mapped to a slug,
  // route the whole text in (no body extraction; the topic IS the
  // routing decision). Fires only when there's no quote-reply override
  // and no slug-prefix in the text. Reserved commands above already
  // returned, so a /status sent inside a topic still hits /status, not
  // the topic deliver.
  if (typeof threadId === 'number') {
    const topicSlug = resolveTopic(threadId);
    if (topicSlug) {
      // If the user typed `/<slug> body` inside the topic, prefer the
      // explicit prefix over the topic — they're being addressed-specific.
      // Otherwise fall through to here.
      const prefixMatch = text.match(PREFIX_RE);
      const prefixToken = prefixMatch ? prefixMatch[1].toLowerCase() : null;
      const prefixOverride = prefixToken
        && !RESERVED_PREFIX_TOKENS.has(prefixToken)
        && (hasSlug ? hasSlug(prefixToken) : knownSlugs?.has(prefixToken));
      if (!prefixOverride) {
        return { action: 'deliver', slug: topicSlug, text, messageId };
      }
    }
  }

  // /<slug-or-nickname> prefix path. Slug wins on collision. An empty body
  // (just `/foo` with nothing after) falls through to `unmatched` — the
  // agent can ask the user what they meant; without an agent, drop.
  // Reserved tokens (status, nick, unnick, nicks) skip this branch entirely
  // so a malformed reserved command never accidentally delivers to a session.
  const m = text.match(PREFIX_RE);
  if (m) {
    const token = m[1].toLowerCase();
    const body = (m[2] ?? '').trim();
    if (body.length > 0 && !RESERVED_PREFIX_TOKENS.has(token)) {
      // A host-qualified `<letter>/<slug>` typed directly is an explicit
      // federation address — deliver it as-is; the delivery target relays it.
      if (token.includes('/')) return { action: 'deliver', slug: token, text: body, messageId };
      // Local slug wins over a same-named remote one (checked first).
      const known = hasSlug ? hasSlug(token) : knownSlugs?.has(token);
      if (known) return { action: 'deliver', slug: token, text: body, messageId };
      const aliased = resolveNickname(token);
      if (aliased) return { action: 'deliver', slug: aliased, text: body, messageId };
      // Not local, not a nickname — resolve the bare name against the gossiped
      // federation ownership map so a remote session routes by its real name.
      const federated = resolveFederated(token);
      if (federated) return { action: 'deliver', slug: federated, text: body, messageId };
    }
  }

  // Fell through all known routes. Hand to the conversational agent if wired.
  return { action: 'unmatched', text, messageId };
}
