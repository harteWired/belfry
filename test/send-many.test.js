import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../lib/registry.js';
import { AgentRelayGuard } from '../lib/agent-relay-guard.js';

// send_many (#50): batch fan-out — one guard token per batch, per-recipient
// echo dedup, per-recipient results through the same routing as /send-to.

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ---- AgentRelayGuard.checkBatch ----

test('checkBatch charges ONE token for the whole batch', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 1, refillPerSec: 0, now: clk.now });
  const verdict = g.checkBatch('a', ['b', 'c', 'd'], 'fleet notice');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.recipients.length, 3);
  assert.ok(verdict.recipients.every((r) => r.ok));
  // The single token is spent — a follow-up single relay is rate-limited.
  assert.deepEqual(g.check('a', 'e', 'other'), { ok: false, reason: 'rate' });
});

test('checkBatch rate-limits when the source bucket is dry', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 1, refillPerSec: 0, now: clk.now });
  assert.equal(g.check('a', 'b', 'm1').ok, true);
  assert.deepEqual(g.checkBatch('a', ['c', 'd'], 'm2'), { ok: false, reason: 'rate' });
});

test('checkBatch dedups per recipient against prior single sends', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, now: clk.now });
  assert.equal(g.check('a', 'b', 'same text').ok, true);
  const verdict = g.checkBatch('a', ['b', 'c'], 'same text');
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.recipients[0], { to: 'b', ok: false, reason: 'duplicate' });
  assert.deepEqual(verdict.recipients[1], { to: 'c', ok: true });
});

test('checkBatch records dedup so a follow-up identical send_to collapses', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, now: clk.now });
  assert.equal(g.checkBatch('a', ['b', 'c'], 'notice').ok, true);
  assert.deepEqual(g.check('a', 'b', 'notice'), { ok: false, reason: 'duplicate' });
  // …and is allowed again once the TTL lapses.
  clk.advance(11_000);
  assert.equal(g.check('a', 'b', 'notice').ok, true);
});

// ---- Registry POST /send-many ----

async function withRegistry(opts, fn) {
  const registry = new Registry({ port: 0, recvTimeoutMs: 200, ...opts });
  await registry.start();
  const baseUrl = `http://127.0.0.1:${registry.port}`;
  const post = (pathname, body) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    await fn({ registry, baseUrl, post });
  } finally {
    await registry.stop();
  }
}

test('/send-many fans one text to live + offline recipients with per-recipient results', async () => {
  await withRegistry({}, async ({ registry, baseUrl, post }) => {
    await post('/register', { instance_id: 'sender', slug: 'wintermute', cwd: '/x' });
    await post('/register', { instance_id: 'p1', slug: 'api', cwd: '/x' });
    await post('/register', { instance_id: 'p2', slug: 'vault', cwd: '/x' });
    const res = await post('/send-many', {
      instance_id: 'sender',
      to_slugs: ['api', 'vault', 'ghost', 'api'], // repeated slug de-duplicates
      text: 'recovery brief',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.delivered, 2);
    assert.equal(body.results.length, 3);
    const byTo = Object.fromEntries(body.results.map((r) => [r.to, r]));
    assert.equal(byTo.api.delivered, 1);
    assert.equal(byTo.vault.delivered, 1);
    assert.deepEqual(byTo.ghost, { to: 'ghost', ok: true, delivered: 0 });
    // Recipients receive an origin=agent item from the SENDER's slug.
    const r1 = await fetch(`${baseUrl}/recv?instance_id=p1`);
    assert.deepEqual(await r1.json(), { text: 'recovery brief', origin: 'agent', from: 'wintermute' });
  });
});

test('/send-many charges one guard token and 429s only when the bucket is dry', async () => {
  const clk = fakeClock();
  const guard = new AgentRelayGuard({ capacity: 1, refillPerSec: 0, now: clk.now });
  await withRegistry({ relayGuard: guard }, async ({ post }) => {
    await post('/register', { instance_id: 'sender', slug: 'wintermute', cwd: '/x' });
    await post('/register', { instance_id: 'p1', slug: 'api', cwd: '/x' });
    const first = await post('/send-many', { instance_id: 'sender', to_slugs: ['api', 'ghost'], text: 'batch one' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).delivered, 1);
    // Bucket (capacity 1) is now dry — the next batch is rate-limited whole.
    const second = await post('/send-many', { instance_id: 'sender', to_slugs: ['api'], text: 'batch two' });
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), { ok: false, reason: 'rate' });
  });
});

