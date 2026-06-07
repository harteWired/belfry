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
