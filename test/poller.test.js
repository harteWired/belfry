import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

test('tick: /help routes to onHelpRequest', async () => {
  const updates = [
    {
      update_id: 950,
      message: { message_id: 95, chat: { id: CHAT }, text: '/help nicknames' },
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
    onHelpRequest: async (action) => { seen.push(action); },
  });
  await poller.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'help');
  assert.equal(seen[0].topic, 'nicknames');
});

test('tick: bare "status" (no slash) routes to onStatusRequest', async () => {
  const updates = [
    {
      update_id: 960,
      message: { message_id: 96, chat: { id: CHAT }, text: 'status' },
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
    onStatusRequest: async (req) => { seen.push(req); },
  });
  await poller.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].slug, null);
});

test('tick: callback_query routes to onApproval when prefix matches and chat is expected', async () => {
  const updates = [
    {
      update_id: 1300,
      callback_query: {
        id: 'q1',
        from: { id: CHAT },
        message: { message_id: 50, chat: { id: CHAT } },
        data: 'belfry:allow:0123456789abcdef',
      },
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
    onApproval: async (a) => { seen.push(a); },
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].callbackQueryId, 'q1');
  assert.equal(seen[0].verb, 'allow');
  assert.equal(seen[0].token, '0123456789abcdef');
  assert.equal(seen[0].messageId, 50);
});