test('/send-many marks in-TTL duplicate recipients without failing the batch', async () => {
  const clk = fakeClock();
  const guard = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, now: clk.now });
  await withRegistry({ relayGuard: guard }, async ({ post }) => {
    await post('/register', { instance_id: 'sender', slug: 'wintermute', cwd: '/x' });
    await post('/register', { instance_id: 'p1', slug: 'api', cwd: '/x' });
    await post('/register', { instance_id: 'p2', slug: 'vault', cwd: '/x' });
    await post('/send-to', { instance_id: 'sender', to_slug: 'api', text: 'same notice' });
    const res = await post('/send-many', { instance_id: 'sender', to_slugs: ['api', 'vault'], text: 'same notice' });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byTo = Object.fromEntries(body.results.map((r) => [r.to, r]));
    assert.deepEqual(byTo.api, { to: 'api', ok: false, delivered: 0, reason: 'duplicate' });
    assert.equal(byTo.vault.delivered, 1);
    assert.equal(body.delivered, 1);
  });
});

test('/send-many routes host-qualified targets through the federation router with skipGuard', async () => {
  const calls = [];
  await withRegistry({}, async ({ registry, post }) => {
    registry.setFederationRouter(async (fromSlug, target, text, opts) => {
      calls.push({ fromSlug, target, opts });
      if (target.startsWith('e/')) return { handled: true, ok: true, delivered: 1, host: 'e' };
      return { handled: false };
    });
    await post('/register', { instance_id: 'sender', slug: 'wintermute', cwd: '/x' });
    await post('/register', { instance_id: 'p1', slug: 'api', cwd: '/x' });
    const res = await post('/send-many', { instance_id: 'sender', to_slugs: ['api', 'e/nuc'], text: 'cross-host' });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byTo = Object.fromEntries(body.results.map((r) => [r.to, r]));
    assert.deepEqual(byTo['e/nuc'], { to: 'e/nuc', ok: true, delivered: 1, remote: true, host: 'e' });
    assert.equal(byTo.api.delivered, 1);
    assert.ok(calls.every((c) => c.opts?.skipGuard === true));
  });
});

test('/send-many surfaces a per-recipient federation failure without sinking the batch', async () => {
  await withRegistry({}, async ({ registry, post }) => {
    registry.setFederationRouter(async (fromSlug, target) => {
      if (target.startsWith('e/')) return { handled: true, ok: false, status: 502, reason: 'peer unreachable' };
      return { handled: false };
    });
    await post('/register', { instance_id: 'sender', slug: 'wintermute', cwd: '/x' });
    await post('/register', { instance_id: 'p1', slug: 'api', cwd: '/x' });
    const res = await post('/send-many', { instance_id: 'sender', to_slugs: ['e/nuc', 'api'], text: 'notice' });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byTo = Object.fromEntries(body.results.map((r) => [r.to, r]));
    assert.deepEqual(byTo['e/nuc'], { to: 'e/nuc', ok: false, delivered: 0, reason: 'peer unreachable' });
    assert.equal(byTo.api.delivered, 1);
  });
});

test('/send-many validates the body and the recipient cap', async () => {
  await withRegistry({}, async ({ post }) => {
    await post('/register', { instance_id: 'sender', slug: 'wintermute', cwd: '/x' });
    assert.equal((await post('/send-many', { instance_id: 'sender', to_slugs: [], text: 'x' })).status, 400);
    assert.equal((await post('/send-many', { instance_id: 'sender', to_slugs: ['ok', 'BAD SLUG!'], text: 'x' })).status, 400);
    assert.equal((await post('/send-many', { instance_id: 'sender', to_slugs: Array.from({ length: 33 }, (_, i) => `s${i}`), text: 'x' })).status, 400);
    assert.equal((await post('/send-many', { instance_id: 'sender', to_slugs: ['ok'], text: '' })).status, 400);
    assert.equal((await post('/send-many', { instance_id: 'nobody', to_slugs: ['ok'], text: 'x' })).status, 404);
  });
});
