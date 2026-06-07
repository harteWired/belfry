import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrelationTracker } from '../lib/correlation-tracker.js';

// Deterministic harness: sequential ids + manually-fired timers.
function harness(opts = {}) {
  let n = 0;
  const timers = new Map(); // timerId → cb
  let nextTimer = 1;
  const fired = [];
  const tracker = new CorrelationTracker({
    genId: () => `id${++n}`,
    setTimer: (cb) => {
      const t = nextTimer++;
      timers.set(t, cb);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
    onExpire: (id, origin) => fired.push({ id, origin }),
    ...opts,
  });
  return {
    tracker,
    fireAll: () => { for (const cb of [...timers.values()]) cb(); },
    timersLeft: () => timers.size,
    expired: fired,
  };
}

test('open returns an id and resolve returns the origin once', () => {
  const { tracker } = harness();
  const id = tracker.open({ kind: 'telegram', messageId: 42 });
  assert.equal(id, 'id1');
  assert.equal(tracker.size, 1);
  assert.deepEqual(tracker.resolve(id), { kind: 'telegram', messageId: 42 });
  // Single-consume: a second resolve yields null.
  assert.equal(tracker.resolve(id), null);
  assert.equal(tracker.size, 0);
});

test('resolve on an unknown id returns null', () => {
  const { tracker } = harness();
  assert.equal(tracker.resolve('nope'), null);
});

test('peek does not consume', () => {
  const { tracker } = harness();
  const id = tracker.open({ slug: 'api' });
  assert.deepEqual(tracker.peek(id), { slug: 'api' });
  assert.equal(tracker.size, 1);
  assert.deepEqual(tracker.resolve(id), { slug: 'api' });
});

test('timeout fires onExpire and evicts the entry', () => {
  const h = harness();
  const id = h.tracker.open({ slug: 'life-planner' });
  assert.equal(h.tracker.size, 1);
  h.fireAll(); // simulate TTL elapse
  assert.equal(h.tracker.size, 0);
  assert.deepEqual(h.expired, [{ id, origin: { slug: 'life-planner' } }]);
  assert.equal(h.tracker.resolve(id), null);
});

test('resolve cancels the pending timeout (no later expiry)', () => {
  const h = harness();
  const id = h.tracker.open({ slug: 'x' });
  h.tracker.resolve(id);
  assert.equal(h.timersLeft(), 0, 'timer cleared on resolve');
  h.fireAll(); // nothing should fire
  assert.deepEqual(h.expired, []);
});

test('cancel drops without firing onExpire', () => {
  const h = harness();
  const id = h.tracker.open({ slug: 'x' });
  assert.equal(h.tracker.cancel(id), true);
  assert.equal(h.tracker.size, 0);
  h.fireAll();
  assert.deepEqual(h.expired, []);
});

test('evicts the oldest entry when at capacity', () => {
  const h = harness({ maxPending: 2 });
  const a = h.tracker.open({ n: 1 });
  h.tracker.open({ n: 2 });
  h.tracker.open({ n: 3 }); // over capacity → evicts oldest (a)
  assert.equal(h.tracker.size, 2);
  assert.equal(h.tracker.resolve(a), null, 'oldest evicted');
  // Eviction-as-expiry fires onExpire for the dropped entry.
  assert.deepEqual(h.expired, [{ id: a, origin: { n: 1 } }]);
});

test('genId collisions are retried to stay unique', () => {
  let calls = 0;
  const seq = ['dup', 'dup', 'fresh'];
  const tracker = new CorrelationTracker({
    genId: () => seq[calls++] ?? `x${calls}`,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const first = tracker.open({ a: 1 }); // 'dup'
  const second = tracker.open({ b: 2 }); // 'dup' taken → retries → 'fresh'
  assert.equal(first, 'dup');
  assert.equal(second, 'fresh');
});

test('cancelAll clears everything without firing onExpire', () => {
  const h = harness();
  h.tracker.open({ n: 1 });
  h.tracker.open({ n: 2 });
  h.tracker.cancelAll();
  assert.equal(h.tracker.size, 0);
  assert.deepEqual(h.expired, []);
});