test('tick: callback_query from wrong chat is dropped', async () => {
  const updates = [
    {
      update_id: 1400,
      callback_query: {
        id: 'q2',
        from: { id: 99999 },
        message: { message_id: 50, chat: { id: 99999 } },
        data: 'belfry:allow:tok',
      },
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
    onApproval: async (a) => { seen.push(a); },
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 0);
});

test('tick: callback_query with malformed token shape is dropped (defense in depth)', async () => {
  const updates = [
    {
      update_id: 1450,
      callback_query: {
        id: 'q4',
        from: { id: CHAT },
        message: { message_id: 50, chat: { id: CHAT } },
        data: 'belfry:allow:not-hex-or-too-short',
      },
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
    onApproval: async (a) => { seen.push(a); },
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 0);
});

test('tick: callback_query without belfry: prefix is dropped (foreign data)', async () => {
  const updates = [
    {
      update_id: 1500,
      callback_query: {
        id: 'q3',
        from: { id: CHAT },
        message: { message_id: 50, chat: { id: CHAT } },
        data: 'someotherbot:do:something',
      },
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
    onApproval: async (a) => { seen.push(a); },
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 0);
});

test('tick: photo with caption downloads, routes via caption, delivers with attachment', async () => {
  // Telegram returns getFile then the file body. We stub fetch by the URL
  // shape: getUpdates → updates payload; getFile → file path; final fetch →
  // raw bytes.
  const updates = [
    {
      update_id: 1100,
      message: {
        message_id: 11,
        chat: { id: CHAT },
        photo: [
          { file_id: 'tiny', width: 90 },
          { file_id: 'large', width: 1280 },
        ],
        caption: '/life-planner here is the screenshot',
      },
    },
  ];
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/getUpdates')) {
      return { ok: true, json: async () => ({ ok: true, result: updates }) };
    }
    if (url.endsWith('/getFile')) {
      return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/file_123.jpg', file_size: 100 } }) };
    }
    if (url.includes('/file/bot')) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const replyTracker = new ReplyTracker();
  const target = {
    delivered: [],
    deliver(slug, text, msgId, attachment) {
      this.delivered.push({ slug, text, msgId, attachment });
      return 1;
    },
    knownSlugs() { return new Set(['life-planner']); },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-attach-'));
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn,
    attachmentDir: tmpDir,
  });
  await poller.tick();
  // Allow the async process() to flush.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(target.delivered.length, 1, `delivered: ${JSON.stringify(target.delivered)}`);
  assert.equal(target.delivered[0].slug, 'life-planner');
  assert.equal(target.delivered[0].text, 'here is the screenshot');
  assert.match(target.delivered[0].attachment.imagePath, /\.jpg$/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('tick: photo with no caption + no quote-reply is dropped silently (no attachment dir consulted is fine)', async () => {
  const updates = [
    {
      update_id: 1200,
      message: {
        message_id: 12,
        chat: { id: CHAT },
        photo: [{ file_id: 'tiny' }],
      },
    },
  ];
  const replyTracker = new ReplyTracker();
  const target = fakeTarget();
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn: fakeOk(updates),
    // No attachmentDir — the photo download path is disabled, the router
    // returns null on empty text + no quote-reply.
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(target.delivered.length, 0);
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

test('duplicate update_id: second occurrence is skipped', async () => {
  // Defends against the duplicate-reply bug observed 2026-05-11: one
  // user message resulted in both a deliver-route and an unmatched-route
  // (with the brain firing on the second). Telegram's contract is
  // unique-update-id but we've seen duplicates in production.
  const dupUpdate = {
    update_id: 1000,
    message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner ping' },
  };
  const { poller, target } = makePoller([dupUpdate]);
  await poller.tick();
  // Re-tick with the same update_id (as if Telegram redelivered it).
  poller.fetchFn = fakeOk([{ ...dupUpdate }]);
  await poller.tick();
  assert.equal(target.delivered.length, 1, 'second delivery suppressed');
  assert.equal(target.delivered[0].text, 'ping');
});

test('duplicate update_id within the same batch is skipped', async () => {
  // Belt-and-suspenders: if Telegram ever returns the same id twice in
  // one response (a contract violation we'd rather not crash on), the
  // ring still catches it.
  const updates = [
    { update_id: 1100, message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner once' } },
    { update_id: 1100, message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner once' } },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.equal(target.delivered.length, 1);
  assert.equal(poller.offset, 1101);
});

test('non-numeric update_id passes through (defensive)', async () => {
  // Tests that may pass update_id of unusual types still process. Real
  // Telegram always sends numeric, but the dedup must not break tests
  // or weird payloads.
  const updates = [
    { update_id: 'x', message: { message_id: 1, chat: { id: CHAT }, text: '/life-planner test' } },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.equal(target.delivered.length, 1);
});

test('ring buffer evicts oldest when full', async () => {
  // Exercise the eviction path by pushing many fake update_ids through.
  const updates = [];
  for (let i = 0; i < 300; i += 1) {
    updates.push({
      update_id: 10_000 + i,
      message: { message_id: i + 1, chat: { id: CHAT }, text: '/life-planner ' + i },
    });
  }
  const { poller, target } = makePoller(updates);
  await poller.tick();
  assert.equal(target.delivered.length, 300, 'all 300 distinct updates dispatched');
  // The earliest update_id should now be evicted from the dedup ring;
  // a re-tick of that exact id should be dispatched again. (Cheap to
  // accept: 256-entry window covers any realistic Telegram retry window.)
  poller.fetchFn = fakeOk([{ ...updates[0] }]);
  await poller.tick();
  assert.equal(target.delivered.length, 301);
});

test('voice: transcribed text falls through normal routing (prefix path)', async () => {
  const updates = [
    {
      update_id: 1300,
      message: {
        message_id: 13,
        chat: { id: CHAT },
        voice: { file_id: 'VV', duration: 5, mime_type: 'audio/ogg' },
      },
    },
  ];
  const echoCalls = [];
  const handleVoice = async () => ({ text: '/life-planner deploy the api fix', audioPath: '/tmp/v.ogg' });
  const sendVoiceReply = async (args) => { echoCalls.push(args); };
  const replyTracker = new ReplyTracker();
  const target = fakeTarget(['life-planner']);
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker,
    target,
    fetchFn: fakeOk(updates),
    handleVoice,
    sendVoiceReply,
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(target.delivered, [{ slug: 'life-planner', text: 'deploy the api fix' }]);
  assert.equal(echoCalls.length, 1, 'echo should fire exactly once');
  assert.match(echoCalls[0].text, /^🎙 "/);
  assert.equal(echoCalls[0].replyToMessageId, 13);
});

test('voice: error result triggers user-facing reply and skips routing', async () => {
  const updates = [
    {
      update_id: 1310,
      message: {
        message_id: 14,
        chat: { id: CHAT },
        voice: { file_id: 'VV', duration: 5 },
      },
    },
  ];
  const echoCalls = [];
  const handleVoice = async () => ({ error: 'no-key' });
  const sendVoiceReply = async (args) => { echoCalls.push(args); };
  const target = fakeTarget(['life-planner']);
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target,
    fetchFn: fakeOk(updates),
    handleVoice,
    sendVoiceReply,
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(target.delivered.length, 0, 'voice errors must not route');
  assert.equal(echoCalls.length, 1);
  assert.match(echoCalls[0].text, /BELFRY_TRANSCRIBE_KEY/);
  assert.equal(echoCalls[0].replyToMessageId, 14);
});

test('voice: no handler wired → voice messages drop silently (back-compat)', async () => {
  const updates = [
    {
      update_id: 1320,
      message: {
        message_id: 15,
        chat: { id: CHAT },
        voice: { file_id: 'VV', duration: 5 },
      },
    },
  ];
  const { poller, target } = makePoller(updates);
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(target.delivered.length, 0);
});

test('voice: chat-id mismatch skips voice handler entirely', async () => {
  const updates = [
    {
      update_id: 1330,
      message: {
        message_id: 16,
        chat: { id: 99999 },
        voice: { file_id: 'VV', duration: 5 },
      },
    },
  ];
  let handlerCalled = false;
  const poller = new Poller({
    botToken: 'TOKEN',
    expectedChatId: CHAT,
    replyTracker: new ReplyTracker(),
    target: fakeTarget(),
    fetchFn: fakeOk(updates),
    handleVoice: async () => { handlerCalled = true; return { text: 'x' }; },
    sendVoiceReply: async () => {},
  });
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(handlerCalled, false, 'foreign chat must not touch the transcribe API');
});

// ── Routing-status emoji reactions (#32) ──────────────────────────────────

const REACT = { delivered: '👀', dropped: '🤷', unmatched: '🤔' };

/**
 * Fetch fake that routes by URL: getUpdates returns `updates` once (then an
 * empty backlog), setMessageReaction pushes its parsed body to `reactions`.
 * `onReact` lets a test make the reaction call throw.
 */
function reactionFetch(updates, reactions, { onReact } = {}) {
  let served = false;
  return async (url, opts) => {
    if (/\/setMessageReaction$/.test(url)) {
      if (onReact) return onReact();
      reactions.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    const result = served ? [] : updates;
    served = true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
}

function reactTarget(fanout) {
  const delivered = [];
  return {
    delivered,
    deliver(slug, text) { delivered.push({ slug, text }); return fanout; },
    knownSlugs() { return new Set(['life-planner']); },
  };
}

// Reactions are fire-and-forget; give the microtask + setMessageReaction call
// a tick to land before asserting.
const flush = () => new Promise((r) => setTimeout(r, 10));

test('reaction: 👀 on delivery to a live session', async () => {
  const updates = [{ update_id: 900, message: { message_id: 91, chat: { id: CHAT }, text: '/life-planner go' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(1), reactEmoji: REACT, fetchFn: reactionFetch(updates, reactions),
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 1);
  assert.deepEqual(reactions[0], { chat_id: CHAT, message_id: 91, reaction: [{ type: 'emoji', emoji: '👀' }] });
});

test('reaction: 🤷 when slug is known but no live session (fanout 0)', async () => {
  const updates = [{ update_id: 901, message: { message_id: 92, chat: { id: CHAT }, text: '/life-planner go' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(0), reactEmoji: REACT, fetchFn: reactionFetch(updates, reactions),
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].reaction[0].emoji, '🤷');
  assert.equal(reactions[0].message_id, 92);
});

test('reaction: 🤔 on unmatched (fires even with no agent wired)', async () => {
  const updates = [{ update_id: 902, message: { message_id: 93, chat: { id: CHAT }, text: 'just chatting' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(1), reactEmoji: REACT, fetchFn: reactionFetch(updates, reactions),
    // no onUnmatched
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].reaction[0].emoji, '🤔');
  assert.equal(reactions[0].message_id, 93);
});

test('reaction: disabled (reactEmoji null) fires nothing', async () => {
  const updates = [{ update_id: 903, message: { message_id: 94, chat: { id: CHAT }, text: '/life-planner go' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(1), fetchFn: reactionFetch(updates, reactions), // reactEmoji defaults null
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 0);
});

test('reaction: a per-state null emoji suppresses just that outcome', async () => {
  const updates = [{ update_id: 904, message: { message_id: 95, chat: { id: CHAT }, text: '/life-planner go' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(0), reactEmoji: { ...REACT, dropped: null }, fetchFn: reactionFetch(updates, reactions),
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 0, 'dropped reaction disabled → no call');
});

test('reaction: reserved commands (/status) are never reacted', async () => {
  const updates = [{ update_id: 905, message: { message_id: 96, chat: { id: CHAT }, text: '/status' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(1), reactEmoji: REACT, fetchFn: reactionFetch(updates, reactions),
    onStatusRequest: async () => {},
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 0);
});

test('reaction: a failing reaction is swallowed and never blocks delivery', async () => {
  const updates = [{ update_id: 906, message: { message_id: 97, chat: { id: CHAT }, text: '/life-planner go' } }];
  const target = reactTarget(1);
  const logs = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target, reactEmoji: REACT, log: (m) => logs.push(m),
    fetchFn: reactionFetch(updates, [], { onReact: () => { throw new Error('rate limited'); } }),
  });
  await poller.tick();
  await flush();
  assert.deepEqual(target.delivered, [{ slug: 'life-planner', text: 'go' }], 'delivery still happened');
  assert.ok(logs.some((m) => /reaction failed/.test(m)), 'failure logged, not thrown');
});

test('reaction: deliver() throwing still surfaces 🤷 (not silence)', async () => {
  const updates = [{ update_id: 907, message: { message_id: 98, chat: { id: CHAT }, text: '/life-planner go' } }];
  const reactions = [];
  const logs = [];
  const throwingTarget = {
    deliver() { throw new Error('registry exploded'); },
    knownSlugs() { return new Set(['life-planner']); },
  };
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: throwingTarget, reactEmoji: REACT, log: (m) => logs.push(m),
    fetchFn: reactionFetch(updates, reactions),
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 1, 'a reaction still fires despite the deliver throw');
  assert.equal(reactions[0].reaction[0].emoji, '🤷', 'fanout 0 → dropped');
  assert.ok(logs.some((m) => /deliver failed/.test(m)), 'the throw is logged, not swallowed silently');
});

// ── Broadcast dispatch (#30) ──────────────────────────────────────────────

test('broadcast: dispatches to onBroadcast and reacts 👀 when sessions reached', async () => {
  const updates = [{ update_id: 1000, message: { message_id: 50, chat: { id: CHAT }, text: '/all wrap up' } }];
  const reactions = [];
  const calls = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(1), reactEmoji: REACT, fetchFn: reactionFetch(updates, reactions),
    onBroadcast: async (args) => { calls.push(args); return { count: 3, slugs: ['a', 'b', 'c'] }; },
  });
  await poller.tick();
  await flush();
  assert.deepEqual(calls[0], { text: 'wrap up', messageId: 50, source: 'telegram', quiet: false });
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].reaction[0].emoji, '👀');
  assert.equal(reactions[0].message_id, 50);
});

test('broadcast: reacts 🤷 when no sessions are registered (count 0)', async () => {
  const updates = [{ update_id: 1001, message: { message_id: 51, chat: { id: CHAT }, text: '/all hi' } }];
  const reactions = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: reactTarget(1), reactEmoji: REACT, fetchFn: reactionFetch(updates, reactions),
    onBroadcast: async () => ({ count: 0, slugs: [] }),
  });
  await poller.tick();
  await flush();
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].reaction[0].emoji, '🤷');
});

test('broadcast: no handler wired → logs and drops', async () => {
  const updates = [{ update_id: 1002, message: { message_id: 52, chat: { id: CHAT }, text: '/all hi' } }];
  const logs = [];
  const target = reactTarget(1);
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target, fetchFn: reactionFetch(updates, []), log: (m) => logs.push(m),
  });
  await poller.tick();
  await flush();
  assert.equal(target.delivered.length, 0);
  assert.ok(logs.some((m) => /broadcast dropped/.test(m)));
});

// --- priority gate (#38) ---

test('tick: when preempted, does NOT call getUpdates and stands by', async () => {
  let fetchCalls = 0;
  const fetchFn = async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const owner = { preempts: 0, preempt() { this.preempts++; return { changed: this.preempts === 1, waitMs: 0 }; } };
  const logs = [];
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: fakeTarget(), fetchFn, owner, isPreempted: () => true, log: (m) => logs.push(m),
  });
  await poller.tick();
  assert.equal(fetchCalls, 0, 'getUpdates must not be called while preempted');
  assert.equal(owner.preempts, 1, 'stood down via owner.preempt()');
  assert.ok(logs.some((m) => /higher-priority host owns the bot/.test(m)));
});

test('tick: when NOT preempted, polls normally', async () => {
  let fetchCalls = 0;
  const fetchFn = async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const owner = {
    preempts: 0,
    preempt() { this.preempts++; return { changed: false, waitMs: 0 }; },
    record() { return { changed: false }; }, // the poll-success path records 'ok'
  };
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: fakeTarget(), fetchFn, owner, isPreempted: () => false,
  });
  await poller.tick();
  assert.equal(fetchCalls, 1, 'getUpdates called when not preempted');
  assert.equal(owner.preempts, 0, 'did not stand down');
});

test('tick: no gate wired → polls as before (inert)', async () => {
  let fetchCalls = 0;
  const fetchFn = async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  const poller = new Poller({
    botToken: 'TOKEN', expectedChatId: CHAT, replyTracker: new ReplyTracker(),
    target: fakeTarget(), fetchFn, // no isPreempted
  });
  await poller.tick();
  assert.equal(fetchCalls, 1);
});

test('sanitizeFileName: traversal stripped, charset bounded, null-safe (#41)', async () => {
  const { sanitizeFileName } = await import('../lib/poller.js');
  assert.equal(sanitizeFileName('spec.pdf'), 'spec.pdf');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..\\..\\win.ini'), 'win.ini');
  assert.equal(sanitizeFileName('weird$na%me!.pdf'), 'weird_na_me_.pdf');
  assert.equal(sanitizeFileName('...hidden'), 'hidden');
  assert.equal(sanitizeFileName(''), null);
  assert.equal(sanitizeFileName(null), null);
  assert.equal(sanitizeFileName('x'.repeat(200)).length, 80);
});

test('extractAttachment: photo keeps its fileId even when the local download fails (#41)', async () => {
  const p = new Poller({
    botToken: 't', expectedChatId: 1,
    replyTracker: new ReplyTracker(),
    target: { deliver: () => 1, hasSlug: () => false, knownSlugs: () => new Set() },
    attachmentDir: os.tmpdir(),
    fetchFn: async () => { throw new Error('network down'); },
    log: () => {},
  });
  const att = await p.extractAttachment({ message_id: 5, photo: [{ file_id: 'small' }, { file_id: 'AgBIG' }] });
  assert.equal(att.kind, 'photo');
  assert.equal(att.fileId, 'AgBIG', 'largest size picked, fileId survives the failed download');
  assert.equal(att.imagePath, undefined);
});

test('extractAttachment: document carries fileId + sanitized name (#41)', async () => {
  const p = new Poller({
    botToken: 't', expectedChatId: 1,
    replyTracker: new ReplyTracker(),
    target: { deliver: () => 1, hasSlug: () => false, knownSlugs: () => new Set() },
    attachmentDir: os.tmpdir(),
    fetchFn: async () => { throw new Error('network down'); },
    log: () => {},
  });
  const att = await p.extractAttachment({ message_id: 6, document: { file_id: 'BQdoc', file_name: '../sneaky spec.pdf' } });
  assert.equal(att.kind, 'document');
  assert.equal(att.fileId, 'BQdoc');
  assert.equal(att.name, 'sneaky spec.pdf');
});
