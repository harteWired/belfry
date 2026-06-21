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
  // MAX_SEND_TEXT_LEN is now 64 KiB (raised from 4096 once the daemon
  // started packing oversized replies). The 413 still guards against a
  // runaway payload — use something well past the new ceiling.
  const big = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'lim', text: 'x'.repeat(70 * 1024) }),
  });
  // The per-request body cap (80 KiB) sits above the text cap, so 70 KiB
  // of payload makes it through the body read and trips the explicit
  // length check inside handleSend — 413 either way.
  assert.equal(big.status, 413);
  await reg.stop();
});

test('pending reply marker has TTL and is cleared by clearOwesReply', () => {
  registry.markOwesReply('ttl-slug', 11);
  assert.equal(registry.getOwesReply('ttl-slug'), 11);
  registry.clearOwesReply('ttl-slug');
  assert.equal(registry.getOwesReply('ttl-slug'), null);
});

test('owes-reply is a FIFO queue: multiple messages each get answered in order (no overwrite drop)', () => {
  // The bug: a 2nd message OVERWROTE the 1st marker, so when the session
  // answered both, the 1st reply was silently dropped. Now they queue.
  registry.markOwesReply('q-slug', 100);
  registry.markOwesReply('q-slug', 200);
  registry.markOwesReply('q-slug', 300);
  // Replies consume oldest-first, so each message threads to its own anchor.
  assert.equal(registry.getOwesReply('q-slug'), 100);
  registry.clearOwesReply('q-slug'); // answered #100
  assert.equal(registry.getOwesReply('q-slug'), 200);
  registry.clearOwesReply('q-slug'); // answered #200
  assert.equal(registry.getOwesReply('q-slug'), 300);
  registry.clearOwesReply('q-slug'); // answered #300
  assert.equal(registry.getOwesReply('q-slug'), null);
});

test('owes-reply queue is bounded — oldest evicted past the cap', () => {
  for (let i = 1; i <= 20; i++) registry.markOwesReply('cap-slug', i);
  // Cap is 16, so the 4 oldest (1–4) were dropped; the front is now 5.
  assert.equal(registry.getOwesReply('cap-slug'), 5);
});

test('brain endpoints dispatch to wired handlers, JSON in/out', async () => {
  const calls = [];
  const brainHandlers = {
    listSessions: () => [{ slug: 'a' }, { slug: 'b' }],
    getSession: ({ slug }) => { calls.push({ fn: 'getSession', slug }); return { status: 'ready', slug }; },
    deliver: (args) => { calls.push({ fn: 'deliver', args }); return { fanout: 1 }; },
  };
  const reg = new Registry({ port: 0, recvTimeoutMs: 200, brainHandlers });
  await reg.start();
  try {
    const url = `http://127.0.0.1:${reg.port}`;
    // GET endpoint, no body
    const r1 = await fetch(`${url}/brain/list-sessions`);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), [{ slug: 'a' }, { slug: 'b' }]);
    // POST endpoint with body
    const r2 = await fetch(`${url}/brain/get-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'belfry' }),
    });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { status: 'ready', slug: 'belfry' });
    // Action endpoint
    const r3 = await fetch(`${url}/brain/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'belfry', body: 'hello' }),
    });
    assert.equal(r3.status, 200);
    // Verify dispatch order
    assert.equal(calls[0].fn, 'getSession');
    assert.equal(calls[1].fn, 'deliver');
  } finally {
    await reg.stop();
  }
});

test('brain endpoint with no handlers returns 503', async () => {
  // Default `registry` fixture has no brainHandlers.
  const r = await fetch(`${baseUrl}/brain/list-sessions`);
  assert.equal(r.status, 503);
});

