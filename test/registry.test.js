import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../lib/registry.js';

let registry;
let baseUrl;

before(async () => {
  registry = new Registry({ port: 0, recvTimeoutMs: 200 });
  await registry.start();
  baseUrl = `http://127.0.0.1:${registry.port}`;
});

after(async () => {
  await registry.stop();
});

async function post(pathname, body) {
  return await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('register stores the instance and indexes by slug', async () => {
  const res = await post('/register', { instance_id: 'i1', slug: 'belfry', cwd: '/x', pid: 123 });
  assert.equal(res.status, 200);
  assert.deepEqual([...registry.knownSlugs()], ['belfry']);
  await post('/unregister', { instance_id: 'i1' });
});

test('unregister cleans up slug index when last instance leaves', async () => {
  await post('/register', { instance_id: 'a', slug: 'x', cwd: '/x' });
  await post('/register', { instance_id: 'b', slug: 'x', cwd: '/x' });
  assert.equal(registry.bySlug.get('x').size, 2);
  await post('/unregister', { instance_id: 'a' });
  assert.equal(registry.bySlug.get('x').size, 1);
  await post('/unregister', { instance_id: 'b' });
  assert.equal(registry.bySlug.has('x'), false);
});

test('deliver pushes text to all instances of a slug', async () => {
  await post('/register', { instance_id: 'a', slug: 's', cwd: '/x' });
  await post('/register', { instance_id: 'b', slug: 's', cwd: '/x' });
  const n = registry.deliver('s', 'hello');
  assert.equal(n, 2);
  // Pull from each.
  const ra = await fetch(`${baseUrl}/recv?instance_id=a`);
  const rb = await fetch(`${baseUrl}/recv?instance_id=b`);
  assert.deepEqual(await ra.json(), { text: 'hello' });
  assert.deepEqual(await rb.json(), { text: 'hello' });
  await post('/unregister', { instance_id: 'a' });
  await post('/unregister', { instance_id: 'b' });
});

test('deliver returns 0 when no instances are registered for the slug', async () => {
  const n = registry.deliver('ghost', 'noop');
  assert.equal(n, 0);
});

test('deliver passes attachment imagePath through /recv as image_path', async () => {
  await post('/register', { instance_id: 'imga', slug: 'imgslug', cwd: '/x' });
  const n = registry.deliver('imgslug', 'screenshot', null, { imagePath: '/tmp/foo.jpg' });
  assert.equal(n, 1);
  const r = await fetch(`${baseUrl}/recv?instance_id=imga`);
  assert.deepEqual(await r.json(), { text: 'screenshot', image_path: '/tmp/foo.jpg' });
  await post('/unregister', { instance_id: 'imga' });
});

test('deliver without attachment yields plain { text } recv envelope', async () => {
  await post('/register', { instance_id: 'pa', slug: 'plainslug', cwd: '/x' });
  registry.deliver('plainslug', 'just text');
  const r = await fetch(`${baseUrl}/recv?instance_id=pa`);
  const body = await r.json();
  assert.equal(body.text, 'just text');
  assert.equal(body.image_path, undefined);
  assert.equal(body.voice_path, undefined);
  await post('/unregister', { instance_id: 'pa' });
});

test('recv long-polls and returns text once deliver fires', async () => {
  await post('/register', { instance_id: 'p', slug: 'q', cwd: '/x' });
  const recvP = fetch(`${baseUrl}/recv?instance_id=p`);
  // Fire deliver shortly after recv starts, before timeout.
  setTimeout(() => registry.deliver('q', 'wakey'), 30);
  const res = await recvP;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: 'wakey' });
  await post('/unregister', { instance_id: 'p' });
});

test('recv returns 204 on timeout when nothing arrives', async () => {
  await post('/register', { instance_id: 't', slug: 'y', cwd: '/x' });
  const res = await fetch(`${baseUrl}/recv?instance_id=t`);
  assert.equal(res.status, 204);
  await post('/unregister', { instance_id: 't' });
});

test('recv returns 404 for unknown instance_id', async () => {
  const res = await fetch(`${baseUrl}/recv?instance_id=nope`);
  assert.equal(res.status, 404);
});

test('rejects requests with non-loopback Host header', async () => {
  // fetch() forbids overriding Host, but the registry's own check still
  // exercises with a localhost-bound request that just happens to have a
  // mismatched port-Host header.
  const { request: httpRequest } = await import('node:http');
  const res = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: registry.port,
        method: 'POST',
        path: '/register',
        headers: {
          'content-type': 'application/json',
          'host': `attacker.com:${registry.port}`,
        },
      },
      (r) => {
        r.on('data', () => {});
        r.on('end', () => resolve({ status: r.statusCode }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify({ instance_id: 'x', slug: 'x' }));
    req.end();
  });
  assert.equal(res.status, 403);
});

