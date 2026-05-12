import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeBrainHandlers } from '../lib/brain-handlers.js';
import { NicknameRegistry } from '../lib/nicknames.js';
import { RecentMessages } from '../lib/recent-messages.js';

function fakeWatcher(activeSlugs = ['belfry'], lastSeenMap = {}) {
  return {
    getActiveSlugsFromCache: () => new Set(activeSlugs),
    lastSeen: { get: (slug) => lastSeenMap[slug] },
  };
}

function fakeRegistry() {
  const calls = [];
  return {
    delivered: calls,
    deliver(slug, body, msgId, attachment) {
      calls.push({ slug, body, msgId, attachment });
      return calls.length;
    },
  };
}

function fakeSender() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { message_id: 7000 + calls.length };
  };
  fn.calls = calls;
  return fn;
}

const baseDeps = (overrides = {}) => ({
  watcher: fakeWatcher(),
  recentMessages: new RecentMessages(),
  nicknames: new NicknameRegistry({ getActiveSlugs: () => new Set(['belfry']) }),
  registry: fakeRegistry(),
  sendTelegram: fakeSender(),
  ...overrides,
});

test('listSessions: returns active slugs with last-outbound metadata', () => {
  const recent = new RecentMessages();
  recent.push('belfry', { kind: 'event', text: 'x', ts: 12345 });
  const h = makeBrainHandlers(baseDeps({ recentMessages: recent }));
  const out = h.listSessions();
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, 'belfry');
  assert.equal(out[0].last_outbound_kind, 'event');
  assert.equal(out[0].last_outbound_ts, 12345);
});

test('getSession: returns cached status JSON for active slug', () => {
  const status = { status: 'ready', last_response: 'hello' };
  const watcher = fakeWatcher(['belfry'], { belfry: status });
  const h = makeBrainHandlers(baseDeps({ watcher }));
  assert.deepEqual(h.getSession({ slug: 'belfry' }), status);
});

test('getSession: error when slug not active', () => {
  const h = makeBrainHandlers(baseDeps());
  const out = h.getSession({ slug: 'nonexistent' });
  assert.match(out.error, /no active session/);
});

test('getSession: throws when slug missing from args', () => {
  const h = makeBrainHandlers(baseDeps());
  assert.throws(() => h.getSession({}), /slug required/);
});

test('recentMessages: returns empty when no history; n is honored', () => {
  const recent = new RecentMessages();
  for (let i = 0; i < 5; i++) recent.push('belfry', { kind: 'event', text: `m${i}`, ts: i });
  const h = makeBrainHandlers(baseDeps({ recentMessages: recent }));
  assert.equal(h.recentMessages({ slug: 'belfry', n: 3 }).length, 3);
  assert.equal(h.recentMessages({ slug: 'unknown', n: 10 }).length, 0);
});

test('nicknames: returns the current map', () => {
  const nicks = new NicknameRegistry({ getActiveSlugs: () => new Set(['belfry']) });
  nicks.set('b', 'belfry');
  const h = makeBrainHandlers(baseDeps({ nicknames: nicks }));
  assert.deepEqual(h.nicknames(), { b: 'belfry' });
});

test('help: returns canonical text for known topic', () => {
  const h = makeBrainHandlers(baseDeps());
  const out = h.help({ topic: 'nicknames' });
  assert.match(out.text, /\/nick/);
});

test('help: returns error object for unknown topic', () => {
  const h = makeBrainHandlers(baseDeps());
  const out = h.help({ topic: 'mystery' });
  assert.match(out.error, /unknown help topic/);
});

test('deliver: forwards to registry, returns fanout count', () => {
  const reg = fakeRegistry();
  const h = makeBrainHandlers(baseDeps({ registry: reg }));
  const out = h.deliver({ slug: 'belfry', body: 'do thing', reply_to_message_id: 42 });
  assert.equal(out.fanout, 1);
  assert.deepEqual(reg.delivered, [{ slug: 'belfry', body: 'do thing', msgId: 42, attachment: null }]);
});

test('deliver: throws when slug or body missing', () => {
  const h = makeBrainHandlers(baseDeps());
  assert.throws(() => h.deliver({ body: 'x' }), /slug required/);
  assert.throws(() => h.deliver({ slug: 'belfry' }), /body required/);
});

test('reply: sends to telegram, returns message_id', async () => {
  const send = fakeSender();
  const h = makeBrainHandlers(baseDeps({ sendTelegram: send }));
  const out = await h.reply({ text: 'hi back', reply_to_message_id: 99 });
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, 'hi back');
  assert.equal(send.calls[0].replyToMessageId, 99);
  assert.equal(out.message_id, 7001);
});

test('reply: truncates oversized text at Telegram cap', async () => {
  const send = fakeSender();
  const h = makeBrainHandlers(baseDeps({ sendTelegram: send }));
  await h.reply({ text: 'x'.repeat(5000) });
  assert.equal(send.calls[0].text.length, 4096);
  assert.equal(send.calls[0].text.endsWith('…'), true);
});

test('decline: sends a polite Telegram message and returns sent flag', async () => {
  const send = fakeSender();
  const h = makeBrainHandlers(baseDeps({ sendTelegram: send }));
  const out = await h.decline({ message: 'cannot help with that', reply_to_message_id: 50 });
  assert.equal(out.sent, true);
  assert.equal(send.calls[0].text, 'cannot help with that');
  assert.equal(send.calls[0].replyToMessageId, 50);
});

test('action flag: starts false, set by deliver, reset by resetActionFlag', () => {
  const h = makeBrainHandlers(baseDeps());
  assert.equal(h.didActionFire(), false, 'flag starts false');
  h.deliver({ slug: 'belfry', body: 'forward', reply_to_message_id: 10 });
  assert.equal(h.didActionFire(), true, 'deliver sets the flag');
  h.resetActionFlag();
  assert.equal(h.didActionFire(), false, 'reset clears the flag');
});

test('action flag: set by reply tool', async () => {
  const h = makeBrainHandlers(baseDeps());
  h.resetActionFlag();
  await h.reply({ text: 'hello', reply_to_message_id: 11 });
  assert.equal(h.didActionFire(), true);
});

test('action flag: set by decline tool', async () => {
  const h = makeBrainHandlers(baseDeps());
  h.resetActionFlag();
  await h.decline({ message: 'no', reply_to_message_id: 12 });
  assert.equal(h.didActionFire(), true);
});

test('action flag: NOT set by read-only tools', () => {
  const h = makeBrainHandlers(baseDeps());
  h.resetActionFlag();
  h.listSessions();
  h.getSession({ slug: 'belfry' });
  h.recentMessages({ slug: 'belfry' });
  h.nicknames();
  assert.equal(h.didActionFire(), false);
});
