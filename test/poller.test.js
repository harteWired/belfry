import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../lib/poller.js';
import { ReplyTracker } from '../lib/reply-tracker.js';

const CHAT = 12345;

function fakeOk(updates) {
  return async () => ({
    ok: true,
    json: async () => ({ ok: true, result: updates }),
  });
}

/**
 * Minimal Registry-shaped fake. Records deliveries so tests can inspect
 * them, exposes knownSlugs() for the prefix router.
 */
function fakeTarget(initialSlugs = []) {
  const delivered = [];
  const slugs = new Set(initialSlugs);
  return {
    delivered,
    deliver(slug, text) { delivered.push({ slug, text }); return 1; },
    knownSlugs() { return slugs; },
    addSlug(s) { slugs.add(s); },
  };
}

function makePoller(updates, { knownSlugs = ['life-planner'], tracked = [] } = {}) {
  const replyTracker = new ReplyTracker();
  for (const [id, slug] of tracked) replyTracker.record(id, slug);
  const target = fakeTarget(knownSlugs);
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn: fakeOk(updates),
  });
  return { poller, target };
}

test('tick processes routable updates and advances offset', async () => {
  const updates = [
    {
      update_id: 100,
      message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner do X' },
    },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.deepEqual(target.delivered, [{ slug: 'life-planner', text: 'do X' }]);
  assert.equal(poller.offset, 101);
});

test('tick ignores updates from other chats', async () => {
  const updates = [
    {
      update_id: 200,
      message: { message_id: 1, chat: { id: 99999 }, text: '/life-planner do X' },
    },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.equal(target.delivered.length, 0);
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
  const { poller, target } = makePoller(updates, { tracked: [[42, 'life-planner']] });
  await poller.tick();
  assert.deepEqual(target.delivered, [{ slug: 'life-planner', text: 'continue please' }]);
});

test('multiple updates deliver in order', async () => {
  const updates = [
    { update_id: 400, message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner first' } },
    { update_id: 401, message: { message_id: 2, chat: { id: CHAT }, text: '/life-planner second' } },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.deepEqual(target.delivered.map((d) => d.text), ['first', 'second']);
  assert.equal(poller.offset, 402);
});

test('non-ok response throws', async () => {
  const target = fakeTarget();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
  });
  await assert.rejects(poller.tick(), /401/);
});

test('telegram returning ok=false throws', async () => {
  const target = fakeTarget();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: false, description: 'nope' }) }),
  });
  await assert.rejects(poller.tick(), /ok/);
});

test('primeOffset advances offset past the last buffered update', async () => {
  const target = fakeTarget();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ ok: true, result: [{ update_id: 1234, message: { chat: { id: CHAT }, text: 'old' } }] }),
    }),
  });
  await poller.primeOffset();
  assert.equal(poller.offset, 1235);
  // The priming call must NOT have routed the stale message anywhere.
  assert.equal(target.delivered.length, 0);
});

test('primeOffset is a no-op when backlog is empty', async () => {
  const target = fakeTarget();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
  });
  await poller.primeOffset();
  assert.equal(poller.offset, 0);
});

test('primeOffset swallows errors (best-effort)', async () => {
  const target = fakeTarget();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: async () => { throw new Error('network down'); },
  });
  await poller.primeOffset();
  assert.equal(poller.offset, 0);
});

test('knownSlugs is read fresh per tick (live registry view)', async () => {
  // First the slug is unknown; should not route. Then we add it; second tick should route.
  let updates = [
    { update_id: 500, message: { message_id: 1, chat: { id: CHAT }, text: '/late do thing' } },
  ];
  let callCount = 0;
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ ok: true, result: callCount++ === 0 ? updates : [{
      update_id: 501, message: { message_id: 2, chat: { id: CHAT }, text: '/late do thing 2' },
    }] }),
  });
  const target = fakeTarget(); // empty initially
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn,
  });
  await poller.tick();
  assert.equal(target.delivered.length, 0, 'first tick: slug not yet known');
  target.addSlug('late');
  await poller.tick();
  assert.deepEqual(target.delivered, [{ slug: 'late', text: 'do thing 2' }]);
});
