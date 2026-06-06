import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBroadcastSummary } from '../lib/broadcast-summary.js';

test('complete summary uses the expected count as the denominator', () => {
  const s = buildBroadcastSummary({
    expected: ['a', 'b'],
    responses: new Map([['a', 'done A'], ['b', 'done B']]),
    missing: [],
    timedOut: false,
  });
  assert.match(s, /^📋 Broadcast complete \(2\/2\)/);
  assert.match(s, /• a: done A/);
  assert.match(s, /• b: done B/);
});

test('an untargeted responder does NOT inflate the denominator or appear', () => {
  // 'z' threaded under the anchor (e.g. a directed quote-reply) but was never targeted.
  const s = buildBroadcastSummary({
    expected: ['a', 'b'],
    responses: new Map([['a', 'A'], ['b', 'B'], ['z', 'stray']]),
    missing: [],
    timedOut: false,
  });
  assert.match(s, /\(2\/2\)/, 'denominator is the expected count, not responses.size');
  assert.doesNotMatch(s, /z:/, 'untargeted responder excluded from the roll-up');
});

test('timeout summary lists non-responders and counts only expected', () => {
  const s = buildBroadcastSummary({
    expected: ['a', 'b', 'c'],
    responses: new Map([['a', 'A']]),
    missing: ['b', 'c'],
    timedOut: true,
  });
  assert.match(s, /^⏱ Broadcast 1\/3 replied — no reply from: b, c/);
  assert.match(s, /• a: A/);
});

test('long replies are clipped to the line cap', () => {
  const long = 'x'.repeat(500);
  const s = buildBroadcastSummary({
    expected: ['a'],
    responses: new Map([['a', long]]),
    missing: [],
    lineCap: 50,
  });
  const line = s.split('\n')[1];
  assert.ok(line.length <= '• a: '.length + 50, `line was ${line.length} chars`);
  assert.ok(line.endsWith('…'));
});

test('whitespace in replies is collapsed to single spaces', () => {
  const s = buildBroadcastSummary({
    expected: ['a'],
    responses: new Map([['a', 'line one\n\n  line   two\ttabbed']]),
    missing: [],
  });
  assert.match(s, /• a: line one line two tabbed/);
});

test('lines preserve fan-out (expected) order, not response-arrival order', () => {
  const s = buildBroadcastSummary({
    expected: ['first', 'second', 'third'],
    responses: new Map([['third', '3'], ['first', '1'], ['second', '2']]),
    missing: [],
  });
  const slugs = s.split('\n').slice(1).map((l) => l.slice(2, l.indexOf(':')));
  assert.deepEqual(slugs, ['first', 'second', 'third']);
});
