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
