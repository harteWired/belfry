import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FederationServer } from '../lib/federation-server.js';
import { FederationClient } from '../lib/federation-client.js';
import { buildEnvelope } from '../lib/federation-envelope.js';

const TOKEN = 'mesh-secret';
let server, baseUrl;
const received = { announce: [], message: [], reply: [] };

before(async () => {
  server = new FederationServer({
    port: 0,
    bind: '127.0.0.1',
    token: TOKEN,
    onAnnounce: async (env) => { received.announce.push(env); return { applied: true }; },
    onMessage: async (env) => { received.message.push(env); return { delivered: 1 }; },
    onReply: async (env) => { received.reply.push(env); },
  });
  await server.start();
  baseUrl = `http://127.0.0.1:${server.port}`;
});
after(async () => { await server.stop(); });

const announce = buildEnvelope({ kind: 'announce', from: { host: 'j' }, slugs: ['api', 'belfry'], ts: 1 });
const message = buildEnvelope({ kind: 'message', from: { host: 'j', slug: 'api' }, to: { host: 'e', slug: 'build' }, text: 'hi', ts: 1 });

const post = (path, body, { token = TOKEN, ct = 'application/json' } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': ct, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('constructor fails closed without a token', () => {
  assert.throws(() => new FederationServer({ port: 0 }), /requires a bearer token/);
});

test('routes a valid announce to onAnnounce and returns the handler result', async () => {
  const res = await post('/fed/announce', announce);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, applied: true });
  assert.deepEqual(received.announce.at(-1), announce);
});

test('routes a valid message to onMessage', async () => {
  const res = await post('/fed/message', message);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered: 1 });
  assert.deepEqual(received.message.at(-1), message);
});

test('rejects a missing/wrong bearer token with 401', async () => {
  assert.equal((await post('/fed/announce', announce, { token: null })).status, 401);
  assert.equal((await post('/fed/announce', announce, { token: 'wrong' })).status, 401);
});

test('rejects non-JSON content type (415) and non-POST (405)', async () => {
  assert.equal((await post('/fed/announce', 'x', { ct: 'text/plain' })).status, 415);
  const get = await fetch(`${baseUrl}/fed/announce`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(get.status, 405);
});

test('unknown route is 404', async () => {
  assert.equal((await post('/fed/nope', announce)).status, 404);
});

test('a kind/route mismatch is rejected (400)', async () => {
  // announce envelope posted to the message route
  const res = await post('/fed/message', announce);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not match route/);
});

test('a malformed / invalid envelope is rejected (400)', async () => {
  assert.equal((await post('/fed/announce', '{bad json')).status, 400);
  // valid JSON, invalid envelope (message with empty text)
  const bad = { v: 1, kind: 'message', from: { host: 'j', slug: 'a' }, to: { host: 'e', slug: 'b' }, text: '' };
  assert.equal((await post('/fed/message', bad)).status, 400);
});

test('a throwing handler surfaces as 400 ok:false', async () => {
  const s = new FederationServer({ port: 0, token: TOKEN, onMessage: async () => { throw new Error('boom'); } });
  await s.start();
  const res = await fetch(`http://127.0.0.1:${s.port}/fed/message`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(message),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  await s.stop();
});

test('round-trips via FederationClient over the real server', async () => {
  const client = new FederationClient({ token: TOKEN });
  const peer = { letter: 'x', addr: baseUrl };
  const r = await client.send(peer, message);
  assert.equal(r.ok, true);
  assert.deepEqual(received.message.at(-1), message);
});

test('FederationClient with a bad token is rejected by the server', async () => {
  const r = await new FederationClient({ token: 'nope' }).send({ letter: 'x', addr: baseUrl }, announce);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});