test('brain endpoint method-mismatch returns 405', async () => {
  const reg = new Registry({ port: 0, brainHandlers: { listSessions: () => [] } });
  await reg.start();
  try {
    // /brain/list-sessions is GET; POST should 405.
    const r = await fetch(`http://127.0.0.1:${reg.port}/brain/list-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 405);
  } finally {
    await reg.stop();
  }
});

test('brain endpoint that throws returns 400 with the error message', async () => {
  const reg = new Registry({
    port: 0,
    brainHandlers: {
      getSession: () => { throw new Error('slug required'); },
    },
  });
  await reg.start();
  try {
    const r = await fetch(`http://127.0.0.1:${reg.port}/brain/get-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 400);
    assert.equal(await r.text(), 'slug required');
  } finally {
    await reg.stop();
  }
});

test('unknown brain endpoint returns 404', async () => {
  const reg = new Registry({ port: 0, brainHandlers: { listSessions: () => [] } });
  await reg.start();
  try {
    const r = await fetch(`http://127.0.0.1:${reg.port}/brain/mystery`);
    assert.equal(r.status, 404);
  } finally {
    await reg.stop();
  }
});

// ── Broadcast (#30) ───────────────────────────────────────────────────────

test('broadcast fans out to every registered instance and reports slugs', async () => {
  await post('/register', { instance_id: 'b1', slug: 'alpha', cwd: '/a' });
  await post('/register', { instance_id: 'b2', slug: 'beta', cwd: '/b' });
  await post('/register', { instance_id: 'b3', slug: 'beta', cwd: '/b' }); // 2nd instance of beta
  const { count, slugs } = registry.broadcast('fleet message');
  assert.equal(count, 3, 'all three instances notified');
  assert.deepEqual(slugs.sort(), ['alpha', 'beta'], 'distinct slugs reached');
  // The queue item carries broadcast:true so the plugin can flag meta.broadcast.
  const r = await (await fetch(`${baseUrl}/recv?instance_id=b1`)).json();
  assert.deepEqual(r, { text: 'fleet message', broadcast: true });
  for (const id of ['b1', 'b2', 'b3']) await post('/unregister', { instance_id: id });
});

test('broadcast skips instances that opted out (accepts_broadcast:false)', async () => {
  await post('/register', { instance_id: 'in', slug: 'yes', cwd: '/y' });
  await post('/register', { instance_id: 'out', slug: 'no', cwd: '/n', accepts_broadcast: false });
  const { count, slugs } = registry.broadcast('hi');
  assert.equal(count, 1);
  assert.deepEqual(slugs, ['yes']);
  for (const id of ['in', 'out']) await post('/unregister', { instance_id: id });
});

test('broadcast honors target_slugs and exclude_slugs filters', async () => {
  await post('/register', { instance_id: 't1', slug: 'one', cwd: '/1' });
  await post('/register', { instance_id: 't2', slug: 'two', cwd: '/2' });
  await post('/register', { instance_id: 't3', slug: 'three', cwd: '/3' });
  const only = registry.broadcast('x', { targetSlugs: ['one', 'three'] });
  assert.deepEqual(only.slugs.sort(), ['one', 'three']);
  const except = registry.broadcast('y', { excludeSlugs: ['two'] });
  assert.deepEqual(except.slugs.sort(), ['one', 'three']);
  for (const id of ['t1', 't2', 't3']) await post('/unregister', { instance_id: id });
});

test('POST /broadcast returns count + slugs (bare fan-out, no onBroadcast wired)', async () => {
  await post('/register', { instance_id: 'h1', slug: 'p', cwd: '/p' });
  await post('/register', { instance_id: 'h2', slug: 'q', cwd: '/q' });
  const res = await post('/broadcast', { text: 'cli broadcast' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.deepEqual(body.slugs.sort(), ['p', 'q']);
  for (const id of ['h1', 'h2']) await post('/unregister', { instance_id: id });
});

test('POST /broadcast delegates to onBroadcast when set', async () => {
  const calls = [];
  registry.setBroadcastHandler(async (args) => { calls.push(args); return { count: 7, slugs: ['mock'] }; });
  const res = await post('/broadcast', { text: 'hi', target_slugs: ['a'], exclude_slugs: ['b'] });
  const body = await res.json();
  assert.equal(body.count, 7);
  assert.deepEqual(body.slugs, ['mock']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'cli');
  assert.deepEqual(calls[0].targetSlugs, ['a']);
  assert.deepEqual(calls[0].excludeSlugs, ['b']);
  registry.setBroadcastHandler(null);
});

test('POST /broadcast rejects an empty body', async () => {
  const res = await post('/broadcast', { text: '' });
  assert.equal(res.status, 400);
});

// --- agent-to-agent relay: POST /send-to (#36) ---

test('POST /send-to relays from sender slug to target with provenance', async () => {
  await post('/register', { instance_id: 'src', slug: 'alpha', cwd: '/x' });
  await post('/register', { instance_id: 'dst', slug: 'beta', cwd: '/x' });
  const res = await post('/send-to', { instance_id: 'src', to_slug: 'beta', text: 'ping' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.delivered, 1);
  // The destination receives it tagged origin=agent, from=<sender slug>.
  const r = await fetch(`${baseUrl}/recv?instance_id=dst`);
  assert.deepEqual(await r.json(), { text: 'ping', origin: 'agent', from: 'alpha' });
  await post('/unregister', { instance_id: 'src' });
  await post('/unregister', { instance_id: 'dst' });
});

test('POST /send-to to an offline slug is ok with delivered:0, not an error', async () => {
  await post('/register', { instance_id: 'src2', slug: 'alpha2', cwd: '/x' });
  const res = await post('/send-to', { instance_id: 'src2', to_slug: 'nobody', text: 'hi' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.delivered, 0);
  await post('/unregister', { instance_id: 'src2' });
});

test('POST /send-to does NOT set an owes-reply marker on the target', async () => {
  await post('/register', { instance_id: 'src3', slug: 'alpha3', cwd: '/x' });
  await post('/register', { instance_id: 'dst3', slug: 'beta3', cwd: '/x' });
  await post('/send-to', { instance_id: 'src3', to_slug: 'beta3', text: 'peer' });
  assert.equal(registry.getOwesReply('beta3'), null);
  await post('/unregister', { instance_id: 'src3' });
  await post('/unregister', { instance_id: 'dst3' });
});

test('POST /send-to rejects an unknown sender instance with 404', async () => {
  const res = await post('/send-to', { instance_id: 'ghost', to_slug: 'beta', text: 'x' });
  assert.equal(res.status, 404);
});

test('POST /send-to rejects a bad to_slug / empty text with 400', async () => {
  await post('/register', { instance_id: 'src4', slug: 'alpha4', cwd: '/x' });
  assert.equal((await post('/send-to', { instance_id: 'src4', to_slug: 'bad slug!', text: 'x' })).status, 400);
  assert.equal((await post('/send-to', { instance_id: 'src4', to_slug: 'beta', text: '' })).status, 400);
  await post('/unregister', { instance_id: 'src4' });
});

test('POST /send-to returns 429 when the relay guard blocks', async () => {
  const blockingGuard = { check: () => ({ ok: false, reason: 'rate' }) };
  const guarded = new Registry({ port: 0, recvTimeoutMs: 200, relayGuard: blockingGuard });
  await guarded.start();
  const gurl = `http://127.0.0.1:${guarded.port}`;
  const reg = (b) => fetch(`${gurl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  await reg({ instance_id: 's', slug: 'alpha', cwd: '/x' });
  await reg({ instance_id: 'd', slug: 'beta', cwd: '/x' });
  const res = await fetch(`${gurl}/send-to`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 's', to_slug: 'beta', text: 'loop' }) });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).reason, 'rate');
  await guarded.stop();
});

test('remote owes-reply marker: set/get/clear + mutual exclusion with local (#38 P2)', () => {
  const reg = new Registry({ log: () => {} });
  // Setting the remote marker clears any local one for that slug.
  reg.markOwesReply('rs', 100);
  reg.markRemoteOwesReply('rs', { ownerHost: 'j', correlationId: 'c1', chatId: 42, originatingMessageId: 7 });
  assert.equal(reg.getOwesReply('rs'), null, 'remote set clears the local marker');
  const m = reg.getRemoteOwesReply('rs');
  assert.equal(m.ownerHost, 'j');
  assert.equal(m.chatId, 42);
  assert.equal(m.originatingMessageId, 7);
  // Setting a local marker clears the remote one.
  reg.markOwesReply('rs', 200);
  assert.equal(reg.getRemoteOwesReply('rs'), null, 'local set clears the remote marker');
  assert.equal(reg.getOwesReply('rs'), 200);
  // clearRemoteOwesReply removes it.
  reg.markRemoteOwesReply('rs', { ownerHost: 'e', correlationId: 'c2', chatId: 1, originatingMessageId: 2 });
  reg.clearRemoteOwesReply('rs');
  assert.equal(reg.getRemoteOwesReply('rs'), null);
});

test('/send runs the A+ remote return-leg when the remote marker is set (#38 P2)', async () => {
  const remoteCalls = [], localCalls = [];
  const reg = new Registry({
    port: 0, recvTimeoutMs: 200,
    onSend: async (a) => { localCalls.push(a); return { message_id: 1 }; },
  });
  reg.setRemoteReplyHandler(async ({ slug, text, remote }) => { remoteCalls.push({ slug, text, remote }); return { message_id: 777 }; });
  await reg.start();
  const url = `http://127.0.0.1:${reg.port}`;
  await fetch(`${url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'ri', slug: 'rsess', cwd: '/x' }) });
  reg.markRemoteOwesReply('rsess', { ownerHost: 'j', correlationId: 'c', chatId: 42, originatingMessageId: 9 });
  const res = await fetch(`${url}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'ri', text: 'my answer' }) });
  assert.deepEqual(await res.json(), { ok: true, message_id: 777 });
  assert.equal(remoteCalls.length, 1, 'routed to the remote return-leg, not the local onSend');
  assert.equal(localCalls.length, 0);
  assert.equal(remoteCalls[0].remote.chatId, 42);
  assert.equal(reg.getRemoteOwesReply('rsess'), null, 'marker cleared after the reply');
  await reg.stop();
});