test('queue drains FIFO when multiple deliveries land before recv', async () => {
  await post('/register', { instance_id: 'm', slug: 'mq', cwd: '/x' });
  registry.deliver('mq', 'first');
  registry.deliver('mq', 'second');
  const r1 = await fetch(`${baseUrl}/recv?instance_id=m`);
  assert.deepEqual(await r1.json(), { text: 'first' });
  const r2 = await fetch(`${baseUrl}/recv?instance_id=m`);
  assert.deepEqual(await r2.json(), { text: 'second' });
  await post('/unregister', { instance_id: 'm' });
});

test('deliver with originatingMessageId marks pending reply when an instance is registered', async () => {
  registry.clearOwesReply('pen');
  await post('/register', { instance_id: 'penny', slug: 'pen', cwd: '/x' });
  registry.deliver('pen', 'inbound', 4242);
  assert.equal(registry.getOwesReply('pen'), 4242);
  // Drain the queue + clean up.
  await fetch(`${baseUrl}/recv?instance_id=penny`);
  registry.clearOwesReply('pen');
  await post('/unregister', { instance_id: 'penny' });
});

test('deliver does NOT mark pending reply when no instance is registered for the slug', () => {
  // Phantom auto-reply guard: dropping an inbound must not leave a marker
  // that a later, unrelated `ready` transition would consume.
  registry.clearOwesReply('ghost-slug');
  const n = registry.deliver('ghost-slug', 'inbound', 9999);
  assert.equal(n, 0);
  assert.equal(registry.getOwesReply('ghost-slug'), null);
});

test('/send proxies to onSend callback and clears the pending marker', async () => {
  const calls = [];
  const reg = new Registry({
    port: 0,
    recvTimeoutMs: 200,
    onSend: async ({ slug, text, replyToMessageId }) => {
      calls.push({ slug, text, replyToMessageId });
      return { message_id: 555 };
    },
  });
  await reg.start();
  const url = `http://127.0.0.1:${reg.port}`;
  await fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'sx', slug: 'send-slug', cwd: '/x' }),
  });
  // Mark pending so /send picks it up as the implicit reply target.
  reg.markOwesReply('send-slug', 808);
  const res = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'sx', text: 'hi back' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message_id: 555 });
  assert.deepEqual(calls, [{ slug: 'send-slug', text: 'hi back', replyToMessageId: 808 }]);
  // Pending marker should be cleared after a successful explicit /send.
  assert.equal(reg.getOwesReply('send-slug'), null);
  await reg.stop();
});

test('/send returns 404 for unknown instance', async () => {
  const reg = new Registry({ port: 0, recvTimeoutMs: 200, onSend: async () => ({ message_id: 1 }) });
  await reg.start();
  const url = `http://127.0.0.1:${reg.port}`;
  const res = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'nope', text: 'x' }),
  });
  assert.equal(res.status, 404);
  await reg.stop();
});

test('/send returns 503 when onSend is not configured', async () => {
  // Default `registry` fixture has no onSend.
  await post('/register', { instance_id: 'no-send', slug: 'ns', cwd: '/x' });
  const res = await fetch(`${baseUrl}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'no-send', text: 'x' }),
  });
  assert.equal(res.status, 503);
  await post('/unregister', { instance_id: 'no-send' });
});

test('/send returns 502 when onSend throws', async () => {
  const reg = new Registry({
    port: 0,
    recvTimeoutMs: 200,
    onSend: async () => { throw new Error('telegram down'); },
  });
  await reg.start();
  const url = `http://127.0.0.1:${reg.port}`;
  await fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'th', slug: 'th-slug', cwd: '/x' }),
  });
  const res = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'th', text: 'x' }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  await reg.stop();
});

test('/send rejects empty text and oversized text', async () => {
  const reg = new Registry({ port: 0, recvTimeoutMs: 200, onSend: async () => ({ message_id: 1 }) });
  await reg.start();
  const url = `http://127.0.0.1:${reg.port}`;
  await fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'lim', slug: 'lim-slug', cwd: '/x' }),
  });
  const empty = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'lim', text: '' }),
  });
  assert.equal(empty.status, 400);
  const big = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'lim', text: 'x'.repeat(5000) }),
  });
  assert.equal(big.status, 413);
  await reg.stop();
});

test('pending reply marker has TTL and is cleared by clearOwesReply', () => {
  registry.markOwesReply('ttl-slug', 11);
  assert.equal(registry.getOwesReply('ttl-slug'), 11);
  registry.clearOwesReply('ttl-slug');
  assert.equal(registry.getOwesReply('ttl-slug'), null);
});
