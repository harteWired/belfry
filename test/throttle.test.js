import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Throttle } from '../lib/throttle.js';

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

test('coalesces multiple events within the coalesce window into one dispatch', async () => {
  const clock = makeClock();
  const dispatched = [];
  const throttle = new Throttle({
    coalesceMs: 100,
    throttleMs: 1000,
    dispatch: (slug, ev) => dispatched.push({ slug, ev }),
    now: clock.now,
  });
  throttle.enqueue('a', { status: 'ready', n: 1 });
  throttle.enqueue('a', { status: 'ready', n: 2 });
  throttle.enqueue('a', { status: 'ready', n: 3 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].ev.n, 3); // latest wins
});

test('drops events while throttle window is active', async () => {
  const clock = makeClock();
  const dispatched = [];
  const throttle = new Throttle({
    coalesceMs: 50,
    throttleMs: 500,
    dispatch: (slug, ev) => dispatched.push({ slug, ev }),
    now: clock.now,
  });
  throttle.enqueue('a', { status: 'ready', n: 1 });
  await new Promise((r) => setTimeout(r, 80));
  // Throttle window now active — clock virtually advances 100ms
  clock.advance(100);
  const result = throttle.enqueue('a', { status: 'ready', n: 2 });
  assert.equal(result.dropped, true);
  assert.equal(result.reason, 'throttled');
  assert.equal(dispatched.length, 1);
});

test('separate slugs throttle independently', async () => {
  const clock = makeClock();
  const dispatched = [];
  const throttle = new Throttle({
    coalesceMs: 30,
    throttleMs: 500,
    dispatch: (slug, ev) => dispatched.push({ slug, ev }),
    now: clock.now,
  });
  throttle.enqueue('a', { status: 'ready' });
  throttle.enqueue('b', { status: 'ready' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(dispatched.length, 2);
  const slugs = dispatched.map((d) => d.slug).sort();
  assert.deepEqual(slugs, ['a', 'b']);
});
