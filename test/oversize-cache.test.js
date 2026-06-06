import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OversizeCache } from '../lib/oversize-cache.js';

test('put + get + delete basics', () => {
  const c = new OversizeCache({ max: 10 });
  c.put(1, 'belfry', 'hello world');
  assert.equal(c.size, 1);
  assert.ok(c.has(1));
  assert.equal(c.get(1).slug, 'belfry');
  assert.equal(c.get(1).text, 'hello world');
  assert.equal(c.get(2), null);
  c.delete(1);
  assert.equal(c.size, 0);
  assert.equal(c.has(1), false);
});

test('evicts oldest when over capacity', () => {
  const c = new OversizeCache({ max: 3 });
  c.put(1, 'a', 'one');
  c.put(2, 'b', 'two');
  c.put(3, 'c', 'three');
  c.put(4, 'd', 'four');
  // 1 was the oldest insertion; it should be gone.
  assert.equal(c.has(1), false);
  assert.equal(c.has(2), true);
  assert.equal(c.has(3), true);
  assert.equal(c.has(4), true);
  assert.equal(c.size, 3);
});

test('re-put refreshes insertion order', () => {
  // If the same message_id is stored again, treat it as fresh so a stale
  // entry doesn't get evicted before a brand-new one that came in after.
  const c = new OversizeCache({ max: 2 });
  c.put(1, 'a', 'one');
  c.put(2, 'b', 'two');
  c.put(1, 'a', 'one-refreshed'); // refresh — 1 is now newer than 2
  c.put(3, 'c', 'three');         // should evict 2, not 1
  assert.equal(c.has(2), false);
  assert.equal(c.has(1), true);
  assert.equal(c.get(1).text, 'one-refreshed');
  assert.equal(c.has(3), true);
});

test('rejects invalid inputs silently', () => {
  const c = new OversizeCache({ max: 5 });
  c.put(null, 'a', 'x');
  c.put(0, 'a', 'x');
  c.put(1.5, 'a', 'x');
  c.put(1, '', 'x');
  c.put(1, 'a', '');
  c.put(1, 'a', null);
  assert.equal(c.size, 0);
});

test('constructor rejects bad max', () => {
  assert.throws(() => new OversizeCache({ max: 0 }));
  assert.throws(() => new OversizeCache({ max: -1 }));
  assert.throws(() => new OversizeCache({ max: 1.5 }));
});
