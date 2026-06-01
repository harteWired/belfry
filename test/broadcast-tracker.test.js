import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastTracker, DEFAULT_BROADCAST_TIMEOUT_MS } from '../lib/broadcast-tracker.js';

// A controllable timer: capture the scheduled callback so a test can fire the
// "timeout" deterministically instead of waiting wall-clock.
function fakeTimers() {
  const scheduled = [];
  return {
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; scheduled.push(h); return h; },
    clearTimer: (h) => { if (h) h.cleared = true; },
    fire: (i = scheduled.length - 1) => scheduled[i].fn(),
    scheduled,
  };
}

function makeTracker(overrides = {}) {
  const completions = [];
  const timers = fakeTimers();
  const tracker = new BroadcastTracker({
    onComplete: (r) => completions.push(r),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { tracker, completions, timers };
}

test('completes when every expected slug replies', () => {
  const { tracker, completions, timers } = makeTracker();
  tracker.start(100, { expectedSlugs: ['a', 'b'] });
  assert.equal(completions.length, 0);
  assert.equal(tracker.record(100, 'a', 'done A'), true);
  assert.equal(completions.length, 0, 'not complete until all reply');
  assert.equal(tracker.record(100, 'b', 'done B'), true);
  assert.equal(completions.length, 1);
  const c = completions[0];
  assert.equal(c.messageId, 100);
  assert.equal(c.timedOut, false);
  assert.deepEqual([...c.responses.entries()], [['a', 'done A'], ['b', 'done B']]);
  assert.deepEqual(c.missing, []);
  assert.equal(timers.scheduled[0].cleared, true, 'timer cleared on completion');
  assert.equal(tracker.has(100), false, 'no longer active after completion');
});

test('timeout fires with partial responses + missing list', () => {
  const { tracker, completions, timers } = makeTracker();
  tracker.start(200, { expectedSlugs: ['a', 'b', 'c'] });
  tracker.record(200, 'a', 'A');
  timers.fire(); // simulate the timeout
  assert.equal(completions.length, 1);
  const c = completions[0];
  assert.equal(c.timedOut, true);
  assert.deepEqual([...c.responses.keys()], ['a']);
  assert.deepEqual(c.missing.sort(), ['b', 'c']);
});

test('record on an unknown id returns false', () => {
  const { tracker, completions } = makeTracker();
  assert.equal(tracker.record(999, 'a', 'x'), false);
  assert.equal(completions.length, 0);
});

test('a reply from an untargeted slug is stored but does not gate completion', () => {
  const { tracker, completions } = makeTracker();
  tracker.start(300, { expectedSlugs: ['a'] });
  assert.equal(tracker.record(300, 'stranger', 'hi'), true);
  assert.equal(completions.length, 0, 'untargeted reply does not complete');
  tracker.record(300, 'a', 'A');
  assert.equal(completions.length, 1);
  assert.ok(completions[0].responses.has('stranger'));
  assert.ok(completions[0].responses.has('a'));
});

test('duplicate reply from the same slug completes exactly once', () => {
  const { tracker, completions } = makeTracker();
  tracker.start(400, { expectedSlugs: ['a'] });
  tracker.record(400, 'a', 'first');
  tracker.record(400, 'a', 'second'); // late update — broadcast already done
  assert.equal(completions.length, 1);
  assert.equal(completions[0].responses.get('a'), 'first', 'late reply ignored once completed');
});

test('empty expected set completes immediately (zero-reach broadcast)', () => {
  const { tracker, completions, timers } = makeTracker();
  tracker.start(500, { expectedSlugs: [] });
  assert.equal(completions.length, 1);
  assert.equal(completions[0].timedOut, false);
  assert.equal(completions[0].missing.length, 0);
  assert.equal(timers.scheduled.length, 0, 'no timer armed for a zero-reach broadcast');
});

test('cancel drops a broadcast without firing onComplete', () => {
  const { tracker, completions, timers } = makeTracker();
  tracker.start(600, { expectedSlugs: ['a'] });
  tracker.cancel(600);
  assert.equal(tracker.has(600), false);
  assert.equal(timers.scheduled[0].cleared, true);
  tracker.record(600, 'a', 'A'); // no-op now
  assert.equal(completions.length, 0);
});

test('re-starting the same id supersedes the prior broadcast', () => {
  const { tracker, completions, timers } = makeTracker();
  tracker.start(700, { expectedSlugs: ['a', 'b'] });
  tracker.record(700, 'a', 'old');
  tracker.start(700, { expectedSlugs: ['x'] }); // re-sent /all on the same anchor
  assert.equal(timers.scheduled[0].cleared, true, 'old timer cleared');
  tracker.record(700, 'x', 'new');
  assert.equal(completions.length, 1);
  assert.deepEqual([...completions[0].responses.keys()], ['x'], 'old responses discarded');
});

test('per-broadcast timeoutMs overrides the default', () => {
  const { tracker, timers } = makeTracker({ defaultTimeoutMs: DEFAULT_BROADCAST_TIMEOUT_MS });
  tracker.start(800, { expectedSlugs: ['a'], timeoutMs: 5000 });
  assert.equal(timers.scheduled[0].ms, 5000);
});

test('concurrent broadcasts on different ids are independent', () => {
  const { tracker, completions } = makeTracker();
  tracker.start(900, { expectedSlugs: ['a'] });
  tracker.start(901, { expectedSlugs: ['b'] });
  tracker.record(901, 'b', 'B');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].messageId, 901);
  assert.equal(tracker.has(900), true, 'other broadcast still in flight');
});
