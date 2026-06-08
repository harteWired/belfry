/**
 * Webhook bridge config parsing (#29 Phase C). The slug→url map can come from
 * the BELFRY_BRIDGES env string or the belfry.jsonc `bridges` block; both must
 * validate slug + url and fail loudly on garbage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBridges } from '../lib/bridge.js';

test('parseBridges: env form, multiple entries', () => {
  const m = parseBridges({ env: { BELFRY_BRIDGES: 'life-planner=http://localhost:3200/api/inbox;notes=https://nas:8080/in' } });
  assert.equal(m.size, 2);
  assert.equal(m.get('life-planner'), 'http://localhost:3200/api/inbox');
  assert.equal(m.get('notes'), 'https://nas:8080/in');
});

test('parseBridges: file block form when env unset', () => {
  const m = parseBridges({ env: {}, file: { 'life-planner': 'http://localhost:3200/api/inbox' } });
  assert.equal(m.get('life-planner'), 'http://localhost:3200/api/inbox');
});

test('parseBridges: env wins over file block', () => {
  const m = parseBridges({
    env: { BELFRY_BRIDGES: 'a=http://x/1' },
    file: { b: 'http://y/2' },
  });
  assert.deepEqual([...m.keys()], ['a']);
});

test('parseBridges: empty when neither set', () => {
  assert.equal(parseBridges({}).size, 0);
  assert.equal(parseBridges({ env: { BELFRY_BRIDGES: '   ' } }).size, 0);
});

test('parseBridges: rejects a non-http url', () => {
  assert.throws(() => parseBridges({ env: { BELFRY_BRIDGES: 'lp=ftp://nope' } }), /http\(s\)/);
});

test('parseBridges: rejects a malformed entry (no =)', () => {
  assert.throws(() => parseBridges({ env: { BELFRY_BRIDGES: 'just-a-slug' } }), /malformed/);
});

test('parseBridges: rejects a bad slug', () => {
  assert.throws(() => parseBridges({ env: { BELFRY_BRIDGES: 'bad slug=http://x' } }), /invalid slug/);
});
