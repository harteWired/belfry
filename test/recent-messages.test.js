import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RecentMessages } from '../lib/recent-messages.js';

test('push: appends and recent: returns newest-first', () => {
  const r = new RecentMessages();
  r.push('a', { kind: 'event', text: 'first', ts: 1 });
  r.push('a', { kind: 'event', text: 'second', ts: 2 });
  r.push('a', { kind: 'event', text: 'third', ts: 3 });
  const out = r.recent('a', 10);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, 'third');
  assert.equal(out[2].text, 'first');
});

test('push: ring evicts oldest when over capacity', () => {
  const r = new RecentMessages({ ringSize: 3 });
  for (let i = 0; i < 5; i++) r.push('a', { kind: 'event', text: `m${i}`, ts: i });
  const out = r.recent('a', 10);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.text), ['m4', 'm3', 'm2']);
});

test('recent: caps at requested n', () => {
  const r = new RecentMessages();
  for (let i = 0; i < 8; i++) r.push('a', { kind: 'event', text: `m${i}`, ts: i });
  assert.equal(r.recent('a', 3).length, 3);
  assert.equal(r.recent('a', 100).length, 8);
});

test('recent: empty for unknown slug', () => {
  const r = new RecentMessages();
  assert.deepEqual(r.recent('missing', 10), []);
});

test('push: ignores empty slug or non-string text', () => {
  const r = new RecentMessages();
  r.push('', { kind: 'event', text: 'x' });
  r.push('a', { kind: 'event', text: 12345 });
  assert.deepEqual(r.recent('', 10), []);
  assert.deepEqual(r.recent('a', 10), []);
});

test('knownSlugs: returns slugs with any history', () => {
  const r = new RecentMessages();
  r.push('a', { kind: 'event', text: 'x' });
  r.push('b', { kind: 'event', text: 'y' });
  assert.deepEqual(r.knownSlugs().sort(), ['a', 'b']);
});
