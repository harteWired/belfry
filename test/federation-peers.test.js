import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerRegistry } from '../lib/federation-peers.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('applies a peer announcement and exposes it', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', now: c.now });
  assert.equal(r.applyAnnouncement({ letter: 'e', name: 'Erebus', addr: 'http://erebus:1', slugs: ['api'] }), true);
  assert.equal(r.peer('e').name, 'Erebus');
  assert.deepEqual([...r.peer('e').slugs], ['api']);
});

test('ignores an announcement for our own letter', () => {
  const r = new PeerRegistry({ selfLetter: 'd' });
  assert.equal(r.applyAnnouncement({ letter: 'd', slugs: ['x'] }), false);
  assert.equal(r.peers.size, 0);
});

test('a re-announcement replaces the prior slug set', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', now: c.now });
  r.applyAnnouncement({ letter: 'e', slugs: ['a', 'b'] });
  r.applyAnnouncement({ letter: 'e', slugs: ['c'] });
  assert.deepEqual([...r.peer('e').slugs], ['c']);
});

test('prune drops peers not seen within ttl', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', ttlMs: 1000, now: c.now });
  r.applyAnnouncement({ letter: 'e', slugs: ['api'] });
  c.advance(500);
  assert.deepEqual(r.prune(), []); // still fresh
  c.advance(600); // total 1100 > ttl
  assert.deepEqual(r.prune(), ['e']);
  assert.equal(r.peers.size, 0);
});

test('ownerMap merges self slugs and live peers, with collisions as a set', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', now: c.now });
  r.applyAnnouncement({ letter: 'e', slugs: ['build', 'erebus-only'] });
  const map = r.ownerMap(['api', 'build']); // self owns api + build
  assert.deepEqual([...map.get('api')].sort(), ['d']);
  assert.deepEqual([...map.get('build')].sort(), ['d', 'e']); // collision
  assert.deepEqual([...map.get('erebus-only')].sort(), ['e']);
});

test('stores reachableAt from the announcement (#38)', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', now: c.now });
  r.applyAnnouncement({ letter: 'e', slugs: ['api'], reachableAt: 123456 });
  assert.equal(r.peer('e').reachableAt, 123456);
});

test('reachableAt defaults to 0 when absent or invalid', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', now: c.now });
  r.applyAnnouncement({ letter: 'e', slugs: ['api'] });
  assert.equal(r.peer('e').reachableAt, 0);
  r.applyAnnouncement({ letter: 'n', slugs: ['x'], reachableAt: -5 });
  assert.equal(r.peer('n').reachableAt, 0);
});

test('ownerMap omits stale peers', () => {
  const c = clock();
  const r = new PeerRegistry({ selfLetter: 'd', ttlMs: 1000, now: c.now });
  r.applyAnnouncement({ letter: 'e', slugs: ['gone'] });
  c.advance(2000);
  const map = r.ownerMap(['api']);
  assert.equal(map.has('gone'), false);
  assert.deepEqual([...map.get('api')], ['d']);
});
