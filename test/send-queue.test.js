import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SendQueue, DEFAULT_SEND_INTERVAL_MS } from '../lib/send-queue.js';

// A deterministic fake clock: now() reads a counter that sleep() advances. We
// start well above zero so a fresh queue (lastSentAt=0) doesn't spuriously
// delay the first send — mirrors Date.now() being ~1.7e12 in production.
function fakeClock(start = 1_000_000) {
  let t = start;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    at: () => t,
  };
}

const rate429 = (retryAfter) => Object.assign(new Error('429'), { status: 429, retryAfter });

test('returns each task result and preserves FIFO order', async () => {
  const clk = fakeClock();
  const q = new SendQueue({ minIntervalMs: 1000, now: clk.now, sleep: clk.sleep, rand: () => 0 });
  const order = [];
  const results = await Promise.all([
    q.enqueue(async () => { order.push('a'); return 1; }),
    q.enqueue(async () => { order.push('b'); return 2; }),
    q.enqueue(async () => { order.push('c'); return 3; }),
  ]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('paces consecutive sends by minIntervalMs; first send is immediate', async () => {
  const clk = fakeClock();
  const q = new SendQueue({ minIntervalMs: 1000, now: clk.now, sleep: clk.sleep, rand: () => 0 });
  const stamps = [];
  await Promise.all([
    q.enqueue(async () => stamps.push(clk.now())),
    q.enqueue(async () => stamps.push(clk.now())),
    q.enqueue(async () => stamps.push(clk.now())),
  ]);
  assert.equal(stamps[0], 1_000_000, 'first send not delayed');
  assert.equal(stamps[1] - stamps[0], 1000);
  assert.equal(stamps[2] - stamps[1], 1000);
});

test('honours 429 retry_after: waits and retries the same task', async () => {
  const clk = fakeClock();
  const q = new SendQueue({ minIntervalMs: 1000, now: clk.now, sleep: clk.sleep, rand: () => 0 });
  let calls = 0;
  const result = await q.enqueue(async () => {
    calls += 1;
    if (calls === 1) throw rate429(2);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2, 'task retried once');
  assert.ok(clk.slept.includes(2000), `expected a 2000ms retry wait, got ${clk.slept}`);
});

test('a 429 raises the adaptive floor so the next send paces at retry_after', async () => {
  const clk = fakeClock();
  const q = new SendQueue({ minIntervalMs: 1000, now: clk.now, sleep: clk.sleep, rand: () => 0 });
  let first = 0;
  await q.enqueue(async () => {
    first += 1;
    if (first === 1) throw rate429(3); // retry_after = 3s → floor 3000ms
    return 'ok';
  });
  assert.equal(q.floorMs, 3000);
  const before = clk.at();
  await q.enqueue(async () => 'next');
  // The next send waited the 3000ms floor (not the 1000ms base) since we are
  // still inside the cooldown window.
  assert.equal(clk.at() - before, 3000);
});

test('the adaptive floor relaxes back to base once the cooldown passes', async () => {
  const clk = fakeClock();
  const q = new SendQueue({
    minIntervalMs: 1000, cooldownMs: 5000, now: clk.now, sleep: clk.sleep, rand: () => 0,
  });
  let first = 0;
  await q.enqueue(async () => {
    first += 1;
    if (first === 1) throw rate429(3);
    return 'ok';
  });
  assert.equal(q._effectiveInterval(), 3000, 'floor active within cooldown window');
  await clk.sleep(10_000); // let the cooldown window lapse
  assert.equal(q._effectiveInterval(), 1000, 'reverts to base interval after cooldown');
});

test('rejects after maxRetries consecutive 429s', async () => {
  const clk = fakeClock();
  const q = new SendQueue({ minIntervalMs: 0, maxRetries: 2, now: clk.now, sleep: clk.sleep, rand: () => 0 });
  let calls = 0;
  await assert.rejects(
    q.enqueue(async () => { calls += 1; throw rate429(1); }),
    /429/,
  );
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('a non-429 error rejects immediately and does not block the next task', async () => {
  const clk = fakeClock();
  const q = new SendQueue({ minIntervalMs: 0, now: clk.now, sleep: clk.sleep, rand: () => 0 });
  let secondRan = false;
  const failing = q.enqueue(async () => { throw new Error('boom'); });
  const next = q.enqueue(async () => { secondRan = true; return 'ok'; });
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'ok');
  assert.equal(secondRan, true);
});

test('exposes a sane default base interval', () => {
  const q = new SendQueue();
  assert.equal(q.minIntervalMs, DEFAULT_SEND_INTERVAL_MS);
});
