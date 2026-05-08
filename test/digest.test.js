import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Digest } from '../lib/digest.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('Digest: flushes after idleMs of quiet', async () => {
  const flushed = deferred();
  const digest = new Digest({
    idleMs: 30,
    windowMs: 200,
    flush: (slug, events) => flushed.resolve({ slug, events }),
  });
  digest.enqueue('s1', { status: 'ready' });
  digest.enqueue('s1', { status: 'error' });
  const { slug, events } = await flushed.promise;
  assert.equal(slug, 's1');
  assert.equal(events.length, 2);
  assert.equal(events[0].status, 'ready');
  assert.equal(events[1].status, 'error');
});

test('Digest: events arriving within idleMs reset the idle timer', async () => {
  const flushed = deferred();
  let firstAt = Date.now();
  const digest = new Digest({
    idleMs: 40,
    windowMs: 500,
    flush: (slug, events) => flushed.resolve({ slug, events, elapsed: Date.now() - firstAt }),
  });
  digest.enqueue('s', { i: 1 });
  await new Promise((r) => setTimeout(r, 25));
  digest.enqueue('s', { i: 2 });
  await new Promise((r) => setTimeout(r, 25));
  digest.enqueue('s', { i: 3 });
  const { events, elapsed } = await flushed.promise;
  assert.equal(events.length, 3);
  assert.ok(elapsed >= 50, `idle reset should hold flush past initial 40ms; got ${elapsed}`);
});

test('Digest: windowMs caps total burst duration', async () => {
  const flushed = deferred();
  const digest = new Digest({
    idleMs: 30,
    windowMs: 60,
    flush: (slug, events) => flushed.resolve({ slug, events }),
  });
  // Keep pumping events every 15ms — idle never expires, window must cut it.
  const pump = setInterval(() => digest.enqueue('s', { t: Date.now() }), 15);
  const { events } = await flushed.promise;
  clearInterval(pump);
  // We don't assert exact count (timing is fuzzy on CI) — just that the
  // window did fire and we got something.
  assert.ok(events.length >= 2, `window should fire with >=2 events, got ${events.length}`);
});

test('Digest: separate slugs flush independently', async () => {
  const flushes = [];
  const seen = deferred();
  let count = 0;
  const digest = new Digest({
    idleMs: 30,
    windowMs: 200,
    flush: (slug, events) => {
      flushes.push({ slug, count: events.length });
      if (++count === 2) seen.resolve();
    },
  });
  digest.enqueue('a', { x: 1 });
  digest.enqueue('b', { x: 2 });
  await seen.promise;
  flushes.sort((x, y) => x.slug.localeCompare(y.slug));
  assert.deepEqual(flushes, [{ slug: 'a', count: 1 }, { slug: 'b', count: 1 }]);
});

test('Digest: flushAll awaits async flush callbacks (no-drop on shutdown)', async () => {
  const flushed = [];
  let resolveFlush;
  const flushDone = new Promise((r) => { resolveFlush = r; });
  const digest = new Digest({
    idleMs: 1000,
    windowMs: 5000,
    flush: async (slug, events) => {
      // Simulate the real flush: await a network call before recording.
      await new Promise((r) => setTimeout(r, 20));
      flushed.push({ slug, events });
      resolveFlush();
    },
  });
  digest.enqueue('s', { x: 1 });
  digest.enqueue('s', { x: 2 });
  await digest.flushAll();
  // flushAll must have awaited the async callback — flushed is populated.
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].events.length, 2);
  await flushDone; // sanity: the resolution we observed was real
});

test('Digest: flushAll resolves to empty Promise.all when nothing pending', async () => {
  const digest = new Digest({
    idleMs: 1000,
    windowMs: 5000,
    flush: () => { throw new Error('should not be called'); },
  });
  await digest.flushAll();
});

test('Digest: clearAll drops pending without flushing', async () => {
  let called = false;
  const digest = new Digest({
    idleMs: 20,
    windowMs: 200,
    flush: () => { called = true; },
  });
  digest.enqueue('s', { x: 1 });
  digest.clearAll();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, false);
});

test('Digest: rejects invalid timing config', () => {
  assert.throws(() => new Digest({ idleMs: 0, windowMs: 100, flush: () => {} }));
  assert.throws(() => new Digest({ idleMs: 100, windowMs: 50, flush: () => {} }));
});

test('Digest: flush throw is swallowed (does not unhandled-reject)', async () => {
  const digest = new Digest({
    idleMs: 20,
    windowMs: 200,
    flush: () => { throw new Error('boom'); },
  });
  digest.enqueue('s', {});
  // If unhandled the test process would crash; we just need no hang.
  await new Promise((r) => setTimeout(r, 50));
});
