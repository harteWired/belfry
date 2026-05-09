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
const PREFIX_RE = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;
const NICK_SET_RE = /^\/?nick\s+([a-z0-9][a-z0-9-]{0,31})\s+([a-z0-9][a-z0-9._-]*)\s*$/i;
const UNNICK_RE = /^\/?unnick\s+([a-z0-9][a-z0-9-]{0,31})\s*$/i;
const NICKS_LIST_RE = /^\/?nicks\s*$/i;
const HELP_RE = /^\/?help(?:\s+([a-z0-9][a-z0-9-]*))?\s*$/i;

// Reserved tokens that must never be routed to a session via the prefix
// path, even if a slug literally matches one. Without this guard, a
// malformed `/nick foo` (missing slug arg) — which doesn't match
// NICK_SET_RE — would fall through to PREFIX_RE and deliver `foo` to a
// hypothetical session named `nick`. The docstring contract promises that
// can't happen.
const RESERVED_PREFIX_TOKENS = new Set(['status', 'nick', 'unnick', 'nicks', 'help']);

/**
 * `hasSlug` is called only on the prefix-path branch — the last branch
 * checked. Most updates (wrong chat, no text, reserved command, quote-reply)
 * return before it's invoked, so callers should pass a cheap accessor (e.g.
 * a Map's `.has` bound) rather than materializing a Set on every route call.
 *
 * `resolveNickname(token) → slug | null` is consulted when `hasSlug` returns
 * false, so a registered nickname can stand in for the slug on the prefix path.
 *
 * Backwards compat: if `knownSlugs` (a Set) is passed instead of `hasSlug`,
 * we use it the same way. New callers should use `hasSlug`.
 */
export function route({
  update,
  expectedChatId,
  replyTracker,
  hasSlug,
  knownSlugs,
  resolveNickname = () => null,
  resolveTopic = () => null,
}) {
  const message = update?.message;
  if (!message) return null;
  if (message.chat?.id !== expectedChatId) return null;
  // Photo / voice messages carry routing instructions in `caption` rather
  // than `text`. Treat caption as text for routing; the attachment itself
  // flows separately via the deliver action's payload.
  const text = (typeof message.text === 'string' && message.text.length > 0)
    ? message.text
    : (typeof message.caption === 'string' ? message.caption : '');
  // Empty text + quote-reply is still routable (a photo with no caption
  // sent as a reply to a belfry message). For everything else, no text
  // means no route.
  const hasReplyTo = typeof message.reply_to_message?.message_id === 'number';
  if (text.length === 0 && !hasReplyTo) return null;

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

  // Quote-reply path. Wins over topic routing because the quote is more
  // specific (the user explicitly named a message in the topic).
  const replyToId = message.reply_to_message?.message_id;
  if (typeof replyToId === 'number') {
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
  const threadId = message.message_thread_id;
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
      const known = hasSlug ? hasSlug(token) : knownSlugs?.has(token);
      if (known) return { action: 'deliver', slug: token, text: body, messageId };
      const aliased = resolveNickname(token);
      if (aliased) return { action: 'deliver', slug: aliased, text: body, messageId };
    }
  }

  // Fell through all known routes. Hand to the conversational agent if wired.
  return { action: 'unmatched', text, messageId };
}
