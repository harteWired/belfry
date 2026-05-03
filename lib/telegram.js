/**
 * Tiny Telegram Bot API client. Uses Node's global fetch — no SDK.
 *
 * Only sendMessage is implemented; everything else (replies, polls, images)
 * is out of scope for an outbound-only relay.
 */

export async function sendMessage({ botToken, chatId, text, forumTopicId }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (forumTopicId) {
    body.message_thread_id = Number(forumTopicId);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`telegram sendMessage failed: ${res.status} ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`telegram returned ok=false: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.result;
}
