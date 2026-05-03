import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../lib/poller.js';
import { Inbox } from '../lib/inbox.js';
import { ReplyTracker } from '../lib/reply-tracker.js';

const CHAT = 12345;

function fakeOk(updates) {
  return async () => ({
    ok: true,
    json: async () => ({ ok: true, result: updates }),
  });
}

function makePoller(updates, { knownSlugs = ['life-planner'], tracked = [] } = {}) {
  const inbox = new Inbox();
  const replyTracker = new ReplyTracker();
  for (const [id, slug] of tracked) replyTracker.record(id, slug);
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    knownSlugs: new Set(knownSlugs),
    inbox,
    fetchFn: fakeOk(updates),
  });
  return { poller, inbox };
}

test('tick processes routable updates and advances offset', async () => {
  const updates = [
    {
      update_id: 100,
      message: {
        message_id: 1,
        chat: { id: CHAT },
        text: '/life-planner do X',
      },
    },
  ];
  const { poller, inbox } = makePoller(updates);
  await poller.tick();
  assert.equal(inbox.peek('life-planner', 'continuation'), 'do X');
  assert.equal(poller.offset, 101);
});

test('tick ignores updates from other chats', async () => {
  const updates = [
    {
      update_id: 200,
      message: { message_id: 1, chat: { id: 99999 }, text: '/life-planner do X' },
    },
  ];
  const { poller, inbox } = makePoller(updates);
  await poller.tick();
  assert.equal(inbox.peek('life-planner', 'continuation'), null);
  assert.equal(poller.offset, 201, 'offset still advances on filtered updates');
});

test('quote-reply routes to tracked slug', async () => {
  const updates = [
    {
      update_id: 300,
      message: {
        message_id: 5,
        chat: { id: CHAT },
        text: 'continue please',
        reply_to_message: { message_id: 42 },
      },
    },
  ];
  const { poller, inbox } = makePoller(updates, { tracked: [[42, 'life-planner']] });
  await poller.tick();
  assert.equal(inbox.peek('life-planner', 'continuation'), 'continue please');
});

test('multiple updates push in order and concatenate on drain', async () => {
  const updates = [
    {
      update_id: 400,
      message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner first' },
    },
    {
      update_id: 401,
      message: { message_id: 2, chat: { id: CHAT }, text: '/life-planner second' },
    },
  ];
  const { poller, inbox } = makePoller(updates);
  await poller.tick();
  assert.equal(inbox.drain('life-planner', 'continuation'), 'first\n\nsecond');
  assert.equal(poller.offset, 402);
});

test('non-ok response throws', async () => {
  const inbox = new Inbox();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    knownSlugs: new Set(),
    inbox,
    fetchFn: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
  });
  await assert.rejects(poller.tick(), /401/);
});

test('telegram returning ok=false throws', async () => {
  const inbox = new Inbox();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    knownSlugs: new Set(),
    inbox,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: false, description: 'nope' }) }),
  });
  await assert.rejects(poller.tick(), /ok/);
});
