/**
 * Route a Telegram update to (slug, queue, text).
 *
 * Steps:
 *   1. Filter by chat.id == expectedChatId. Anything else → null (silent drop).
 *   2. Require message.text to be a non-empty string.
 *   3. If message.reply_to_message.message_id is in the reply tracker, route
 *      to that slug (quote-reply path). Always 'continuation' queue.
 *   4. Otherwise, if text starts with `/<slug-name> ` (or `/<slug-name>` alone)
 *      and the slug is in knownSlugs, route to that slug with the rest of the
 *      text as the body (prefix path). Always 'continuation' queue.
 *   5. Otherwise → null.
 *
 * Phase 1 only emits 'continuation'. Interrupt routing lands in Phase 2 (#3).
 */

const PREFIX_RE = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

export function route({ update, expectedChatId, replyTracker, knownSlugs }) {
  const message = update?.message;
  if (!message) return null;
  if (message.chat?.id !== expectedChatId) return null;
  const text = message.text;
  if (typeof text !== 'string' || text.length === 0) return null;

  // Quote-reply path.
  const replyToId = message.reply_to_message?.message_id;
  if (typeof replyToId === 'number') {
    const slug = replyTracker.lookup(replyToId);
    if (slug) {
      return { slug, queue: 'continuation', text };
    }
  }

  // /<slug-name> prefix path.
  const m = text.match(PREFIX_RE);
  if (m) {
    const slug = m[1];
    const body = (m[2] ?? '').trim();
    if (knownSlugs.has(slug) && body.length > 0) {
      return { slug, queue: 'continuation', text: body };
    }
  }

  return null;
}
