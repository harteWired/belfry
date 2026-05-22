import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PingDedup } from '../lib/ping-dedup.js';

test('PingDedup: first ping for a slug is never deduped', () => {
  const d = new PingDedup();
  assert.equal(d.shouldSkip('belfry', 'hello'), false);
});

test('PingDedup: identical last_response on second ping is deduped (watchdog case)', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', 'investigating now');
  assert.equal(d.shouldSkip('belfry', 'investigating now'), true);
});

test('PingDedup: changed last_response fires the ping', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', 'first response');
  assert.equal(d.shouldSkip('belfry', 'second response'), false);
  // And the next identical is deduped against the new value.
  assert.equal(d.shouldSkip('belfry', 'second response'), true);
});

test('PingDedup: per-slug isolation', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', 'hello');
  // Different slug, same text — fires.
  assert.equal(d.shouldSkip('api', 'hello'), false);
});

test('PingDedup: missing / empty / non-string last_response never dedups', () => {
  const d = new PingDedup();
  assert.equal(d.shouldSkip('belfry', undefined), false);
  assert.equal(d.shouldSkip('belfry', undefined), false);
  assert.equal(d.shouldSkip('belfry', null), false);
  assert.equal(d.shouldSkip('belfry', ''), false);
  assert.equal(d.shouldSkip('belfry', 12345), false);
});

test('PingDedup: missing last_response does not retroactively dedup a later real value', () => {
  const d = new PingDedup();
  d.shouldSkip('belfry', undefined);
  assert.equal(d.shouldSkip('belfry', 'hello'), false);
  assert.equal(d.shouldSkip('belfry', 'hello'), true);
});

test('PingDedup: recordJustSent suppresses the matching ready ping (reply-tool echo)', () => {
  let now = 1_000_000;
  const d = new PingDedup({ now: () => now });
  d.recordJustSent('belfry', 'reply via MCP tool');
  // Stop hook fires next; the watcher reports the same text in last_response.
  now += 50;
  assert.equal(d.shouldSkip('belfry', 'reply via MCP tool'), true);
});

test('PingDedup: recordJustSent stash expires past the window', () => {
  let now = 1_000_000;
  const d = new PingDedup({ replyEchoWindowMs: 10_000, now: () => now });
  d.recordJustSent('belfry', 'reply');
  // Past the window. recordJustSent does not seed lastBySlug, so the first
  // shouldSkip after expiry behaves like the first ping for that content.
  now += 11_000;
  assert.equal(d.shouldSkip('belfry', 'reply'), false);
});

test('PingDedup: recordJustSent is per-slug', () => {
  const d = new PingDedup();
  d.recordJustSent('belfry', 'hello');
  // Different slug, same text — no stash for that slug, falls back to first-ping.
  assert.equal(d.shouldSkip('other', 'hello'), false);
});

test('PingDedup: recordJustSent ignores empty / non-string text', () => {
  const d = new PingDedup();
  d.recordJustSent('belfry', '');
  d.recordJustSent('belfry', undefined);
  d.recordJustSent('belfry', null);
  d.recordJustSent('belfry', 42);
  // No stash recorded; first shouldSkip with content fires normally.
  assert.equal(d.shouldSkip('belfry', 'hello'), false);
});

test('PingDedup: recordJustSent only suppresses matching text, not arbitrary pings', () => {
  const d = new PingDedup();
  d.recordJustSent('belfry', 'reply A');
  // Different text → not the echo. Falls through to content equality
  // (first time, so fires).
  assert.equal(d.shouldSkip('belfry', 'reply B'), false);
});

test('PingDedup: post-echo /loop watchdog ticks are also suppressed (content path)', () => {
  // After a reply-tool send + echo suppression, a subsequent watchdog turn
  // carrying the same text should ALSO be suppressed — the echo path updates
  // lastBySlug so the content-equality path holds even after the window expires.
  let now = 1_000_000;
  const d = new PingDedup({ replyEchoWindowMs: 10_000, now: () => now });
  d.recordJustSent('belfry', 'echoed text');
  assert.equal(d.shouldSkip('belfry', 'echoed text'), true);
  now += 20_000; // window expires
  // /loop watchdog re-fires with unchanged content.
  assert.equal(d.shouldSkip('belfry', 'echoed text'), true);
});

test('PingDedup: recordJustSent updates ts on each call', () => {
  let now = 1_000_000;
  const d = new PingDedup({ replyEchoWindowMs: 10_000, now: () => now });
  d.recordJustSent('belfry', 'reply');
  now += 9_000; // still within window
  d.recordJustSent('belfry', 'reply'); // refreshes ts
  now += 5_000; // 14s past first call, 5s past the refresh — still within window
  assert.equal(d.shouldSkip('belfry', 'reply'), true);
});
