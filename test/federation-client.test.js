import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FederationClient } from '../lib/federation-client.js';
import { buildEnvelope } from '../lib/federation-envelope.js';

const peer = { letter: 'e', name: 'Erebus', addr: 'http://erebus.example:49877' };
const msg = buildEnvelope({ kind: 'message', from: { host: 'j', slug: 'api' }, to: { host: 'e', slug: 'build' }, text: 'hi', ts: 1 });

function mockFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  fn.calls = calls;
  return fn;
}

test('routes by envelope kind and sends JSON with the bearer token', async () => {
  const fetchImpl = mockFetch(async () => ({ ok: true, status: 200, text: async () => 'ok' }));
  const c = new FederationClient({ token: 'sek', fetchImpl });
  const r = await c.send(peer, msg);
  assert.equal(r.ok, true);
  assert.equal(fetchImpl.calls[0].url, 'http://erebus.example:49877/fed/message');
  assert.equal(fetchImpl.calls[0].opts.method, 'POST');
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer sek');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].opts.body), msg);
});

test('announce and reply hit their own routes', async () => {
  const fetchImpl = mockFetch(async () => ({ ok: true, status: 200, text: async () => '' }));
  const c = new FederationClient({ token: 't', fetchImpl });
  await c.send(peer, buildEnvelope({ kind: 'announce', from: { host: 'j' }, slugs: ['api'], ts: 1 }));
  await c.send(peer, buildEnvelope({ kind: 'reply', from: { host: 'j', slug: 'api' }, to: { host: 'e', slug: 'b' }, text: 'r', correlationId: 'c1', ts: 1 }));
  assert.ok(fetchImpl.calls[0].url.endsWith('/fed/announce'));
  assert.ok(fetchImpl.calls[1].url.endsWith('/fed/reply'));
});

test('omits the auth header when no token configured', async () => {
  const fetchImpl = mockFetch(async () => ({ ok: true, status: 200, text: async () => '' }));
  await new FederationClient({ fetchImpl }).send(peer, msg);
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, undefined);
});

test('a non-ok response is a best-effort failure result, not a throw', async () => {
  const fetchImpl = mockFetch(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
  const r = await new FederationClient({ token: 't', fetchImpl }).send(peer, msg);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /401/);
});

test('a fetch throw (peer offline) is captured as a failure result', async () => {
  const fetchImpl = mockFetch(async () => { throw new Error('connect ECONNREFUSED'); });
  const r = await new FederationClient({ token: 't', fetchImpl }).send(peer, msg);
  assert.equal(r.ok, false);
  assert.match(r.error, /unreachable|ECONNREFUSED/);
});

test('an unsendable envelope kind fails without a network call', async () => {
  const fetchImpl = mockFetch(async () => ({ ok: true, status: 200, text: async () => '' }));
  const r = await new FederationClient({ token: 't', fetchImpl }).send(peer, { kind: 'bogus' });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});
