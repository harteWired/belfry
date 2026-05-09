import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { NicknameRegistry, NICK_RE } from '../lib/nicknames.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-nicks-'));
}

test('NICK_RE: accepts valid shapes, rejects invalid', () => {
  for (const ok of ['a', 'ob', 'obsidian', '3d', '3d-print', 'a1', 'a-b-c', 'x'.repeat(32)]) {
    assert.ok(NICK_RE.test(ok), `should accept ${ok}`);
  }
  for (const bad of ['', '-foo', 'Foo', 'foo_bar', 'foo.bar', 'foo bar', 'x'.repeat(33), '/foo']) {
    assert.ok(!NICK_RE.test(bad), `should reject ${bad}`);
  }
});

test('set: rejects invalid nickname shape', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['ob']) });
  // Mixed case is auto-lowercased (friendlier UX). Truly invalid: leading
  // dash, empty, space, disallowed chars.
  for (const bad of ['-bad', '', 'foo bar', 'foo_bar', 'foo.bar', 'a'.repeat(33)]) {
    const out = r.set(bad, 'ob');
    assert.equal(out.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.match(out.reason, /invalid nickname/i);
  }
});

test('set: rejects reserved nicknames', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['ob']) });
  for (const reserved of ['status', 'nick', 'unnick', 'nicks']) {
    const out = r.set(reserved, 'ob');
    assert.equal(out.ok, false);
    assert.match(out.reason, /reserved/i);
  }
});

test('set: rejects when slug not in active dashboard', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['a', 'b']) });
  const out = r.set('foo', 'nonexistent');
  assert.equal(out.ok, false);
  assert.match(out.reason, /no active session/i);
  assert.match(out.reason, /a, b/);
});

test('set: rejects when nickname collides with an active slug', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['ob', 'foo']) });
  const out = r.set('foo', 'ob');
  assert.equal(out.ok, false);
  assert.match(out.reason, /collides with active slug/i);
});

test('set: lowercases nickname, accepts valid one', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['obsidian-vault']) });
  const out = r.set('OB', 'obsidian-vault');
  assert.equal(out.ok, true);
  assert.equal(r.resolve('ob'), 'obsidian-vault');
  assert.equal(r.resolve('OB'), 'obsidian-vault');
  assert.equal(r.resolve('Ob'), 'obsidian-vault');
});

test('resolve: returns null for unknown or non-string', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set() });
  assert.equal(r.resolve('missing'), null);
  assert.equal(r.resolve(undefined), null);
  assert.equal(r.resolve(42), null);
});

test('unset: returns true on existing, false on missing', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['ob']) });
  r.set('ob-nick', 'ob');
  assert.equal(r.unset('ob-nick'), true);
  assert.equal(r.resolve('ob-nick'), null);
  assert.equal(r.unset('ob-nick'), false);
});

test('list: returns shallow object snapshot', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['a', 'b']) });
  r.set('aa', 'a');
  r.set('bb', 'b');
  assert.deepEqual(r.list(), { aa: 'a', bb: 'b' });
});

test('reverseLookup: returns nicknames pointing at slug, sorted', () => {
  const r = new NicknameRegistry({ getActiveSlugs: () => new Set(['ob']) });
  r.set('zz', 'ob');
  r.set('aa', 'ob');
  r.set('mm', 'ob');
  assert.deepEqual(r.reverseLookup('ob'), ['aa', 'mm', 'zz']);
  assert.deepEqual(r.reverseLookup('other'), []);
});

test('persist: writes file with mode 0600 and parent dir 0700', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'nicknames.json');
  const r = new NicknameRegistry({ persistPath: file, getActiveSlugs: () => new Set(['ob']) });
  r.set('ob', 'ob');
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const dirStat = fs.statSync(path.dirname(file));
  assert.equal(dirStat.mode & 0o777, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load: rehydrates from persisted file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'n.json');
  fs.writeFileSync(file, JSON.stringify({ ob: 'obsidian', '3d': '3d-printing' }));
  const r = new NicknameRegistry({ persistPath: file, getActiveSlugs: () => new Set(['obsidian', '3d-printing']) });
  r.load();
  assert.equal(r.resolve('ob'), 'obsidian');
  assert.equal(r.resolve('3d'), '3d-printing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load: skips invalid nickname shapes from corrupted file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'n.json');
  fs.writeFileSync(file, JSON.stringify({ ob: 'good', 'BAD CASE': 'x', '': 'y', '-leading': 'z' }));
  const r = new NicknameRegistry({ persistPath: file, getActiveSlugs: () => new Set(['good']) });
  r.load();
  assert.deepEqual(r.list(), { ob: 'good' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load: missing file is silent', () => {
  const r = new NicknameRegistry({ persistPath: '/nonexistent/path/nicks.json' });
  r.load(); // should not throw
  assert.deepEqual(r.list(), {});
});

test('bootstrap: applies defaults only for entries persisted file does not cover', () => {
  const dir = tempDir();
  const file = path.join(dir, 'n.json');
  fs.writeFileSync(file, JSON.stringify({ ob: 'obsidian-existing' }));
  const r = new NicknameRegistry({
    persistPath: file,
    getActiveSlugs: () => new Set(['obsidian-existing', 'finance', '3d-printing']),
  });
  r.load();
  r.bootstrap({ ob: 'obsidian-shouldnotwin', fin: 'finance', '3d': '3d-printing' });
  assert.equal(r.resolve('ob'), 'obsidian-existing'); // persisted wins
  assert.equal(r.resolve('fin'), 'finance');
  assert.equal(r.resolve('3d'), '3d-printing');
  // After bootstrap, the file should reflect the merged state.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, { ob: 'obsidian-existing', fin: 'finance', '3d': '3d-printing' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bootstrap: skips reserved and invalid, auto-lowercases otherwise', () => {
  const dir = tempDir();
  const file = path.join(dir, 'n.json');
  const r = new NicknameRegistry({ persistPath: file, getActiveSlugs: () => new Set(['ob']) });
  r.bootstrap({ status: 'ob', '-bad': 'ob', '': 'ob', ok: 'ob', UP: 'ob' });
  // 'status' reserved; '-bad' invalid; '' invalid; 'UP' lowercased to 'up'.
  assert.deepEqual(r.list(), { ok: 'ob', up: 'ob' });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
