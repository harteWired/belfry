/**
 * StatusWatcher startup-cache seeding (#slug-listing fix).
 *
 * chokidar 4's awaitWriteFinish suppresses the initial 'add' events for
 * pre-existing static files, so without seedCache() the in-memory cache only
 * ever holds sessions that change AFTER the daemon boots — which made the
 * brain's list_sessions blind to every idle session. These tests pin the seed
 * behaviour: the cache is complete from start(), malformed/non-json files are
 * skipped, and seeding does NOT fire onUpdate (no spurious startup pings).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StatusWatcher } from '../lib/watcher.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-watcher-test-'));
}

test('seedCache primes the cache from pre-existing files at startup', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'alpha.json'), JSON.stringify({ status: 'ready', last_response: 'hi' }));
  fs.writeFileSync(path.join(dir, 'beta.json'), JSON.stringify({ status: 'working' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'nope');

  const updates = [];
  const w = new StatusWatcher({ statusDir: dir, onUpdate: (u) => updates.push(u.slug) });
  w.start();
  try {
    const cache = w.getActiveSlugsFromCache();
    assert.ok(cache.has('alpha'), 'alpha seeded into cache');
    assert.ok(cache.has('beta'), 'beta seeded into cache');
    assert.ok(!cache.has('broken'), 'malformed json skipped');
    assert.ok(!cache.has('ignore'), 'non-json file ignored');
    assert.equal(w.lastSeen.get('alpha').status, 'ready', 'seeded payload is the parsed status file');
    // The whole point: seeding must not emit onUpdate, or every pre-existing
    // session would fire a ping on every daemon restart.
    assert.deepEqual(updates, [], 'seed does not fire onUpdate');
  } finally {
    await w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seedCache is a no-op on an empty dir', async () => {
  const dir = tmpDir();
  const w = new StatusWatcher({ statusDir: dir, onUpdate: () => {} });
  w.start();
  try {
    assert.equal(w.getActiveSlugsFromCache().size, 0);
  } finally {
    await w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
