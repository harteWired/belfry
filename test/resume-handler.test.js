import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeResumeHandler } from '../lib/resume-handler.js';

function fakeSender() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { message_id: 100 + calls.length };
  };
  fn.calls = calls;
  return fn;
}

const SAMPLE_SESSIONS = [
  { slug: 'belfry', cwd: '/workspace/projects/belfry', uuid: 'abc12345-aaaa', mtimeMs: Date.now() - 60_000, lastUser: 'fix the test' },
  { slug: 'life-planner', cwd: '/workspace/projects/life-planner', uuid: 'def67890-bbbb', mtimeMs: Date.now() - 3600_000, lastUser: 'roadmap update' },
  { slug: 'belfry', cwd: '/workspace/projects/belfry', uuid: 'a99f0001-cccc', mtimeMs: Date.now() - 7200_000, lastUser: null },
];

test('/resume (no args): lists all recent sessions', async () => {
  const send = fakeSender();
  const h = makeResumeHandler({ send, listRecent: () => SAMPLE_SESSIONS });
  await h({ slug: null, uuid: null, messageId: 5 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /belfry/);
  assert.match(send.calls[0].text, /life-planner/);
  assert.match(send.calls[0].text, /\/resume belfry abc12345/);
});

test('/resume <slug>: filters to that slug', async () => {
  const send = fakeSender();
  const h = makeResumeHandler({ send, listRecent: () => SAMPLE_SESSIONS });
  await h({ slug: 'belfry', uuid: null, messageId: 5 });
  assert.match(send.calls[0].text, /belfry/);
  assert.doesNotMatch(send.calls[0].text, /life-planner/);
});

test('/resume <unknown>: replies "no recent sessions"', async () => {
  const send = fakeSender();
  const h = makeResumeHandler({ send, listRecent: () => SAMPLE_SESSIONS });
  await h({ slug: 'nonexistent', uuid: null, messageId: 5 });
  assert.match(send.calls[0].text, /no recent sessions for 'nonexistent'/);
});

test('/resume <slug> <uuid-prefix>: emits a copyable command by default', async () => {
  const send = fakeSender();
  const h = makeResumeHandler({ send, listRecent: () => SAMPLE_SESSIONS });
  await h({ slug: 'belfry', uuid: 'abc12345', messageId: 5 });
  assert.match(send.calls[0].text, /cd \/workspace\/projects\/belfry/);
  assert.match(send.calls[0].text, /claude --resume abc12345-aaaa/);
});

test('/resume <slug> <ambiguous-prefix>: replies "couldn\'t resolve"', async () => {
  // Both belfry sessions start with 'a' — ambiguous on prefix 'a'
  const send = fakeSender();
  const h = makeResumeHandler({ send, listRecent: () => SAMPLE_SESSIONS });
  await h({ slug: 'belfry', uuid: 'a', messageId: 5 });
  assert.match(send.calls[0].text, /couldn't resolve/);
});

test('/resume <slug> <unique-prefix>: resolves ambiguity', async () => {
  const send = fakeSender();
  const h = makeResumeHandler({ send, listRecent: () => SAMPLE_SESSIONS });
  await h({ slug: 'belfry', uuid: 'a99', messageId: 5 });
  assert.match(send.calls[0].text, /a99f0001-cccc/);
});

test('nickname resolves to slug for filter and uuid lookup', async () => {
  const send = fakeSender();
  const h = makeResumeHandler({
    send,
    listRecent: () => SAMPLE_SESSIONS,
    resolveNickname: (t) => (t === 'b' ? 'belfry' : null),
  });
  await h({ slug: 'b', uuid: 'abc12345', messageId: 5 });
  assert.match(send.calls[0].text, /belfry/);
  assert.match(send.calls[0].text, /abc12345-aaaa/);
});

test('launcherCmd: spawns and replies "launching"', async () => {
  const send = fakeSender();
  const spawned = [];
  const h = makeResumeHandler({
    send,
    listRecent: () => SAMPLE_SESSIONS,
    launcherCmd: '/usr/bin/my-launcher',
    spawnImpl: (cmd, args, opts) => {
      spawned.push({ cmd, opts });
      return { unref: () => {} };
    },
  });
  await h({ slug: 'belfry', uuid: 'abc12345', messageId: 5 });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/usr/bin/my-launcher');
  assert.equal(spawned[0].opts.env.BELFRY_RESUME_UUID, 'abc12345-aaaa');
  assert.equal(spawned[0].opts.env.BELFRY_RESUME_SLUG, 'belfry');
  assert.match(send.calls[0].text, /→ launching belfry \[abc12345\]/);
});
