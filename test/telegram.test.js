import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setMessageReaction } from '../lib/telegram.js';

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
