import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setMessageReaction, sendDocument } from '../lib/telegram.js';

// --- sendDocument (#outbound files) ---
function fileFetch(captured, { ok = true, status = 200, result = { ok: true, result: { message_id: 1 } } } = {}) {
  return async (url, opts) => {
    captured.push({ url, form: opts.body });
    return { ok, status, json: async () => result, text: async () => JSON.stringify(result) };
  };
}
const fakeFs = (content = 'bytes') => ({ readFileSync: () => Buffer.from(content) });

test('sendDocument uses sendPhoto for image extensions (case-insensitive)', async () => {
  const cap = [];
  await sendDocument({ botToken: 'TOK', chatId: 5, filePath: '/x/pic.PNG', caption: 'hi', fetchImpl: fileFetch(cap), fs: fakeFs() });
  assert.match(cap[0].url, /\/botTOK\/sendPhoto$/);
  assert.ok(cap[0].form.get('photo'));
  assert.equal(cap[0].form.get('chat_id'), '5');
  assert.equal(cap[0].form.get('caption'), 'hi');
});

test('sendDocument uses sendDocument for non-image, and forceDocument overrides an image', async () => {
  const cap = [];
  await sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/report.pdf', fetchImpl: fileFetch(cap), fs: fakeFs() });
  assert.match(cap[0].url, /\/sendDocument$/);
  assert.ok(cap[0].form.get('document'));
  const cap2 = [];
  await sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/pic.png', forceDocument: true, fetchImpl: fileFetch(cap2), fs: fakeFs() });
  assert.match(cap2[0].url, /\/sendDocument$/);
});

test('sendDocument threads reply_parameters and clamps caption to 1024', async () => {
  const cap = [];
  await sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/a.txt', caption: 'x'.repeat(2000), replyToMessageId: 99, fetchImpl: fileFetch(cap), fs: fakeFs() });
  assert.equal(cap[0].form.get('caption').length, 1024);
  assert.deepEqual(JSON.parse(cap[0].form.get('reply_parameters')), { message_id: 99, allow_sending_without_reply: true });
});

test('sendDocument throws on a non-ok Telegram response', async () => {
  await assert.rejects(
    () => sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/a.txt', fetchImpl: fileFetch([], { ok: false, status: 400, result: { ok: false } }), fs: fakeFs() }),
    /sendDocument failed: 400/,
  );
});

function fakeFetch(captured, { ok = true, status = 200, result = { ok: true } } = {}) {
  return async (url, opts) => {
    captured.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok,
      status,
      json: async () => result,
      text: async () => JSON.stringify(result),
    };
  };
}

test('setMessageReaction posts the emoji as a ReactionTypeEmoji array', async () => {
  const captured = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 42, messageId: 7, emoji: '👀', fetchImpl: fakeFetch(captured),
  });
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/botTOK\/setMessageReaction$/);
  assert.deepEqual(captured[0].body, {
    chat_id: 42,
    message_id: 7,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
});

test('falsy emoji clears the reaction with an empty array', async () => {
  const captured = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 1, messageId: 2, emoji: null, fetchImpl: fakeFetch(captured),
  });
  assert.deepEqual(captured[0].body.reaction, []);
});

test('is_big is only set when requested', async () => {
  const captured = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 1, messageId: 2, emoji: '✅', isBig: true, fetchImpl: fakeFetch(captured),
  });
  assert.equal(captured[0].body.is_big, true);

  const captured2 = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 1, messageId: 2, emoji: '✅', fetchImpl: fakeFetch(captured2),
  });
  assert.equal(captured2[0].body.is_big, undefined);
});

test('throws on a non-ok HTTP response', async () => {
  const fetchImpl = fakeFetch([], { ok: false, status: 400, result: { ok: false, description: 'REACTION_INVALID' } });
  await assert.rejects(
    () => setMessageReaction({ botToken: 'TOK', chatId: 1, messageId: 2, emoji: '🛠', fetchImpl }),
    /setMessageReaction failed: 400/,
  );
});
