import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAgentHandler } from '../lib/agent-handler.js';
import { NicknameRegistry } from '../lib/nicknames.js';
import { RecentMessages } from '../lib/recent-messages.js';
import { ConversationMemory } from '../lib/conversation-memory.js';

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
  getActiveSlugs: () => new Set(['belfry']),
  statusDir: '/nowhere',
  readStatus: () => ({ error: 'stubbed' }),
  getHelp: (topic) => `(help for ${topic})`,
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
    ...baseDeps({ getActiveSlugs: () => new Set(['belfry']) }),
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

test('readStatus: invoked with slug and active set; can stub fs entirely', async () => {
  const seen = [];
  const h = makeAgentHandler({
    ...baseDeps({
      readStatus: (slug, activeSet) => {
        seen.push({ slug, present: activeSet.has(slug) });
        return { status: 'ready', slug };
      },
    }),
    classifyFn: async (args) => {
      // Simulate the model calling get_session.
      args.tools.get_session({ slug: 'belfry' });
      return { intent: 'decline', message: 'k' };
    },
  });
  await h({ text: 'how is belfry', messageId: 900 });
  assert.deepEqual(seen, [{ slug: 'belfry', present: true }]);
});

test('memory: records user turn before classifying and assistant turn after', async () => {
  const memory = new ConversationMemory();
  const send = fakeSender();
  let classifyChatId;
  const h = makeAgentHandler({
    ...baseDeps({ memory, chatId: 12345 }),
    send,
    classifyFn: async (args) => {
      // At classify time, the user turn should already be in memory so
      // contextBlock for follow-ups is correct. We don't assert on contextBlock
      // here (this is the first turn — block is empty) but the next call would.
      classifyChatId = 12345;
      return { intent: 'ask', message: 'replied' };
    },
  });
  await h({ text: 'hello there', messageId: 1 });
  const turns = memory.recent(12345);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].text, 'hello there');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].text, 'replied');
});

test('memory: passes contextBlock from previous turns into classifyFn', async () => {
  const memory = new ConversationMemory();
  memory.push(99, { role: 'user', text: 'tell me about belfry' });
  memory.push(99, { role: 'assistant', text: 'belfry is up' });

  let captured;
  const h = makeAgentHandler({
    ...baseDeps({ memory, chatId: 99 }),
    classifyFn: async (args) => {
      captured = args.contextBlock;
      return { intent: 'ask', message: 'k' };
    },
  });
  await h({ text: 'what about life-planner?', messageId: 2 });
  assert.match(captured ?? '', /tell me about belfry/);
  assert.match(captured ?? '', /belfry is up/);
});

test('memory: opt-out — no memory wired means no contextBlock and no recording', async () => {
  let captured;
  const h = makeAgentHandler({
    ...baseDeps({ memory: null, chatId: null }),
    classifyFn: async (args) => {
      captured = args.contextBlock;
      return { intent: 'ask', message: 'k' };
    },
  });
  await h({ text: 'hi', messageId: 3 });
  assert.equal(captured, '');
});

test('classifyFn receives active slugs and nickname map', async () => {
  let captured = null;
  const nicknames = new NicknameRegistry({ getActiveSlugs: () => new Set(['belfry']) });
  nicknames.set('b', 'belfry');
  const h = makeAgentHandler({
    ...baseDeps({ nicknames, getActiveSlugs: () => new Set(['belfry']) }),
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
