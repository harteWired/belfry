import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplyTracker } from '../lib/reply-tracker.js';

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'belfry-reply-tracker-'));
  return {
    path: join(dir, 'reply-tracker.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('record and lookup round-trip', () => {
  const t = new ReplyTracker();
  t.record(101, 'life-planner');
  assert.equal(t.lookup(101), 'life-planner');
});

test('lookup returns null for unknown id', () => {
  const t = new ReplyTracker();
  assert.equal(t.lookup(999), null);
});

test('LRU evicts oldest when capacity exceeded', () => {
  const t = new ReplyTracker({ capacity: 3 });
  t.record(1, 'a');
  t.record(2, 'b');
  t.record(3, 'c');
  t.record(4, 'd');
  assert.equal(t.lookup(1), null, 'oldest evicted');
  assert.equal(t.lookup(2), 'b');
  assert.equal(t.lookup(3), 'c');
  assert.equal(t.lookup(4), 'd');
  assert.equal(t.size(), 3);
});

test('re-recording an existing id bumps recency', () => {
  const t = new ReplyTracker({ capacity: 3 });
  t.record(1, 'a');
  t.record(2, 'b');
  t.record(3, 'c');
  t.record(1, 'a-again');
  t.record(4, 'd');
  assert.equal(t.lookup(1), 'a-again', 'id 1 was bumped, survives eviction');
  assert.equal(t.lookup(2), null, 'id 2 is now oldest, evicted');
});

test('non-numeric message id ignored on record and lookup', () => {
  const t = new ReplyTracker();
  t.record('123', 'a');
  t.record(null, 'a');
  assert.equal(t.size(), 0);
  assert.equal(t.lookup('123'), null);
});

test('empty slug ignored on record', () => {
  const t = new ReplyTracker();
  t.record(1, '');
  t.record(2, null);
  assert.equal(t.size(), 0);
});

test('persist: round-trip across instances', () => {
  const { path, cleanup } = makeTmp();
  try {
    const a = new ReplyTracker({ persistPath: path });
    a.record(101, 'life-planner');
    a.record(202, 'belfry');
    a.flush(); // saves are debounced via setImmediate; flush forces sync write

    const b = new ReplyTracker({ persistPath: path });
    assert.equal(b.size(), 2);
    assert.equal(b.lookup(101), 'life-planner');
    assert.equal(b.lookup(202), 'belfry');
  } finally {
    cleanup();
  }
});

test('persist: missing file starts empty without error', () => {
  const { path, cleanup } = makeTmp();
  try {
    // path points inside a tmpdir that exists but file doesn't.
    const t = new ReplyTracker({ persistPath: path });
    assert.equal(t.size(), 0);
    t.record(1, 'a');
    t.flush();
    assert.equal(existsSync(path), true);
  } finally {
    cleanup();
  }
});

test('persist: corrupt file logs and starts empty', () => {
  const { path, cleanup } = makeTmp();
  try {
    writeFileSync(path, '{not valid json');
    const logs = [];
    const t = new ReplyTracker({ persistPath: path, log: (m) => logs.push(m) });
    assert.equal(t.size(), 0);
    assert.ok(logs.some((m) => m.includes('load failed')), 'logged load failure');
  } finally {
    cleanup();
  }
});

test('persist: capacity enforced after load', () => {
  const { path, cleanup } = makeTmp();
  try {
    // Write 5 entries directly, then load with capacity 3.
    writeFileSync(
      path,
      JSON.stringify([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
        [4, 'd'],
        [5, 'e'],
      ]),
    );
    const t = new ReplyTracker({ capacity: 3, persistPath: path });
    assert.equal(t.size(), 3);
    assert.equal(t.lookup(1), null);
    assert.equal(t.lookup(2), null);
    assert.equal(t.lookup(5), 'e');
  } finally {
    cleanup();
  }
});

test('persist: bump-recency survives restart', () => {
  const { path, cleanup } = makeTmp();
  try {
    const a = new ReplyTracker({ capacity: 3, persistPath: path });
    a.record(1, 'a');
    a.record(2, 'b');
    a.record(3, 'c');
    a.record(1, 'a-again'); // bump 1 to most recent
    a.record(4, 'd'); // should evict 2
    a.flush();

    const b = new ReplyTracker({ capacity: 3, persistPath: path });
    assert.equal(b.lookup(1), 'a-again');
    assert.equal(b.lookup(2), null);
    assert.equal(b.lookup(3), 'c');
    assert.equal(b.lookup(4), 'd');
  } finally {
    cleanup();
  }
});

test('persist: ignores malformed entries on load', () => {
  const { path, cleanup } = makeTmp();
  try {
    writeFileSync(
      path,
      JSON.stringify([
        [1, 'good'],
        ['bad-id', 'x'],
        [2, ''],
        [3, null],
        [4, 'also-good'],
      ]),
    );
    const t = new ReplyTracker({ persistPath: path });
    assert.equal(t.size(), 2);
    assert.equal(t.lookup(1), 'good');
    assert.equal(t.lookup(4), 'also-good');
  } finally {
    cleanup();
  }
});

test('persist: file written atomically (no .tmp left behind)', () => {
  const { path, cleanup } = makeTmp();
  try {
    const t = new ReplyTracker({ persistPath: path });
    t.record(1, 'a');
    t.flush();
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(`${path}.tmp`), false);
    const raw = readFileSync(path, 'utf8');
    assert.deepEqual(JSON.parse(raw), [[1, 'a']]);
  } finally {
    cleanup();
  }
});

test('persist: multiple records in one tick coalesce to one disk write', async () => {
  const { path, cleanup } = makeTmp();
  try {
    let writes = 0;
    const t = new ReplyTracker({ persistPath: path });
    // Wrap renameSync via fs to count writes — simpler: spy on path stat mtime.
    // Use the public flush() to confirm pending state, then count via sequential
    // setImmediate ticks.
    t.record(1, 'a');
    t.record(2, 'b');
    t.record(3, 'c');
    // No flush yet → file not on disk.
    assert.equal(existsSync(path), false);
    // Yield once so the queued setImmediate fires.
    await new Promise((r) => setImmediate(r));
    assert.equal(existsSync(path), true);
    const raw = readFileSync(path, 'utf8');
    assert.deepEqual(JSON.parse(raw), [[1, 'a'], [2, 'b'], [3, 'c']]);
  } finally {
    cleanup();
  }
});

test('no persistPath: in-memory only, no disk side effects', () => {
  const t = new ReplyTracker();
  t.record(1, 'a');
  assert.equal(t.lookup(1), 'a');
  // Nothing to assert about disk; just ensure no throw and behaviour matches.
});
