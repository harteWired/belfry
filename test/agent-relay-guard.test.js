import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRelayGuard } from '../lib/agent-relay-guard.js';

// Injected clock so token refill + dedup TTL are deterministic.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('allows up to capacity, then rate-limits the source', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 3, refillPerSec: 0, now: clk.now });
  // Distinct text each time so dedup never trips — isolate the bucket.
  assert.equal(g.check('a', 'b', 'm1').ok, true);
  assert.equal(g.check('a', 'b', 'm2').ok, true);
  assert.equal(g.check('a', 'b', 'm3').ok, true);
  const blocked = g.check('a', 'b', 'm4');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'rate');
});

test('refills tokens over time', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 1, refillPerSec: 1, now: clk.now });
  assert.equal(g.check('a', 'b', 'm1').ok, true);
  assert.equal(g.check('a', 'b', 'm2').ok, false); // bucket empty
  clk.advance(1000); // +1 token
  assert.equal(g.check('a', 'b', 'm3').ok, true);
});

test('buckets are per-source: one slug flooding does not block another', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 1, refillPerSec: 0, now: clk.now });
  assert.equal(g.check('a', 'x', 'm1').ok, true);
  assert.equal(g.check('a', 'x', 'm2').ok, false); // a is tapped out
  assert.equal(g.check('b', 'x', 'm3').ok, true); // b has its own bucket
});

test('drops an identical from→to message within the dedup TTL', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, dupTtlMs: 5000, now: clk.now });
  assert.equal(g.check('a', 'b', 'same').ok, true);
  const dup = g.check('a', 'b', 'same');
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate');
});

test('the same text to a DIFFERENT target is not a duplicate', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, now: clk.now });
  assert.equal(g.check('a', 'b', 'hi').ok, true);
  assert.equal(g.check('a', 'c', 'hi').ok, true);
});

test('distinct messages sharing a long prefix are NOT falsely deduped (#36 review)', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, now: clk.now });
  const prefix = 'Task complete: step '.padEnd(70, 'x'); // > 64 chars, shared
  assert.equal(g.check('a', 'b', prefix + ' 1 of 9').ok, true);
  // Same length-ish, identical first 64 bytes, but genuinely different content.
  const other = prefix + ' 7 of 9';
  assert.equal(g.check('a', 'b', other).ok, true, 'must not collide on prefix');
});

test('a duplicate is allowed again once the TTL lapses', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 10, refillPerSec: 0, dupTtlMs: 5000, now: clk.now });
  assert.equal(g.check('a', 'b', 'same').ok, true);
  assert.equal(g.check('a', 'b', 'same').ok, false);
  clk.advance(5001);
  assert.equal(g.check('a', 'b', 'same').ok, true);
});

test('a duplicate does not consume a token (dedup is checked first)', () => {
  const clk = fakeClock();
  const g = new AgentRelayGuard({ capacity: 1, refillPerSec: 0, now: clk.now });
  assert.equal(g.check('a', 'b', 'same').ok, true); // spends the only token
  assert.equal(g.check('a', 'b', 'same').reason, 'duplicate'); // refused before bucket
  // Token already spent on the first call → a fresh message is now rate-limited.
  assert.equal(g.check('a', 'b', 'other').reason, 'rate');
});
