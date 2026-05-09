import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAgentHandler } from '../lib/agent-handler.js';
import { NicknameRegistry } from '../lib/nicknames.js';
import { RecentMessages } from '../lib/recent-messages.js';

function fakeWatcher({ activeSlugs = [], statusDir = '/nowhere' } = {}) {
  return {
    statusDir,
    getActiveSlugs: () => new Set(activeSlugs),
  };
}

function fakeSender() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { message_id: 5000 + calls.length };
  };
  fn.calls = calls;
  return fn;
}

function fakeDeliver() {
  const calls = [];
  const fn = (slug, text, messageId) => {
    calls.push({ slug, text, messageId });
    return 1;
  };
  fn.calls = calls;
  return fn;
}

const baseDeps = (overrides = {}) => ({
  apiKey: 'sk',
  nicknames: new NicknameRegistry({ getActiveSlugs: () => new Set(['belfry']) }),
  recentMessages: new RecentMessages(),
  watcher: fakeWatcher({ activeSlugs: ['belfry'] }),
  send: fakeSender(),
  deliver: fakeDeliver(),
  recordReply: () => {},
  ...overrides,
});

test('ask intent: replies with message, no delivery', async () => {
  const send = fakeSender();
  const deliver = fakeDeliver();
  const h = makeAgentHandler({
    ...baseDeps(),
    send,
    deliver,
    classifyFn: async () => ({ intent: 'ask', message: 'all good' }),
  });
  await h({ text: 'how are things?', messageId: 100 });
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, 'all good');
  assert.equal(send.calls[0].replyToMessageId, 100);
  assert.equal(deliver.calls.length, 0);
});

test('route intent: sends confirmation, records reply, then delivers', async () => {
  const send = fakeSender();
  const deliver = fakeDeliver();
  const recorded = [];
  const h = makeAgentHandler({
    ...baseDeps(),
    send,
    deliver,
    recordReply: (msgId, slug) => recorded.push({ msgId, slug }),
    classifyFn: async () => ({ intent: 'route', target_slug: 'belfry', body: 'restart please', confidence: 0.95 }),
  });
  await h({ text: 'belfry restart please', messageId: 200 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /→ belfry: 'restart please'/);
  assert.equal(deliver.calls.length, 1);
  assert.equal(deliver.calls[0].slug, 'belfry');
  assert.equal(deliver.calls[0].text, 'restart please');
  // The confirm's message_id should have been recorded against the slug.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].slug, 'belfry');
});

test('route intent: rejects when target_slug is no longer active', async () => {
  const send = fakeSender();
  const deliver = fakeDeliver();
  const h = makeAgentHandler({
    ...baseDeps({ watcher: fakeWatcher({ activeSlugs: ['belfry'] }) }),
    send,
    deliver,
    classifyFn: async () => ({ intent: 'route', target_slug: 'gone', body: 'x', confidence: 0.99 }),
  });
  await h({ text: 'gone do something', messageId: 300 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /couldn't route to 'gone'/);
  assert.equal(deliver.calls.length, 0);
});

test('ambiguous intent: lists candidates and asks user', async () => {
  const send = fakeSender();
  const deliver = fakeDeliver();
  const h = makeAgentHandler({
    ...baseDeps(),
    send,
    deliver,
    classifyFn: async () => ({ intent: 'ambiguous', candidates: ['belfry', 'life-planner'], hint: 'restart' }),
  });
  await h({ text: 'restart', messageId: 400 });
  assert.equal(send.calls.length, 1);
  const text = send.calls[0].text;
  assert.match(text, /1\. belfry/);
  assert.match(text, /2\. life-planner/);
  assert.match(text, /\(restart\)/);
  assert.equal(deliver.calls.length, 0);
});

test('decline intent: replies with message', async () => {
  const send = fakeSender();
  const h = makeAgentHandler({
    ...baseDeps(),
    send,
    classifyFn: async () => ({ intent: 'decline', message: 'no idea' }),
  });
  await h({ text: 'whatever', messageId: 500 });
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, 'no idea');
});

test('classifyFn throws → fallback decline reply', async () => {
  const send = fakeSender();
  const h = makeAgentHandler({
    ...baseDeps(),
    send,
    classifyFn: async () => { throw new Error('boom'); },
  });
  await h({ text: 'hi', messageId: 600 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /couldn't process/);
});

test('empty / whitespace text: handler is a no-op', async () => {
  const send = fakeSender();
  let called = false;
  const h = makeAgentHandler({
    ...baseDeps(),
    send,
    classifyFn: async () => {
      called = true;
      return { intent: 'decline', message: '' };
    },
  });
  await h({ text: '   ', messageId: 700 });
  assert.equal(called, false);
  assert.equal(send.calls.length, 0);
});

test('classifyFn receives active slugs and nickname map', async () => {
  let captured = null;
  const nicknames = new NicknameRegistry({ getActiveSlugs: () => new Set(['belfry']) });
  nicknames.set('b', 'belfry');
  const h = makeAgentHandler({
    ...baseDeps({ nicknames, watcher: fakeWatcher({ activeSlugs: ['belfry'] }) }),
    classifyFn: async (args) => {
      captured = args;
      return { intent: 'decline', message: 'k' };
    },
  });
  await h({ text: 'huh', messageId: 800 });
  assert.deepEqual(captured.activeSlugs, ['belfry']);
  assert.deepEqual(captured.nicknames, { b: 'belfry' });
  // Tools wired
  const sessions = captured.tools.list_sessions();
  assert.equal(sessions[0].slug, 'belfry');
});
