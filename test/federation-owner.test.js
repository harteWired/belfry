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
