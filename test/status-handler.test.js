import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  buildAllSlugsDigest,
  buildSingleSlugDigest,
  listSlugs,
  makeStatusHandler,
} from '../lib/status-handler.js';

function tmpDir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-status-test-'));
  return p;
}

function writeStatus(dir, slug, payload) {
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(payload));
}

test('listSlugs: returns sorted slug list, ignores non-json', () => {
  const dir = tmpDir();
  writeStatus(dir, 'a', {});
  writeStatus(dir, 'b', {});
  fs.writeFileSync(path.join(dir, 'README'), 'ignore me');
  const slugs = listSlugs(dir).sort();
  assert.deepEqual(slugs, ['a', 'b']);
});

test('listSlugs: returns [] when statusDir missing', () => {
  assert.deepEqual(listSlugs('/nonexistent/path'), []);
});

test('buildAllSlugsDigest: empty dir → no-active message', () => {
  const dir = tmpDir();
  const out = buildAllSlugsDigest({ statusDir: dir });
  assert.match(out, /No active sessions/);
});

test('buildAllSlugsDigest: lists rows with status + relative time', () => {
  const dir = tmpDir();
  const now = Date.now();
  writeStatus(dir, 'belfry', { status: 'ready', statusLabel: 'Done', updatedAt: now - 10_000 });
  writeStatus(dir, 'api', { status: 'error', statusLabel: 'Errored', updatedAt: now - 90_000 });
  const out = buildAllSlugsDigest({ statusDir: dir });
  assert.match(out, /2 sessions/);
  // belfry is more recent — should appear before api
  const idxBelfry = out.indexOf('belfry');
  const idxApi = out.indexOf('api');
  assert.ok(idxBelfry < idxApi, 'most-recent slug listed first');
  assert.match(out, /belfry — Done/);
  assert.match(out, /api — Errored/);
});

test('buildAllSlugsDigest: caps at maxSlugs and notes the overflow', () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i++) writeStatus(dir, `s${i}`, { status: 'ready', updatedAt: Date.now() });
  const out = buildAllSlugsDigest({ statusDir: dir, maxSlugs: 2 });
  assert.match(out, /5 session/);
  assert.match(out, /…and 3 more/);
});

test('buildAllSlugsDigest: skips JSONs with parse errors', () => {
  const dir = tmpDir();
  writeStatus(dir, 'good', { status: 'ready' });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not valid json');
  const out = buildAllSlugsDigest({ statusDir: dir });
  assert.match(out, /good/);
  assert.doesNotMatch(out, /broken/);
});

test('buildSingleSlugDigest: missing JSON → not-recognized fallback', async () => {
  const dir = tmpDir();
  const out = await buildSingleSlugDigest({ slug: 'ghost', statusDir: dir });
  assert.match(out, /no dashboard JSON/);
});

test('buildSingleSlugDigest: no summarizeFn → single-line fallback with last_response', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', {
    status: 'ready',
    statusLabel: 'Done',
    last_response: 'Shipped the feature.',
    updatedAt: Date.now() - 5000,
  });
  const out = await buildSingleSlugDigest({ slug: 'belfry', statusDir: dir });
  assert.match(out, /belfry — Done/);
  assert.match(out, /Claude: Shipped the feature\./);
});

test('buildSingleSlugDigest: with summarizeFn → uses summary { prompt, response }', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', {
    status: 'ready',
    statusLabel: 'Done',
    last_prompt: 'add tests please',
    last_response: 'I added 13 tests',
    updatedAt: Date.now(),
  });
  const summarizeFn = async ({ prompt, response }) => {
    assert.equal(prompt, 'add tests please');
    assert.equal(response, 'I added 13 tests');
    return { prompt: 'add tests', response: 'added 13' };
  };
  const out = await buildSingleSlugDigest({
    slug: 'belfry',
    statusDir: dir,
    summarizeFn,
  });
  assert.match(out, /You: add tests/);
  assert.match(out, /Claude: added 13/);
});

test('buildSingleSlugDigest: summarizeFn returns null → falls back to last_response', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', {
    status: 'error',
    last_response: 'rate limited',
    updatedAt: Date.now(),
  });
  const out = await buildSingleSlugDigest({
    slug: 'belfry',
    statusDir: dir,
    summarizeFn: async () => null,
  });
  assert.match(out, /Claude: rate limited/);
});

test('buildSingleSlugDigest: summarizeFn returns both-null fields → falls back', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', {
    status: 'ready',
    last_response: 'something',
    updatedAt: Date.now(),
  });
  const out = await buildSingleSlugDigest({
    slug: 'belfry',
    statusDir: dir,
    summarizeFn: async () => ({ prompt: null, response: null }),
  });
  assert.match(out, /Claude: something/);
});

test('makeStatusHandler: routes single-slug request to send() with replyToMessageId', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', { status: 'ready', updatedAt: Date.now() });
  const sent = [];
  const handler = makeStatusHandler({
    statusDir: dir,
    send: async (args) => { sent.push(args); },
  });
  await handler({ slug: 'belfry', messageId: 42 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyToMessageId, 42);
  assert.match(sent[0].text, /belfry/);
});

test('makeStatusHandler: routes all-slugs request when slug is null', async () => {
  const dir = tmpDir();
  writeStatus(dir, 's1', { status: 'ready', updatedAt: Date.now() });
  writeStatus(dir, 's2', { status: 'ready', updatedAt: Date.now() });
  const sent = [];
  const handler = makeStatusHandler({
    statusDir: dir,
    send: async (args) => { sent.push(args); },
  });
  await handler({ slug: null, messageId: 7 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /2 sessions/);
});

test('makeStatusHandler: single-slug digest records its message_id against the slug', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', { status: 'ready', last_response: 'shipped', updatedAt: Date.now() });
  const recorded = [];
  const handler = makeStatusHandler({
    statusDir: dir,
    send: async () => ({ message_id: 999 }),
    recordReply: (msgId, slug) => recorded.push({ msgId, slug }),
  });
  await handler({ slug: 'belfry', messageId: 42 });
  assert.deepEqual(recorded, [{ msgId: 999, slug: 'belfry' }]);
});

test('makeStatusHandler: all-slugs digest does NOT record (no slug to bind to)', async () => {
  const dir = tmpDir();
  writeStatus(dir, 's', { status: 'ready', updatedAt: Date.now() });
  const recorded = [];
  const handler = makeStatusHandler({
    statusDir: dir,
    send: async () => ({ message_id: 999 }),
    recordReply: (msgId, slug) => recorded.push({ msgId, slug }),
  });
  await handler({ slug: null, messageId: 42 });
  assert.equal(recorded.length, 0);
});

test('makeStatusHandler: skips recordReply if send returns no message_id', async () => {
  const dir = tmpDir();
  writeStatus(dir, 'belfry', { status: 'ready', updatedAt: Date.now() });
  const recorded = [];
  const handler = makeStatusHandler({
    statusDir: dir,
    send: async () => undefined, // older send signature, no return value
    recordReply: (msgId, slug) => recorded.push({ msgId, slug }),
  });
  await handler({ slug: 'belfry', messageId: 42 });
  assert.equal(recorded.length, 0);
});

test('makeStatusHandler: send failure logs but does not throw', async () => {
  const dir = tmpDir();
  const logs = [];
  const handler = makeStatusHandler({
    statusDir: dir,
    send: async () => { throw new Error('telegram down'); },
    log: (m) => logs.push(m),
  });
  await handler({ slug: null, messageId: 1 });
  assert.ok(logs.some((m) => /send failed/.test(m)));
});
