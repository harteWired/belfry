import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeAutoReply } from '../lib/auto-reply.js';

function makeStubs(initialPending = null) {
  let pending = initialPending;
  const sent = [];
  return {
    getOwesReply: () => pending,
    clearOwesReply: () => { pending = null; },
    setOwesReply: (id) => { pending = id; },
    pending: () => pending,
    sendOutbound: async (args) => {
      sent.push(args);
      return { message_id: 9001 };
    },
    sent,
  };
}

test('returns false and does nothing when no pending reply marker', () => {
  const s = makeStubs(null);
  const fired = maybeAutoReply({
    slug: 'x',
    statusFile: { status: 'ready', last_response: 'hello' },
    prevStatusFile: null,
    newStatus: 'ready',
    ...s,
  });
  assert.equal(fired, false);
  assert.equal(s.sent.length, 0);
});

test('returns false when newStatus is not ready', () => {
  const s = makeStubs(42);
  const fired = maybeAutoReply({
    slug: 'x',
    statusFile: { status: 'working', last_response: 'mid-turn output' },
    prevStatusFile: null,
    newStatus: 'working',
    ...s,
  });
  assert.equal(fired, false);
  assert.equal(s.sent.length, 0);
  assert.equal(s.pending(), 42, 'marker still present — turn not done yet');
});

test('returns false when last_response is missing or empty', () => {
  const s = makeStubs(42);
  for (const lr of [undefined, '', 123]) {
    const fired = maybeAutoReply({
      slug: 'x',
      statusFile: { status: 'ready', last_response: lr },
      prevStatusFile: null,
      newStatus: 'ready',
      ...s,
    });
    assert.equal(fired, false);
  }
  assert.equal(s.sent.length, 0);
  assert.equal(s.pending(), 42);
});

test('returns false when last_response is unchanged from previous (duplicate event)', () => {
  const s = makeStubs(42);
  const fired = maybeAutoReply({
    slug: 'x',
    statusFile: { status: 'ready', last_response: 'same answer' },
    prevStatusFile: { status: 'ready', last_response: 'same answer' },
    newStatus: 'ready',
    ...s,
  });
  assert.equal(fired, false);
  assert.equal(s.sent.length, 0);
  assert.equal(s.pending(), 42, 'marker preserved — real ready transition may still come');
});

test('fires sendOutbound and clears marker on fresh response in ready state', async () => {
  const s = makeStubs(42);
  const fired = maybeAutoReply({
    slug: 'auto-slug',
    statusFile: { status: 'ready', last_response: 'final answer' },
    prevStatusFile: { status: 'working', last_response: 'partial draft' },
    newStatus: 'ready',
    ...s,
  });
  assert.equal(fired, true);
  // sendOutbound is fire-and-forget; await one microtask tick.
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0], {
    slug: 'auto-slug',
    text: 'final answer',
    replyToMessageId: 42,
  });
  assert.equal(s.pending(), null, 'marker cleared synchronously to prevent double-send');
});

test('clears marker synchronously before the network call to prevent double-fire', () => {
  const s = makeStubs(42);
  const fired = maybeAutoReply({
    slug: 'race-slug',
    statusFile: { status: 'ready', last_response: 'A' },
    prevStatusFile: { status: 'working' },
    newStatus: 'ready',
    ...s,
  });
  assert.equal(fired, true);
  // Critically: marker is null *immediately*, not after the await resolves.
  assert.equal(s.pending(), null);

  // Simulate a second concurrent invocation arriving before sendOutbound
  // resolves: it must see no pending and no-op.
  const fired2 = maybeAutoReply({
    slug: 'race-slug',
    statusFile: { status: 'ready', last_response: 'B' },
    prevStatusFile: { status: 'ready', last_response: 'A' },
    newStatus: 'ready',
    ...s,
  });
  assert.equal(fired2, false, 'second invocation observes null pending');
});

test('truncates oversized responses to ~4000 chars with ellipsis', async () => {
  const s = makeStubs(42);
  const big = 'x'.repeat(10_000);
  maybeAutoReply({
    slug: 'big',
    statusFile: { status: 'ready', last_response: big },
    prevStatusFile: null,
    newStatus: 'ready',
    ...s,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 1);
  const text = s.sent[0].text;
  assert.ok(text.length <= 4000, `text length ${text.length} exceeds cap`);
  assert.ok(text.endsWith('…'), 'truncated text ends with ellipsis');
});

test('logs and does not throw when sendOutbound rejects', async () => {
  let pending = 42;
  const logs = [];
  const fired = maybeAutoReply({
    slug: 'failing',
    statusFile: { status: 'ready', last_response: 'hi' },
    prevStatusFile: null,
    newStatus: 'ready',
    getOwesReply: () => pending,
    clearOwesReply: () => { pending = null; },
    sendOutbound: async () => { throw new Error('telegram down'); },
    log: (m) => logs.push(m),
  });
  assert.equal(fired, true);
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((m) => m.includes('auto-reply failed')), `expected failure log; got ${JSON.stringify(logs)}`);
});
