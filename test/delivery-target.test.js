/**
 * deliveryTarget — the Poller's federation-aware delivery wrapper (#44).
 *
 * Regression guard: the wrapper must proxy the FULL Poller `target` interface
 * (deliver + hasSlug + knownSlugs), not just deliver() — the partial version
 * made every `/<slug>`/nick route throw "knownSlugs is not a function".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeliveryTarget, FED_SLUG_RE } from '../lib/delivery-target.js';

function fakeRegistry() {
  const calls = [];
  return {
    calls,
    deliver(slug, text, mid = null, att = null) { calls.push({ slug, text, mid, att }); return 1; },
    hasSlug(slug) { return slug === 'api'; },
    knownSlugs() { return new Set(['api', 'health-dash']); },
  };
}

function fakeFederation(relayResult) {
  const relays = [];
  return {
    relays,
    relayRemote(fromSlug, target, text) {
      relays.push({ fromSlug, target, text });
      return Promise.resolve(relayResult);
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('proxies hasSlug and knownSlugs to the registry (the regression)', () => {
  const registry = fakeRegistry();
  const t = makeDeliveryTarget({ registry, federation: null });
  assert.equal(typeof t.hasSlug, 'function');
  assert.equal(typeof t.knownSlugs, 'function');
  assert.equal(t.hasSlug('api'), true);
  assert.equal(t.hasSlug('nope'), false);
  assert.deepEqual([...t.knownSlugs()], ['api', 'health-dash']);
});

test('bare slug delivers locally via the registry', () => {
  const registry = fakeRegistry();
  const t = makeDeliveryTarget({ registry, federation: null });
  const n = t.deliver('api', 'hello', 42, null);
  assert.equal(n, 1);
  assert.deepEqual(registry.calls, [{ slug: 'api', text: 'hello', mid: 42, att: null }]);
});

test('federated <letter>/<slug> target forwards over the mesh from the bridge identity', async () => {
  const registry = fakeRegistry();
  const federation = fakeFederation({ handled: true, ok: true, delivered: 1 });
  const t = makeDeliveryTarget({ registry, federation, fedBridgeSlug: 'telegram' });
  const n = t.deliver('e/erebus-master', 'hi from jinn', 7);
  assert.equal(n, 1); // optimistic
  await flush();
  assert.deepEqual(federation.relays, [{ fromSlug: 'telegram', target: 'e/erebus-master', text: 'hi from jinn' }]);
  assert.equal(registry.calls.length, 0); // not delivered locally
});

test('federated target with federation off is dropped (returns 0)', () => {
  const registry = fakeRegistry();
  const logs = [];
  const t = makeDeliveryTarget({ registry, federation: null, log: (m) => logs.push(m) });
  const n = t.deliver('e/erebus-master', 'hi');
  assert.equal(n, 0);
  assert.equal(registry.calls.length, 0);
  assert.match(logs.join('\n'), /federation is off/);
});

test('local-self host-qualified target falls back to a local bare-slug delivery', async () => {
  // relayRemote returns handled:false when the target resolved to THIS host.
  const registry = fakeRegistry();
  const federation = fakeFederation({ handled: false });
  const t = makeDeliveryTarget({ registry, federation });
  t.deliver('j/api', 'self-addressed', 9, null);
  await flush();
  // Stripped the host prefix and delivered locally instead of dropping.
  assert.deepEqual(registry.calls, [{ slug: 'api', text: 'self-addressed', mid: 9, att: null }]);
});

test('failed remote relay logs and does NOT deliver locally', async () => {
  const registry = fakeRegistry();
  const federation = fakeFederation({ handled: true, ok: false, reason: 'peer offline' });
  const logs = [];
  const t = makeDeliveryTarget({ registry, federation, log: (m) => logs.push(m) });
  t.deliver('e/erebus-master', 'hi');
  await flush();
  assert.equal(registry.calls.length, 0);
  assert.match(logs.join('\n'), /failed: peer offline/);
});

test('FED_SLUG_RE matches host-qualified targets only', () => {
  assert.ok(FED_SLUG_RE.test('e/erebus-master'));
  assert.ok(FED_SLUG_RE.test('j/api'));
  assert.ok(!FED_SLUG_RE.test('api'));
  assert.ok(!FED_SLUG_RE.test('erebus-master'));
});
