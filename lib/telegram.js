/**
 * Tiny Telegram Bot API client. Uses Node's global fetch — no SDK.
 */

const TELEGRAM_FILE_CAP = 4 * 1024 * 1024; // 4 MB; photos from phones are usually well under this

export async function sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (forumTopicId) {
    body.message_thread_id = Number(forumTopicId);
  }
  if (typeof replyToMessageId === 'number' && replyToMessageId > 0) {
    body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
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

/**
 * Resolve a Telegram file_id to a downloadable path via getFile, then stream
 * the bytes to disk. Used for inbound photos (#16) and voice notes (#19).
 *
 * Returns the absolute path the bytes landed at. Cap at 4 MB to bound daemon
 * memory and respect mobile network reality — Telegram's own limit is 50 MB
 * for documents and 10 MB for photos, but for our use case 4 MB covers
 * any phone screenshot or short voice clip and rejects pathological payloads.
 *
 * Throws on any fetch / http failure or oversized file. Caller decides how
 * to surface the failure to the user.
 */
export async function downloadFile({ botToken, fileId, destDir, destName, fetchImpl = fetch, fs = null, sizeCap = TELEGRAM_FILE_CAP }) {
  if (!fs) fs = await import('node:fs');
  const path = await import('node:path');
  // 1. Resolve file path via getFile.
  const metaUrl = `https://api.telegram.org/bot${botToken}/getFile`;
  const metaRes = await fetchImpl(metaUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!metaRes.ok) {
    throw new Error(`telegram getFile failed: ${metaRes.status}`);
  }
  const metaJson = await metaRes.json();
  if (!metaJson.ok || !metaJson.result?.file_path) {
    throw new Error(`telegram getFile returned no file_path: ${JSON.stringify(metaJson).slice(0, 200)}`);
  }
  const filePath = metaJson.result.file_path;
  const declaredSize = metaJson.result.file_size;
  if (typeof declaredSize === 'number' && declaredSize > sizeCap) {
    throw new Error(`telegram file too large: ${declaredSize} > ${sizeCap}`);
  }
  // 2. Stream the bytes.
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileRes = await fetchImpl(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`telegram file fetch failed: ${fileRes.status}`);
  }
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.length > sizeCap) {
    throw new Error(`telegram file too large: ${buf.length} > ${sizeCap}`);
  }
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const ext = path.extname(filePath) || '';
  const out = path.join(destDir, destName + ext);
  fs.writeFileSync(out, buf, { mode: 0o600 });
  return out;
}
