import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramOwner, ROLE_OWNER, ROLE_STANDBY, ROLE_UNKNOWN,
} from '../lib/federation-owner.js';

// rand=0 → no jitter, so waitMs equals the base interval.
const noJitter = () => 0;

test('starts in the unknown role', () => {
  const o = new TelegramOwner({ rand: noJitter });
  assert.equal(o.role, ROLE_UNKNOWN);
  assert.equal(o.isOwner(), false);
});

test('ok → owner, poll again immediately', () => {
  const o = new TelegramOwner({ rand: noJitter });
  const r = o.record('ok');
  assert.equal(r.role, ROLE_OWNER);
  assert.equal(r.waitMs, 0);
  assert.equal(r.changed, true);
  assert.equal(o.isOwner(), true);
});

test('conflict → standby, retry after the standby interval', () => {
  const o = new TelegramOwner({ standbyIntervalMs: 15000, rand: noJitter });
  const r = o.record('conflict');
  assert.equal(r.role, ROLE_STANDBY);
  assert.equal(r.waitMs, 15000);
});

test('error while owner → demote to unknown and retry soon', () => {
  const o = new TelegramOwner({ errorBackoffMs: 3000, rand: noJitter });
  o.record('ok'); // owner
  const r = o.record('error');
  assert.equal(r.role, ROLE_UNKNOWN);
  assert.equal(r.waitMs, 3000);
  assert.equal(r.changed, true);
});

test('error while standby keeps standby role', () => {
  const o = new TelegramOwner({ rand: noJitter });
  o.record('conflict'); // standby
  const r = o.record('error');
  assert.equal(r.role, ROLE_STANDBY);
  assert.equal(r.changed, false);
});

test('takeover: standby then a successful poll becomes owner', () => {
  const o = new TelegramOwner({ rand: noJitter });
  o.record('conflict');
  assert.equal(o.isOwner(), false);
  const r = o.record('ok'); // previous owner died, our retry won
  assert.equal(r.role, ROLE_OWNER);
  assert.equal(r.changed, true);
});

test('jitter widens the wait but never below the base', () => {
  const o = new TelegramOwner({ standbyIntervalMs: 1000, jitter: 0.5, rand: () => 1 });
  const r = o.record('conflict');
  assert.equal(r.waitMs, 1500); // 1000 * (1 + 0.5*1)
});

// --- reachableAt (#38): proves we reached Telegram, for the priority gate ---

test('reachableAt starts at 0 (never reached Telegram)', () => {
  const o = new TelegramOwner({ rand: noJitter });
  assert.equal(o.reachableAt, 0);
});

test('ok advances reachableAt (we own it → reachable)', () => {
  const o = new TelegramOwner({ rand: noJitter, now: () => 5000 });
  o.record('ok');
  assert.equal(o.reachableAt, 5000);
});

test('conflict advances reachableAt (a 409 still reached Telegram)', () => {
  const o = new TelegramOwner({ rand: noJitter, now: () => 7000 });
  o.record('conflict');
  assert.equal(o.reachableAt, 7000);
});

test('error does NOT advance reachableAt (never reached Telegram)', () => {
  let t = 1000;
  const o = new TelegramOwner({ rand: noJitter, now: () => t });
  o.record('ok'); // reachableAt = 1000
  t = 9000;
  o.record('error'); // egress dead — must stay frozen
  assert.equal(o.reachableAt, 1000);
});

test('preempt stands by but does NOT touch reachableAt (no Telegram round-trip)', () => {
  let t = 2000;
  const o = new TelegramOwner({ rand: noJitter, now: () => t });
  o.record('ok'); // owner, reachableAt = 2000
  t = 8000;
  const r = o.preempt();
  assert.equal(r.role, ROLE_STANDBY);
  assert.equal(r.changed, true);
  assert.equal(o.reachableAt, 2000); // unchanged — choosing not to poll proves nothing
});

test('preempt from standby is idempotent (changed:false)', () => {
  const o = new TelegramOwner({ rand: noJitter });
  o.record('conflict'); // standby
  const r = o.preempt();
  assert.equal(r.role, ROLE_STANDBY);
  assert.equal(r.changed, false);
});
