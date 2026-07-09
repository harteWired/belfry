import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, parseEnvelope, ENVELOPE_VERSION } from '../lib/federation-envelope.js';

const from = { host: 'd', slug: 'api' };
const to = { host: 'n', slug: 'life-planner' };

test('builds a message envelope with version and timestamp', () => {
  const e = buildEnvelope({ kind: 'message', from, to, text: 'hi', ts: 123 });
  assert.deepEqual(e, { v: ENVELOPE_VERSION, kind: 'message', from, to, text: 'hi', ts: 123 });
});

test('message carries correlationId when a reply is expected', () => {
  const e = buildEnvelope({ kind: 'message', from, to, text: 'q', correlationId: 'abc', ts: 1 });
  assert.equal(e.correlationId, 'abc');
});

test('reply requires a correlationId', () => {
  assert.throws(() => buildEnvelope({ kind: 'reply', from, to, text: 'a', ts: 1 }), /correlationId is required/);
  const e = buildEnvelope({ kind: 'reply', from, to, text: 'a', correlationId: 'abc', ts: 1 });
  assert.equal(e.kind, 'reply');
  assert.equal(e.correlationId, 'abc');
});

test('announce carries host + slugs, no to/text', () => {
  const e = buildEnvelope({ kind: 'announce', from: { host: 'd' }, slugs: ['api', 'belfry'], ts: 5 });
  assert.deepEqual(e, { v: ENVELOPE_VERSION, kind: 'announce', from: { host: 'd' }, slugs: ['api', 'belfry'], ts: 5 });
});

test('announce carries reachableAt when set, omits it otherwise (#38)', () => {
  const withTs = buildEnvelope({ kind: 'announce', from: { host: 'd' }, slugs: ['api'], reachableAt: 999, ts: 5 });
  assert.equal(withTs.reachableAt, 999);
  // round-trips on the wire
  const parsed = parseEnvelope(JSON.parse(JSON.stringify(withTs)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.envelope.reachableAt, 999);
  // absent / non-positive → field omitted entirely
  const without = buildEnvelope({ kind: 'announce', from: { host: 'd' }, slugs: ['api'], ts: 5 });
  assert.equal('reachableAt' in without, false);
  const zero = buildEnvelope({ kind: 'announce', from: { host: 'd' }, slugs: ['api'], reachableAt: 0, ts: 5 });
  assert.equal('reachableAt' in zero, false);
});

test('rejects unknown kinds and malformed endpoints', () => {
  assert.throws(() => buildEnvelope({ kind: 'bogus', from, to, text: 'x' }), /unknown kind/);
  assert.throws(() => buildEnvelope({ kind: 'message', from: { host: 'dd', slug: 'a' }, to, text: 'x' }), /from must be/);
  assert.throws(() => buildEnvelope({ kind: 'message', from, to: { host: 'n' }, text: 'x' }), /to must be/);
  assert.throws(() => buildEnvelope({ kind: 'message', from, to, text: '' }), /text must be/);
  assert.throws(() => buildEnvelope({ kind: 'announce', from: { host: 'd' }, slugs: 'nope' }), /slugs must be an array/);
});

test('round-trips through JSON via parseEnvelope', () => {
  const built = buildEnvelope({ kind: 'message', from, to, text: 'hi', correlationId: 'c1', ts: 7 });
  const wire = JSON.stringify(built);
  const parsed = parseEnvelope(wire);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.envelope, built);
});

test('parseEnvelope rejects bad JSON, wrong version, and invalid shape (no throw)', () => {
  assert.deepEqual(parseEnvelope('{not json').ok, false);
  assert.equal(parseEnvelope({ v: 999, kind: 'message', from, to, text: 'x' }).ok, false);
  assert.equal(parseEnvelope({ v: ENVELOPE_VERSION, kind: 'message', from, to, text: '' }).ok, false);
  const r = parseEnvelope(42);
  assert.equal(r.ok, false);
});

test('parseEnvelope preserves broadcast flag and ts', () => {
  const built = buildEnvelope({ kind: 'message', from, to, text: 'all', broadcast: true, ts: 99 });
  const parsed = parseEnvelope(JSON.stringify(built));
  assert.equal(parsed.envelope.broadcast, true);
  assert.equal(parsed.envelope.ts, 99);
});

