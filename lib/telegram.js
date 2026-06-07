/**
 * Tiny Telegram Bot API client. Uses Node's global fetch — no SDK.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const TELEGRAM_FILE_CAP = 4 * 1024 * 1024; // 4 MB; photos from phones are usually well under this

/**
 * Build the Error to throw for a non-ok Telegram HTTP response. A 429 is
 * special-cased: the rate-limit retry delay rides Telegram's JSON
 * `parameters.retry_after` (seconds). We surface it as `err.status = 429` +
 * `err.retryAfter` so the SendQueue (#35) can wait the prescribed time and
 * retry instead of dropping the message. Everything else is a flat Error.
 */
function telegramHttpError(method, status, errBody) {
  if (status === 429) {
    let retryAfter = 1;
    try {
      retryAfter = JSON.parse(errBody)?.parameters?.retry_after ?? retryAfter;
    } catch {
      // Non-JSON body — fall back to a 1s retry hint.
    }
    const err = new Error(`telegram ${method} rate-limited (429): retry_after=${retryAfter}s`);
    err.status = 429;
    err.retryAfter = Number(retryAfter) || 1;
    return err;
  }
  return new Error(`telegram ${method} failed: ${status} ${String(errBody).slice(0, 200)}`);
}

export async function sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId, replyMarkup, parseMode }) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  if (forumTopicId) {
    body.message_thread_id = Number(forumTopicId);
  }
  if (typeof replyToMessageId === 'number' && replyToMessageId > 0) {
    body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  }
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw telegramHttpError('sendMessage', res.status, errBody);
  }
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`telegram returned ok=false: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.result;
}

/**
 * Edit an existing message's text and (optionally) replace its reply_markup.
 * Used by the approval-button handler to drop the keyboard after a tap and
 * append the resolved outcome to the body. Pass `replyMarkup: {}` to remove
 * the inline keyboard entirely.
 */
export async function editMessageText({ botToken, chatId, messageId, text, replyMarkup, parseMode, fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw telegramHttpError('editMessageText', res.status, errBody);
  }
  return (await res.json()).result;
}

/**
 * Acknowledge a callback_query. Telegram dismisses the loading spinner on
 * the user's tap when this fires. `text` is an optional toast above the
 * button row (≤200 chars).
 */
export async function answerCallbackQuery({ botToken, callbackQueryId, text, showAlert = false, fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = text.slice(0, 200);
  if (showAlert) body.show_alert = true;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`telegram answerCallbackQuery failed: ${res.status} ${errBody.slice(0, 200)}`);
  }
  return (await res.json()).result;
}

/**
 * React to a message with a single emoji (Telegram setMessageReaction).
 *
 * Used by the routing-status ack (#32): when an inbound message routes to a
 * session, belfry reacts to it with one emoji encoding the routing outcome.
 * Pass a falsy `emoji` to CLEAR any existing reaction (empty `reaction` array).
 *
 * Standard bots may only react with emoji from Telegram's fixed free set
 * (~70 emoji); a premium/custom emoji yields a 400. Callers treat this as
 * decorative and fire-and-forget — a failed reaction must never block the
 * actual message delivery — so this throws and lets the caller swallow it.
 */
export async function setMessageReaction({ botToken, chatId, messageId, emoji, isBig = false, fetchImpl = fetch }) {
  const url = `https://api.telegram.org/bot${botToken}/setMessageReaction`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: 'emoji', emoji }] : [],
  };
  if (isBig) body.is_big = true;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw telegramHttpError('setMessageReaction', res.status, errBody);
  }
  return (await res.json()).result;
}

/**
 * Build a 4-button inline keyboard for an approval prompt. callback_data
 * carries the token issued by ApprovalTokens.issue() so the handler can
 * resolve back to (slug, messageId).
 */
export function approvalKeyboard(token) {
  return {
    inline_keyboard: [[
      { text: '✓ Allow', callback_data: `belfry:allow:${token}` },
      { text: '✗ Deny', callback_data: `belfry:deny:${token}` },
      { text: '✓✓ Always', callback_data: `belfry:always:${token}` },
      { text: '⏸ Defer', callback_data: `belfry:defer:${token}` },
    ]],
  };
}

/** Verb → text injected into the receiving session. */
export const APPROVAL_VERB_TEXT = {
  allow: 'yes',
  deny: 'no',
  always: 'yes (always)',
  defer: '(deferred)',
};

/**
 * Resolve a Telegram file_id to a downloadable path via getFile, then stream
 * the bytes to disk. Used for inbound photos (#16); generic enough to
 * support other Telegram file types (voice/document) when wired.
 *
 * Returns the absolute path the bytes landed at. Cap at 4 MB to bound daemon
 * memory and respect mobile network reality — Telegram's own limit is 50 MB
 * for documents and 10 MB for photos, but for our use case 4 MB covers
 * any phone screenshot and rejects pathological payloads.
 *
 * Throws on any fetch / http failure or oversized file. Caller decides how
 * to surface the failure to the user.
 */
export async function downloadFile({ botToken, fileId, destDir, destName, fetchImpl = fetch, fs = nodeFs, path = nodePath, sizeCap = TELEGRAM_FILE_CAP }) {
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
