/**
 * Route a Telegram update to either a delivery (session injection) or an
 * action (e.g. /status request).
 *
 * Returns one of:
 *   - `{ action: 'deliver', slug, text, messageId }` — feed text into a session
 *   - `{ action: 'status', slug?, messageId }` — render a status digest
 *   - `null` — drop silently
 *
 * Steps:
 *   1. Filter by chat.id == expectedChatId. Anything else → null.
 *   2. Require message.text to be a non-empty string.
 *   3. If text matches `/status` or `/status <slug>`, return action='status'.
 *      The leading slash takes precedence over slug-prefix routing because
 *      `status` is a reserved command — even if a slug is literally named
 *      "status" it cannot be addressed via the prefix path (use a quote-reply).
 *   4. If message.reply_to_message.message_id is in the reply tracker, route
 *      to that slug (quote-reply path).
 *   5. Otherwise, if text starts with `/<slug-name> ` and the slug is in
 *      knownSlugs, route to that slug with the rest of the text as the body.
 *   6. Otherwise → null.
 */

// Slug shape mirrors PREFIX_RE: must start with an alphanumeric, then allow
// dashes/dots/underscores (slug.js can produce any of these via cwd basename).
const STATUS_RE = /^\/status(?:\s+([a-z0-9][a-z0-9._-]*))?\s*$/i;
const PREFIX_RE = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

export function route({ update, expectedChatId, replyTracker, knownSlugs }) {
  const message = update?.message;
  if (!message) return null;
  if (message.chat?.id !== expectedChatId) return null;
  const text = message.text;
  if (typeof text !== 'string' || text.length === 0) return null;

  const messageId = typeof message.message_id === 'number' ? message.message_id : null;

  // /status [slug] — reserved command, takes precedence over /slug-prefix.
  const statusMatch = text.match(STATUS_RE);
  if (statusMatch) {
    const slug = statusMatch[1] ? statusMatch[1] : null;
    return { action: 'status', slug, messageId };
  }

  // Quote-reply path.
  const replyToId = message.reply_to_message?.message_id;
  if (typeof replyToId === 'number') {
    const slug = replyTracker.lookup(replyToId);
    if (slug) {
      return { action: 'deliver', slug, text, messageId };
    }
  }

  // /<slug-name> prefix path.
  const m = text.match(PREFIX_RE);
  if (m) {
    const slug = m[1];
    const body = (m[2] ?? '').trim();
    if (knownSlugs.has(slug) && body.length > 0) {
      return { action: 'deliver', slug, text: body, messageId };
    }
  }

  return null;
}
