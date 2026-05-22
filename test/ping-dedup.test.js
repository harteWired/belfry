import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PingDedup } from '../lib/ping-dedup.js';

// --- Content-equality guard (/loop watchdog case) ---

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
  d.shouldSkip('belfry', 'first');
  assert.equal(d.shouldSkip('belfry', 'second'), false);
  // And the next identical is deduped against the new value.
  assert.equal(d.shouldSkip('belfry', 'second'), true);
});

test('PingDedup: per-slug isolation for content equality', () => {
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

// --- Muzzle (reply-tool / auto-reply echo case) ---

test('PingDedup: muzzleNext suppresses the next ready ping for that slug', () => {
  let now = 1_000_000;
  const d = new PingDedup({ now: () => now });
  d.muzzleNext('belfry');
  now += 50;
  // The post-turn ready ping carries DIFFERENT text than the reply tool arg
  // (the model's prose around the tool call) — muzzle catches it anyway.
  assert.equal(d.shouldSkip('belfry', "I'll send a Telegram reply now."), true);
});

test('PingDedup: muzzle is single-shot — consumed on first match', () => {
  let now = 1_000_000;
  const d = new PingDedup({ muzzleWindowMs: 30_000, now: () => now });
  d.muzzleNext('belfry');
  assert.equal(d.shouldSkip('belfry', 'echo text'), true);
  // Window has NOT expired but the muzzle was consumed. A second
  // different-content ready ping within the window must fire normally.
  now += 5_000;
  assert.equal(d.shouldSkip('belfry', 'a legitimate new turn finished'), false);
});

test('PingDedup: muzzle expires past the window', () => {
  let now = 1_000_000;
  const d = new PingDedup({ muzzleWindowMs: 30_000, now: () => now });
  d.muzzleNext('belfry');
  now += 31_000;
  // Muzzle is past expiry — falls through to content equality (first
  // ping for this content, so fires).
  assert.equal(d.shouldSkip('belfry', 'late ping'), false);
});

test('PingDedup: muzzle is per-slug', () => {
  const d = new PingDedup();
  d.muzzleNext('belfry');
  // Different slug — no muzzle, fires normally.
  assert.equal(d.shouldSkip('other', 'anything'), false);
});

test('PingDedup: muzzleNext rejects empty / non-string slug', () => {
  const d = new PingDedup();
  d.muzzleNext('');
  d.muzzleNext(undefined);
  d.muzzleNext(null);
  d.muzzleNext(42);
  // No muzzle armed — first ping for the slug fires normally.
  assert.equal(d.shouldSkip('belfry', 'anything'), false);
});

test('PingDedup: muzzle re-arm refreshes the expiry', () => {
  let now = 1_000_000;
  const d = new PingDedup({ muzzleWindowMs: 30_000, now: () => now });
  d.muzzleNext('belfry');
  now += 25_000;
  d.muzzleNext('belfry'); // refresh — window resets from this point
  now += 10_000; // 35s past first arm, 10s past refresh — still inside window
  assert.equal(d.shouldSkip('belfry', 'anything'), true);
});

test('PingDedup: post-muzzle watchdog ticks still deduped via content path', () => {
  // After a reply-tool send + muzzle consumption, the slug's lastBySlug is
  // seeded to the muzzled content. A later /loop watchdog tick carrying
  // that same text is then caught by the content-equality guard.
  let now = 1_000_000;
  const d = new PingDedup({ muzzleWindowMs: 30_000, now: () => now });
  d.muzzleNext('belfry');
  assert.equal(d.shouldSkip('belfry', 'echoed text'), true);
  now += 60_000; // long past the muzzle window
  // /loop watchdog re-fires with same content — content path catches it.
  assert.equal(d.shouldSkip('belfry', 'echoed text'), true);
});

// --- Self-eviction (Map growth) ---

test('PingDedup: expired muzzle entries are evicted on read', () => {
  let now = 1_000_000;
  const d = new PingDedup({ muzzleWindowMs: 30_000, now: () => now });
  d.muzzleNext('belfry');
  assert.equal(d.muzzleBySlug.has('belfry'), true);
  now += 31_000;
  d.shouldSkip('belfry', 'first ping after expiry');
  // shouldSkip noticed the expiry and cleaned the entry up.
  assert.equal(d.muzzleBySlug.has('belfry'), false);
});

test('PingDedup: consumed muzzle entries are evicted on match', () => {
  const d = new PingDedup();
  d.muzzleNext('belfry');
  assert.equal(d.muzzleBySlug.has('belfry'), true);
  d.shouldSkip('belfry', 'echo');
  // The match consumed the muzzle.
  assert.equal(d.muzzleBySlug.has('belfry'), false);
});
