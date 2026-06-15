/**
 * Priority gate (#38) — deterministic, injected-clock unit tests for
 * `wireFederation().isPreempted()`. Drives the PeerRegistry directly (no real
 * gossip / no timers) so the TTL freshness logic is exact, not racy.
 *
 * The gate answers: "should THIS host stand down from owning the bot because a
 * higher-priority host is alive AND reachable on Telegram?" The two non-yield
 * cases are the whole point of the design:
 *   - higher peer not live on the mesh (gossip stopped)     → take over
 *   - higher peer live but reachableAt stale (egress dead)  → take over (Daedalus)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wireFederation } from '../lib/federation-daemon.js';

// Minimal registry stub — isPreempted never touches the registry, and we avoid
// standing up a real loopback Registry just to read the gate.
const stubRegistry = {
  setFederationRouter() {},
  setBridgeReplyHandler() {},
  knownSlugs() { return new Set(); },
};

function mutableClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

/**
 * Build host "e" (self) with one peer "j". `selfPriority`/`peerPriority` and the
 * confirm TTL are the knobs under test. Returns { fed, clock, stop }.
 */
async function makeGate({ selfPriority = 2, peerPriority = 1, ttl = 1000 } = {}) {
  const clock = mutableClock();
  const fed = await wireFederation({
    registry: stubRegistry,
    fedConfig: {
      enabled: true, hostLetter: 'e', hostName: 'Erebus', token: 't', priority: selfPriority,
      peers: [{ letter: 'j', name: 'Jinn', addr: 'http://127.0.0.1:1', priority: peerPriority }],
    },
    owner: { reachableAt: 0 },
    port: 0,
    now: clock.now,
    ownerConfirmTtlMs: ttl,
  });
  return { fed, clock, stop: () => fed.stop() };
}

test('not preempted when no peer has announced (higher peer not live)', async () => {
  const { fed, stop } = await makeGate();
  try {
    assert.equal(fed.isPreempted(), false);
  } finally { await stop(); }
});

test('preempted when a higher-priority peer is live AND recently reachable', async () => {
  const { fed, clock, stop } = await makeGate({ ttl: 1000 });
  try {
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() });
    assert.equal(fed.isPreempted(), true);
  } finally { await stop(); }
});

test('NOT preempted when the higher peer is live but reachableAt is stale (Daedalus egress-dead)', async () => {
  const { fed, clock, stop } = await makeGate({ ttl: 1000 });
  try {
    // Peer keeps gossiping (lastSeen fresh) but hasn't reached Telegram since an
    // old timestamp — so its reachableAt has aged past the confirm TTL.
    const old = clock.now() - 2000; // 2000 > ttl 1000
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: old });
    assert.equal(fed.isPreempted(), false); // we take over
  } finally { await stop(); }
});

test('NOT preempted once the higher peer is pruned (gossip stopped entirely)', async () => {
  const { fed, clock, stop } = await makeGate({ ttl: 1000 });
  try {
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() });
    assert.equal(fed.isPreempted(), true);
    clock.advance(100_000); // past the default 90s peer lastSeen TTL → pruned
    assert.equal(fed.isPreempted(), false);
  } finally { await stop(); }
});

test('NOT preempted by an equal/lower-priority peer even if fresh', async () => {
  // self=2, peer j=2 (equal) → not strictly higher → 409 race decides, no yield.
  const { fed, clock, stop } = await makeGate({ selfPriority: 2, peerPriority: 2, ttl: 1000 });
  try {
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() });
    assert.equal(fed.isPreempted(), false);
  } finally { await stop(); }
});

test('NOT preempted by a peer with unknown (null) priority', async () => {
  const { fed, clock, stop } = await makeGate({ selfPriority: 2, peerPriority: null, ttl: 1000 });
  try {
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() });
    assert.equal(fed.isPreempted(), false);
  } finally { await stop(); }
});

test('gating off entirely when self has no priority (pure 409 election)', async () => {
  const { fed, clock, stop } = await makeGate({ selfPriority: null, peerPriority: 1, ttl: 1000 });
  try {
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() });
    assert.equal(fed.isPreempted(), false);
  } finally { await stop(); }
});

test('handback: a recovered higher peer flips us back to preempted', async () => {
  const { fed, clock, stop } = await makeGate({ ttl: 1000 });
  try {
    // Owner died: stale reachableAt → we own (not preempted).
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() - 5000 });
    assert.equal(fed.isPreempted(), false);
    // Owner restarts and reaches Telegram again (even a 409 counts) → fresh
    // reachableAt → we yield. This is the handback signal.
    fed.peerRegistry.applyAnnouncement({ letter: 'j', slugs: [], reachableAt: clock.now() });
    assert.equal(fed.isPreempted(), true);
  } finally { await stop(); }
});