// ── inbound kind: human Telegram message forwarded owner→owning-host (#38 Phase 2)
test('builds + round-trips an inbound envelope with Telegram context', () => {
  const env = buildEnvelope({
    kind: 'inbound', from: { host: 'j' }, to: { host: 'e', slug: 'erebus-master' },
    text: 'hi from matt', correlationId: 'corr-1', chatId: 8471234222, originatingMessageId: 3100,
  });
  assert.equal(env.kind, 'inbound');
  assert.equal(env.from.host, 'j');
  assert.deepEqual(env.to, { host: 'e', slug: 'erebus-master' });
  assert.equal(env.chatId, 8471234222);
  assert.equal(env.originatingMessageId, 3100);
  const p = parseEnvelope(JSON.stringify(env));
  assert.ok(p.ok);
  assert.equal(p.envelope.correlationId, 'corr-1');
  assert.equal(p.envelope.chatId, 8471234222);
});

test('inbound requires correlationId, chatId, originatingMessageId', () => {
  const base = { kind: 'inbound', from: { host: 'j' }, to: { host: 'e', slug: 'x' }, text: 'hi' };
  assert.throws(() => buildEnvelope({ ...base, chatId: 1, originatingMessageId: 2 }), /correlationId/);
  assert.throws(() => buildEnvelope({ ...base, correlationId: 'c', originatingMessageId: 2 }), /chatId/);
  assert.throws(() => buildEnvelope({ ...base, correlationId: 'c', chatId: 1 }), /originatingMessageId/);
});

// ── replymap kind: reply-tracker anchor gossiped to peers (#38 Fornax-flip)
test('builds + round-trips a replymap envelope (host + messageId + slug, no to/text)', () => {
  const env = buildEnvelope({ kind: 'replymap', from: { host: 'j' }, messageId: 5001, slug: 'api', ts: 11 });
  assert.deepEqual(env, { v: ENVELOPE_VERSION, kind: 'replymap', from: { host: 'j' }, messageId: 5001, slug: 'api', ts: 11 });
  const p = parseEnvelope(JSON.stringify(env));
  assert.equal(p.ok, true);
  assert.deepEqual(p.envelope, env);
});

test('replymap requires from.host, an integer messageId, and a non-empty slug', () => {
  assert.throws(() => buildEnvelope({ kind: 'replymap', from: { host: 'jj' }, messageId: 1, slug: 'a' }), /from\.host must be/);
  assert.throws(() => buildEnvelope({ kind: 'replymap', from: { host: 'j' }, messageId: 1.5, slug: 'a' }), /messageId must be an integer/);
  assert.throws(() => buildEnvelope({ kind: 'replymap', from: { host: 'j' }, messageId: null, slug: 'a' }), /messageId must be an integer/);
  assert.throws(() => buildEnvelope({ kind: 'replymap', from: { host: 'j' }, messageId: 1, slug: '' }), /slug must be a non-empty string/);
});

test('parseEnvelope rejects a replymap with a non-integer messageId on the wire (no throw)', () => {
  const r = parseEnvelope({ v: ENVELOPE_VERSION, kind: 'replymap', from: { host: 'j' }, messageId: 'x', slug: 'api', ts: 1 });
  assert.equal(r.ok, false);
});

test('broadcast envelope: builds with from identity + optional filters', () => {
  const env = buildEnvelope({ kind: 'broadcast', from: { host: 'w', slug: 'wintermute' }, text: 'fleet: status', targetSlugs: ['alpha'], ts: 5 });
  assert.deepEqual(env, { v: 1, kind: 'broadcast', from: { host: 'w', slug: 'wintermute' }, text: 'fleet: status', targetSlugs: ['alpha'], ts: 5 });
  // Round-trips through parseEnvelope with filters intact.
  const parsed = parseEnvelope(JSON.stringify(env));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.envelope.targetSlugs, ['alpha']);
});

test('broadcast envelope: rejects missing text, bad from, malformed filters', () => {
  assert.throws(() => buildEnvelope({ kind: 'broadcast', from: { host: 'w', slug: 'x' } }), /text/);
  assert.throws(() => buildEnvelope({ kind: 'broadcast', from: { host: 'ww', slug: 'x' }, text: 'hi' }), /from/);
  assert.throws(() => buildEnvelope({ kind: 'broadcast', from: { host: 'w', slug: 'x' }, text: 'hi', targetSlugs: [42] }), /targetSlugs/);
  const parsed = parseEnvelope({ v: 1, kind: 'broadcast', from: { host: 'w' }, text: 'hi', ts: 1 });
  assert.equal(parsed.ok, false);
});
