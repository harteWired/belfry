import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyTracker } from '../lib/reply-tracker.js';

test('record and lookup round-trip', () => {
  const t = new ReplyTracker();
  t.record(101, 'life-planner');
  assert.equal(t.lookup(101), 'life-planner');
});

test('lookup returns null for unknown id', () => {
  const t = new ReplyTracker();
  assert.equal(t.lookup(999), null);
});

test('LRU evicts oldest when capacity exceeded', () => {
  const t = new ReplyTracker({ capacity: 3 });
  t.record(1, 'a');
  t.record(2, 'b');
  t.record(3, 'c');
  t.record(4, 'd');
  assert.equal(t.lookup(1), null, 'oldest evicted');
  assert.equal(t.lookup(2), 'b');
  assert.equal(t.lookup(3), 'c');
  assert.equal(t.lookup(4), 'd');
  assert.equal(t.size(), 3);
});

test('re-recording an existing id bumps recency', () => {
  const t = new ReplyTracker({ capacity: 3 });
  t.record(1, 'a');
  t.record(2, 'b');
  t.record(3, 'c');
  t.record(1, 'a-again');
  t.record(4, 'd');
  assert.equal(t.lookup(1), 'a-again', 'id 1 was bumped, survives eviction');
  assert.equal(t.lookup(2), null, 'id 2 is now oldest, evicted');
});

test('non-numeric message id ignored on record and lookup', () => {
  const t = new ReplyTracker();
  t.record('123', 'a');
  t.record(null, 'a');
  assert.equal(t.size(), 0);
  assert.equal(t.lookup('123'), null);
});

test('empty slug ignored on record', () => {
  const t = new ReplyTracker();
  t.record(1, '');
  t.record(2, null);
  assert.equal(t.size(), 0);
});
