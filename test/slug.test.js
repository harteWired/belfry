import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveSlug, resolveSlug } from '../lib/slug.js';

test('CLAUDE_SESSION_SLUG wins when set', () => {
  const slug = deriveSlug({
    cwd: '/workspace/projects/anything',
    env: { CLAUDE_SESSION_SLUG: 'neutral-name', CLAUDELIKE_BAR_NAME: 'legacy-name' },
  });
  assert.equal(slug, 'neutral-name');
});

test('CLAUDELIKE_BAR_NAME used as legacy fallback when CLAUDE_SESSION_SLUG absent', () => {
  const slug = deriveSlug({
    cwd: '/workspace/projects/anything',
    env: { CLAUDELIKE_BAR_NAME: 'override-name' },
  });
  assert.equal(slug, 'override-name');
});

test('neutral slug index wins over legacy index', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'claude-session-slugs.json'),
    JSON.stringify({ '/p': 'neutral' }),
  );
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'claudelike-bar-paths.json'),
    JSON.stringify({ '/p': 'legacy' }),
  );
  const slug = deriveSlug({ cwd: '/p', env: {}, homeDir: tmpHome });
  assert.equal(slug, 'neutral');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('falls through to legacy index when neutral index is absent', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'claudelike-bar-paths.json'),
    JSON.stringify({ '/q': 'from-legacy' }),
  );
  const slug = deriveSlug({ cwd: '/q', env: {}, homeDir: tmpHome });
  assert.equal(slug, 'from-legacy');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('falls back to basename when no env and no index', () => {
  // Use an isolated home with no index file present.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  const slug = deriveSlug({
    cwd: '/workspace/projects/life-planner',
    env: {},
    homeDir: tmpHome,
  });
  assert.equal(slug, 'life-planner');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('uses path index lookup when present', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'claudelike-bar-paths.json'),
    JSON.stringify({ '/some/odd/path': 'pretty-name' }),
  );
  const slug = deriveSlug({
    cwd: '/some/odd/path',
    env: {},
    homeDir: tmpHome,
  });
  assert.equal(slug, 'pretty-name');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('sanitizes path-separator and reserved chars', () => {
  const slug = deriveSlug({
    cwd: '/whatever',
    env: { CLAUDELIKE_BAR_NAME: 'foo/bar:baz?qux' },
  });
  assert.equal(slug, 'foo_bar_baz_qux');
});

test('strips newlines', () => {
  const slug = deriveSlug({
    cwd: '/whatever',
    env: { CLAUDELIKE_BAR_NAME: 'foo\nbar' },
  });
  assert.equal(slug, 'foobar');
});

test('strips leading/trailing dots', () => {
  const slug = deriveSlug({
    cwd: '/whatever',
    env: { CLAUDELIKE_BAR_NAME: '...weird...' },
  });
  assert.equal(slug, 'weird');
});

test('empty after sanitization → unknown', () => {
  const slug = deriveSlug({
    cwd: '/whatever',
    env: { CLAUDELIKE_BAR_NAME: '...' },
  });
  assert.equal(slug, 'unknown');
});

// --- Status-File Contract v1 (#40): ancestor-walk + STRICT gate ---

function withIndex(indexName, mapping) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.claude', indexName), JSON.stringify(mapping));
  return tmpHome;
}

test('ancestor-walk: a subdirectory resolves to its registered project root', () => {
  const tmpHome = withIndex('claude-session-slugs.json', {
    '/workspace/projects/travel-planner': 'travel-planner',
  });
  // A session opened deep inside the project (the junk-minting case: the old
  // exact-key lookup would have fallen back to basename 'dads-70th-2026').
  const r = resolveSlug({
    cwd: '/workspace/projects/travel-planner/itineraries/dads-70th-2026',
    env: {},
    homeDir: tmpHome,
  });
  assert.equal(r.slug, 'travel-planner');
  assert.equal(r.matched, true);
  assert.equal(r.source, 'index:claude-session-slugs');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('ancestor-walk: nearest registered ancestor wins over a higher one', () => {
  const tmpHome = withIndex('claudelike-bar-paths.json', {
    '/workspace/projects': 'projects-root',
    '/workspace/projects/api': 'api',
  });
  const r = resolveSlug({
    cwd: '/workspace/projects/api/src/routes',
    env: {},
    homeDir: tmpHome,
  });
  assert.equal(r.slug, 'api', 'closest ancestor (api), not the higher projects-root');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('ancestor-walk: trailing slash on cwd is normalized', () => {
  const tmpHome = withIndex('claude-session-slugs.json', {
    '/workspace/projects/belfry': 'belfry',
  });
  const r = resolveSlug({
    cwd: '/workspace/projects/belfry/',
    env: {},
    homeDir: tmpHome,
  });
  assert.equal(r.slug, 'belfry');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('STRICT (default): no env + no registered ancestor → slug null (skip)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-')); // no index
  const r = resolveSlug({
    cwd: '/workspace/projects/unregistered-subdir',
    env: {},
    homeDir: tmpHome,
  });
  assert.equal(r.slug, null);
  assert.equal(r.matched, false);
  assert.equal(r.source, 'none');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('STRICT: empty-after-sanitize → slug null (does not become "unknown")', () => {
  const r = resolveSlug({ cwd: '/whatever', env: { CLAUDELIKE_BAR_NAME: '...' } });
  assert.equal(r.slug, null);
  assert.equal(r.matched, true, 'a name WAS supplied; it just sanitized away');
});

test('LEGACY (CLAUDELIKE_BAR_STRICT=0): no match falls back to basename', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  const r = resolveSlug({
    cwd: '/workspace/projects/life-planner',
    env: { CLAUDELIKE_BAR_STRICT: '0' },
    homeDir: tmpHome,
  });
  assert.equal(r.slug, 'life-planner');
  assert.equal(r.matched, false);
  assert.equal(r.source, 'basename');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('LEGACY escape accepts other falsy tokens (false/off/no)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  for (const tok of ['false', 'off', 'no', 'FALSE']) {
    const r = resolveSlug({ cwd: '/x/y/zed', env: { CLAUDELIKE_BAR_STRICT: tok }, homeDir: tmpHome });
    assert.equal(r.slug, 'zed', `token ${tok} should disable STRICT`);
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('deriveSlug stays STRICT-off (always returns a string, backward compatible)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-slug-'));
  // No env, no index — STRICT would skip, but deriveSlug must still return a slug.
  const slug = deriveSlug({ cwd: '/workspace/projects/api', env: {}, homeDir: tmpHome });
  assert.equal(slug, 'api');
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('resolveSlug: CLAUDE_SESSION_SLUG reports its source', () => {
  const r = resolveSlug({ cwd: '/x', env: { CLAUDE_SESSION_SLUG: 'neat' } });
  assert.equal(r.slug, 'neat');
  assert.equal(r.matched, true);
  assert.equal(r.source, 'env:CLAUDE_SESSION_SLUG');
});
