import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAgentHandler } from '../lib/agent-handler.js';

function fakeBrain({ alive = true, sendImpl } = {}) {
  const calls = [];
  return {
    isAlive: () => alive,
    send: async (prompt) => {
      calls.push(prompt);
      if (sendImpl) return sendImpl(prompt);
      return ''; // brain typically returns empty when it's used reply_to_telegram tool
    },
    calls,
  };
}

function fakeSender() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { message_id: 8000 + calls.length };
  };
  fn.calls = calls;
  return fn;
}

test('happy path: forwards a CLASSIFY prompt to the brain with the originating message_id', async () => {
  const brain = fakeBrain();
  const send = fakeSender();
  const h = makeAgentHandler({ brain, send });
  await h({ text: 'how is belfry doing?', messageId: 42 });
  assert.equal(brain.calls.length, 1);
  assert.match(brain.calls[0], /CLASSIFY/);
  assert.match(brain.calls[0], /Originating message_id: 42/);
  assert.match(brain.calls[0], /how is belfry doing\?/);
  // Sender NOT called directly when brain returns empty — the brain's
  // tools handle reply_to_telegram out-of-band.
  assert.equal(send.calls.length, 0);
});

test('text fallback: brain returns non-empty text → forward to Telegram', async () => {
  const brain = fakeBrain({
    sendImpl: () => 'sorry I cannot help with that',
  });
  const send = fakeSender();
  const h = makeAgentHandler({ brain, send });
  await h({ text: 'whatever', messageId: 50 });
  // Brain's text reaches the user via the fallback path.
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, 'sorry I cannot help with that');
  assert.equal(send.calls[0].replyToMessageId, 50);
});

test('brain down: replies with the "language layer is down" fallback', async () => {
  const brain = fakeBrain({ alive: false });
  const send = fakeSender();
  const h = makeAgentHandler({ brain, send });
  await h({ text: 'anything', messageId: 7 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /language layer is down/);
  assert.match(send.calls[0].text, /\/status/);
  assert.equal(send.calls[0].replyToMessageId, 7);
  assert.equal(brain.calls.length, 0, 'brain should not be invoked when down');
});

test('brain undefined: same fallback as down', async () => {
  const send = fakeSender();
  const h = makeAgentHandler({ brain: null, send });
  await h({ text: 'anything', messageId: 7 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /language layer is down/);
});

test('brain.send throws: replies with the "error" fallback', async () => {
  const brain = fakeBrain({
    sendImpl: () => { throw new Error('brain-side error'); },
  });
  const send = fakeSender();
  const h = makeAgentHandler({ brain, send });
  await h({ text: 'cause an error', messageId: 9 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /language layer hit an error/);
  assert.equal(send.calls[0].replyToMessageId, 9);
});

test('empty text: no-op', async () => {
  const brain = fakeBrain();
  const send = fakeSender();
  const h = makeAgentHandler({ brain, send });
  await h({ text: '', messageId: 5 });
  await h({ text: '   ', messageId: 6 });
  assert.equal(brain.calls.length, 0);
  assert.equal(send.calls.length, 0);
});
