/**
 * Wintermute message-flow tap (#49): off by default, metadata-only events,
 * fire-and-forget egress that never throws into the hot path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTap } from '../lib/wintermute-tap.js';
import { Registry } from '../lib/registry.js';

test('makeTap: null when no url (feature off)', () => {
  assert.equal(makeTap({}), null);
  assert.equal(makeTap({ url: '' }), null);
  assert.equal(makeTap({ url: '   ' }), null);
});

test('makeTap: throws loudly on a non-http url', () => {
  assert.throws(() => makeTap({ url: 'ftp://nope' }), /http\(s\)/);
});

test('tap: POSTs the event with host, ts, and bearer token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const tap = makeTap({ url: 'http://conductor:3300/api/tap/belfry', host: 'j', token: 'sekrit', fetchImpl });
  tap('send_to', { from: 'a', to: 'b', delivered: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://conductor:3300/api/tap/belfry');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sekrit');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.v, 1);
  assert.equal(body.kind, 'send_to');
  assert.equal(body.host, 'j');
  assert.equal(body.from, 'a');
  assert.ok(typeof body.ts === 'number');
});

test('tap: a rejecting fetch never throws into the caller', async () => {
  const logs = [];
  const tap = makeTap({
    url: 'http://down:1/x',
    fetchImpl: async () => { throw new Error('boom'); },
    log: (m) => logs.push(m),
  });
  assert.doesNotThrow(() => tap('deliver', { to: 'x' }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(logs.some((l) => l.includes('boom')));
});

test('registry: deliver/broadcast/relay emit metadata-only tap events', async () => {
  const events = [];
  const registry = new Registry({ log: () => {} });
  registry.setTap((kind, fields) => events.push({ kind, ...fields }));

  // No live instances — deliver and relay still emit (delivered: 0).
  registry.deliver('alpha', 'hello there', null, null);
  registry.relayAgentMessage('alpha', 'beta', 'psst');
  registry.broadcast('all hands');

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['deliver', 'send_to', 'broadcast']);
  assert.equal(events[0].to, 'alpha');
  assert.equal(events[0].delivered, 0);
  assert.equal(events[0].chars, 'hello there'.length);
  assert.equal(events[1].from, 'alpha');
  assert.equal(events[1].to, 'beta');
  // The privacy invariant: no event carries message text.
  for (const e of events) {
    assert.equal('text' in e, false);
    assert.ok(!JSON.stringify(e).includes('hello there'));
  }
});

test('registry: no tap wired → identical behavior, no throw', () => {
  const registry = new Registry({ log: () => {} });
  assert.doesNotThrow(() => {
    registry.deliver('alpha', 'hi');
    registry.broadcast('yo');
    registry.relayAgentMessage('a', 'b', 'c');
  });
});
