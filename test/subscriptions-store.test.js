/**
 * SubscriptionsStore (#40) — live watch overrides + persistence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SubscriptionsStore } from '../lib/subscriptions-store.js';

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-subs-')), 'overrides.json');
}

test('watch mutates the live subscriptions object in place and persists', () => {
  const subs = {};
  const p = tmp();
  const store = new SubscriptionsStore({ subscriptions: subs, persistPath: p });
  const sub = store.watch('api');
  assert.deepEqual(sub.events, ['ready', 'error'], 'default watch events');
  assert.ok(subs.api, 'the SAME live object is mutated (daemon reads this)');
  assert.equal(store.isWatched('api'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).api, { events: ['ready', 'error'] });
});

test('unwatch deletes the sub and records an explicit-off override', () => {
  const subs = { api: { events: ['ready'] } };
  const p = tmp();
  const store = new SubscriptionsStore({ subscriptions: subs, persistPath: p });
  store.unwatch('api');
  assert.equal(subs.api, undefined);
  assert.equal(store.isWatched('api'), false);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).api, false);
});

test('toggle flips and returns the new state', () => {
  const store = new SubscriptionsStore({ subscriptions: {}, persistPath: tmp() });
  assert.equal(store.toggle('x'), true);
  assert.equal(store.isWatched('x'), true);
  assert.equal(store.toggle('x'), false);
  assert.equal(store.isWatched('x'), false);
});

test('watch sanitizes invalid events and dedups', () => {
  const store = new SubscriptionsStore({ subscriptions: {}, persistPath: tmp() });
  const sub = store.watch('api', ['ready', 'bogus', 'WAITING', 'ready']);
  assert.deepEqual(sub.events, ['ready', 'waiting']);
});

test('watch with all-invalid events falls back to the default', () => {
  const store = new SubscriptionsStore({ subscriptions: {}, persistPath: tmp() });
  assert.deepEqual(store.watch('api', ['nope']).events, ['ready', 'error']);
});

test('load applies overrides over jsonc subs (add a watch, force one off, keep the rest)', () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ added: { events: ['ready'] }, removed: false }));
  const subs = { removed: { events: ['error'] }, kept: { events: ['ready'] } };
  const store = new SubscriptionsStore({ subscriptions: subs, persistPath: p });
  assert.ok(subs.added, 'override added a watch');
  assert.equal(subs.removed, undefined, 'explicit-off removed a jsonc sub');
  assert.ok(subs.kept, 'untouched jsonc sub preserved');
  assert.equal(store.isWatched('added'), true);
});

test('watch preserves an existing summarize/digest/topic', () => {
  const subs = { api: { events: ['ready'], summarize: true, digest: false, topic: 42 } };
  const store = new SubscriptionsStore({ subscriptions: subs, persistPath: tmp() });
  const sub = store.watch('api', ['error']);
  assert.deepEqual(sub.events, ['error']);
  assert.equal(sub.summarize, true);
  assert.equal(sub.topic, 42);
});

test('list returns sorted watched slugs', () => {
  const store = new SubscriptionsStore({ subscriptions: { b: { events: ['ready'] }, a: { events: ['ready'] } }, persistPath: tmp() });
  assert.deepEqual(store.list(), ['a', 'b']);
});

test('managedSlugs includes both watched and explicitly-unwatched slugs', () => {
  const store = new SubscriptionsStore({ subscriptions: { kept: { events: ['ready'] } }, persistPath: tmp() });
  store.watch('added');
  store.unwatch('removed'); // explicit-off override — must still be "managed"
  assert.deepEqual(store.managedSlugs().sort(), ['added', 'kept', 'removed']);
});

test('missing overrides file is a no-op', () => {
  const subs = { api: { events: ['ready'] } };
  const store = new SubscriptionsStore({ subscriptions: subs, persistPath: path.join(os.tmpdir(), 'does-not-exist-belfry.json') });
  assert.deepEqual(store.list(), ['api']);
});
