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

test('text alongside tool call: suppresses the text fallback', async () => {
  // Reproduces the 2026-05-11 duplicate-reply symptom: brain calls reply
  // / decline / deliver_to_slug AND emits text. Without the suppression
  // gate, the user receives two replies for one message.
  const brain = fakeBrain({ sendImpl: () => 'stray model text' });
  const send = fakeSender();
  const brainHandlers = {
    _flag: false,
    resetActionFlag() { this._flag = false; },
    didActionFire() { return this._flag; },
  };
  const h = makeAgentHandler({ brain, brainHandlers, send });
  // Simulate the brain calling an action tool during brain.send (the
  // tool path runs out-of-band through the brain MCP plugin in
  // production; the flag set is what agent-handler observes).
  brain.send = async (prompt) => {
    brain.calls.push(prompt);
    brainHandlers._flag = true;
    return 'stray model text';
  };
  await h({ text: 'hi belfry', messageId: 99 });
  assert.equal(send.calls.length, 0, 'send must be suppressed when tool fired');
  assert.equal(brain.calls.length, 1);
});

test('text without any tool call: still falls back', async () => {
  const brain = fakeBrain({ sendImpl: () => 'just a text reply' });
  const send = fakeSender();
  const brainHandlers = {
    resetActionFlag() {},
    didActionFire() { return false; },
  };
  const h = makeAgentHandler({ brain, brainHandlers, send });
  await h({ text: 'hi', messageId: 100 });
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, 'just a text reply');
  assert.equal(send.calls[0].replyToMessageId, 100);
});

test('brainHandlers absent: behavior unchanged (text fallback still fires)', async () => {
  const brain = fakeBrain({ sendImpl: () => 'reply text' });
  const send = fakeSender();
  const h = makeAgentHandler({ brain, send });
  await h({ text: 'hi', messageId: 101 });
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, 'reply text');
});

test('resetActionFlag is called before brain.send (so prior turn flag does not leak)', async () => {
  // Hardening: even if an action tool fired during a PRIOR turn, the
  // current turn's decision must be based on what fires THIS turn.
  let resetCount = 0;
  let sendCount = 0;
  const brain = {
    isAlive: () => true,
    send: async () => { sendCount += 1; return 'stray text'; },
  };
  const send = fakeSender();
  const brainHandlers = {
    resetActionFlag() { resetCount += 1; },
    didActionFire() { return false; },
  };
  const h = makeAgentHandler({ brain, brainHandlers, send });
  await h({ text: 'hi', messageId: 50 });
  assert.equal(resetCount, 1);
  assert.equal(sendCount, 1);
  assert.equal(send.calls.length, 1, 'no tool fired → text fallback runs');
});
