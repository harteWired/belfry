import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PingDedup } from '../lib/ping-dedup.js';

test('PingDedup: first ping for a slug is never deduped', () => {
  const d = new PingDedup();
  assert.equal(d.shouldSkip('belfry', 1000), false);
});

test('PingDedup: identical last_response_at on second ping is deduped', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', 1000);
  assert.equal(d.shouldSkip('belfry', 1000), true);
});

test('PingDedup: advanced last_response_at fires the ping', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', 1000);
  assert.equal(d.shouldSkip('belfry', 1001), false);
  // And subsequent identical is deduped against the new value.
  assert.equal(d.shouldSkip('belfry', 1001), true);
});

test('PingDedup: regressed last_response_at also fires (treat as different)', () => {
  // If for any reason the hook wrote a smaller last_response_at than what
  // we last saw, it's still "different" and we fire. The dedup only
  // suppresses EXACT-equal values; we don't try to enforce monotonicity.
  const d = new PingDedup();
  d.shouldSkip('belfry', 1000);
  assert.equal(d.shouldSkip('belfry', 500), false);
});

test('PingDedup: per-slug isolation', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', 1000);
  // Different slug, same value — fires.
  assert.equal(d.shouldSkip('api', 1000), false);
});

test('PingDedup: missing or non-finite last_response_at never dedups', () => {
  const d = new PingDedup();
  // Two calls with undefined — both fire (caller will end up sending
  // two pings, but composer treats missing response as a minimal status
  // header, which is acceptable).
  assert.equal(d.shouldSkip('belfry', undefined), false);
  assert.equal(d.shouldSkip('belfry', undefined), false);
  // String / NaN / null / Infinity — all treated as missing.
  assert.equal(d.shouldSkip('belfry', null), false);
  assert.equal(d.shouldSkip('belfry', '1000'), false);
  assert.equal(d.shouldSkip('belfry', NaN), false);
  assert.equal(d.shouldSkip('belfry', Infinity), false);
});

test('PingDedup: setting a value after a missing call does not retroactively dedup', () => {
  // shouldSkip(slug, undefined) doesn't record anything. The next call
  // with a real value is the first "real" one for that slug.
  const d = new PingDedup();
  d.shouldSkip('belfry', undefined);
  assert.equal(d.shouldSkip('belfry', 1000), false);
  assert.equal(d.shouldSkip('belfry', 1000), true);
});
