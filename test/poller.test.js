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

test('tick: /status routes to onStatusRequest, not target.deliver', async () => {
  const updates = [
    {
      update_id: 700,
      message: { message_id: 71, chat: { id: CHAT }, text: '/status' },
    },
    {
      update_id: 701,
      message: { message_id: 72, chat: { id: CHAT }, text: '/status belfry' },
    },
  ];
  const target = fakeTarget(['belfry']);
  const seen = [];
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    onStatusRequest: async (req) => { seen.push(req); },
    fetchFn: fakeOk(updates),
  });
  await poller.tick();
  // onStatusRequest is fire-and-forget; flush the microtask queue.
  await new Promise((r) => setImmediate(r));
  assert.equal(target.delivered.length, 0);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { slug: null, messageId: 71 });
  assert.deepEqual(seen[1], { slug: 'belfry', messageId: 72 });
});

test('tick: /status with no handler logs and drops without crashing', async () => {
  const updates = [
    { update_id: 800, message: { message_id: 81, chat: { id: CHAT }, text: '/status' } },
  ];
  const target = fakeTarget();
  const logs = [];
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: fakeOk(updates),
    log: (m) => logs.push(m),
    // no onStatusRequest
  });
  await poller.tick();
  assert.equal(target.delivered.length, 0);
  assert.ok(logs.some((m) => /no handler/.test(m)));
});

test('tick: /nick routes to onNickRequest', async () => {
  const updates = [
    {
      update_id: 600,
      message: { message_id: 6, chat: { id: CHAT }, text: '/nick lp life-planner' },
    },
  ];
  const replyTracker = new ReplyTracker();
  const target = fakeTarget(['life-planner']);
  const seen = [];
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn: fakeOk(updates),
    onNickRequest: async (action) => { seen.push(action); },
  });
  await poller.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'nick-set');
  assert.equal(seen[0].nickname, 'lp');
  assert.equal(seen[0].slug, 'life-planner');
});

test('tick: nickname resolves on prefix path when slug unknown', async () => {
  const updates = [
    {
      update_id: 700,
      message: { message_id: 7, chat: { id: CHAT }, text: '/lp do thing' },
    },
  ];
  const replyTracker = new ReplyTracker();
  const target = fakeTarget(['life-planner']); // slug 'lp' is NOT known
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn: fakeOk(updates),
    resolveNickname: (token) => (token === 'lp' ? 'life-planner' : null),
  });
  await poller.tick();
  assert.deepEqual(target.delivered, [{ slug: 'life-planner', text: 'do thing' }]);
});

test('tick: unmatched goes to onUnmatched if wired', async () => {
  const updates = [
    {
      update_id: 800,
      message: { message_id: 8, chat: { id: CHAT }, text: 'hello belfry' },
    },
  ];
  const replyTracker = new ReplyTracker();
  const target = fakeTarget();
  const seen = [];
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn: fakeOk(updates),
    onUnmatched: async (req) => { seen.push(req); },
  });
  await poller.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'hello belfry');
});

test('tick: unmatched dropped silently when onUnmatched not wired', async () => {
  const updates = [
    {
      update_id: 900,
      message: { message_id: 9, chat: { id: CHAT }, text: 'hello' },
    },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.equal(target.delivered.length, 0);
});
