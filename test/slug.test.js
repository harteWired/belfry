import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveSlug } from '../lib/slug.js';

test('CLAUDELIKE_BAR_NAME wins when set', () => {
  const slug = deriveSlug({
    cwd: '/workspace/projects/anything',
    env: { CLAUDELIKE_BAR_NAME: 'override-name' },
  });
  assert.equal(slug, 'override-name');
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
