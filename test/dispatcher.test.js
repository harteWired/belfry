import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../lib/dispatcher.js';
import { Inbox } from '../lib/inbox.js';

function makeFakeFs(files) {
  return {
    readFileSync(p) {
      if (!(p in files)) {
        const err = new Error(`ENOENT ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
  };
}

function setup({
  status = 'ready',
  cwd = '/projects/belfry',
  runnerResult = { ok: true, stdout: 'hello back', stderr: '', code: 0, timedOut: false },
  sessionId = 'sess-1',
} = {}) {
  const inbox = new Inbox();
  const sent = [];
  const runnerCalls = [];
  const log = () => {};
  const dispatcher = new Dispatcher({
    inbox,
    runner: async (args) => {
      runnerCalls.push(args);
      return runnerResult;
    },
    sessionResolver: () => sessionId,
    subscriptions: { belfry: { events: ['ready'], cwd } },
    dashboardDir: '/dashboard',
    sendReply: async ({ slug, text }) => { sent.push({ slug, text }); },
    log,
    fsImpl: makeFakeFs(
      status === '__missing__'
        ? {}
        : { '/dashboard/belfry.json': JSON.stringify({ status }) }
    ),
  });
  return { dispatcher, inbox, sent, runnerCalls };
}

test('working status → push to inbox, no spawn', async () => {
  const { dispatcher, inbox, sent, runnerCalls } = setup({ status: 'working' });
  await dispatcher.push('belfry', 'continuation', 'do thing');
  assert.equal(inbox.peek('belfry', 'continuation'), 'do thing');
  assert.equal(runnerCalls.length, 0);
  assert.equal(sent.length, 0);
});

test('tool_end status → push to inbox (mid-tool, still active)', async () => {
  const { dispatcher, inbox, sent, runnerCalls } = setup({ status: 'tool_end' });
  await dispatcher.push('belfry', 'continuation', 'do thing');
  assert.equal(inbox.peek('belfry', 'continuation'), 'do thing');
  assert.equal(runnerCalls.length, 0);
  assert.equal(sent.length, 0);
});

test('notification status → push to inbox (active, awaiting permission)', async () => {
  const { dispatcher, inbox, sent, runnerCalls } = setup({ status: 'notification' });
  await dispatcher.push('belfry', 'continuation', 'yes');
  assert.equal(inbox.peek('belfry', 'continuation'), 'yes');
  assert.equal(runnerCalls.length, 0);
  assert.equal(sent.length, 0);
});

test('ready status → spawn claude --resume, relay output to telegram', async () => {
  const { dispatcher, inbox, sent, runnerCalls } = setup({ status: 'ready' });
  await dispatcher.push('belfry', 'continuation', 'do thing');
  assert.equal(inbox.peek('belfry', 'continuation'), null);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].sessionId, 'sess-1');
  assert.equal(runnerCalls[0].cwd, '/projects/belfry');
  assert.equal(runnerCalls[0].prompt, 'do thing');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].slug, 'belfry');
  assert.equal(sent[0].text, 'hello back');
});

test('missing dashboard → spawn (treat as idle)', async () => {
  const { dispatcher, inbox, sent, runnerCalls } = setup({ status: '__missing__' });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(runnerCalls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(inbox.peek('belfry', 'continuation'), null);
});

test('error status → spawn (treat as idle)', async () => {
  const { dispatcher, runnerCalls, sent } = setup({ status: 'error' });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(runnerCalls.length, 1);
  assert.equal(sent.length, 1);
});

test('runner returns ok=false → reply with error message', async () => {
  const { dispatcher, sent } = setup({
    status: 'ready',
    runnerResult: { ok: false, stdout: '', stderr: 'boom', code: 1, timedOut: false },
  });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /could not drive belfry/);
  assert.match(sent[0].text, /boom/);
});

test('runner times out → reply with timeout note', async () => {
  const { dispatcher, sent } = setup({
    status: 'ready',
    runnerResult: { ok: false, stdout: '', stderr: '', code: null, timedOut: true },
  });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /timed out/);
});

test('no sessionId resolved → spawn fresh (no --resume)', async () => {
  const { dispatcher, runnerCalls } = setup({ status: 'ready', sessionId: null });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].sessionId, null);
});

test('interrupt queue always pushes to inbox, never spawns', async () => {
  const { dispatcher, inbox, runnerCalls, sent } = setup({ status: 'ready' });
  await dispatcher.push('belfry', 'interrupt', 'STOP');
  assert.equal(inbox.peek('belfry', 'interrupt'), 'STOP');
  assert.equal(runnerCalls.length, 0);
  assert.equal(sent.length, 0);
});

test('subscription with no cwd configured → fallback to inbox', async () => {
  const inbox = new Inbox();
  const sent = [];
  const runnerCalls = [];
  const dispatcher = new Dispatcher({
    inbox,
    runner: async (args) => { runnerCalls.push(args); return { ok: true, stdout: 'ok' }; },
    sessionResolver: () => 'sess-1',
    subscriptions: { belfry: { events: ['ready'] } }, // no cwd
    dashboardDir: '/dashboard',
    sendReply: async (m) => { sent.push(m); },
    log: () => {},
    fsImpl: makeFakeFs({ '/dashboard/belfry.json': JSON.stringify({ status: 'ready' }) }),
  });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(inbox.peek('belfry', 'continuation'), 'hi');
  assert.equal(runnerCalls.length, 0);
});

test('runner throws → caught, reply sent, does not propagate', async () => {
  const inbox = new Inbox();
  const sent = [];
  const dispatcher = new Dispatcher({
    inbox,
    runner: async () => { throw new Error('disk full'); },
    sessionResolver: () => 'sess-1',
    subscriptions: { belfry: { events: ['ready'], cwd: '/projects/belfry' } },
    dashboardDir: '/dashboard',
    sendReply: async (m) => { sent.push(m); },
    log: () => {},
    fsImpl: makeFakeFs({ '/dashboard/belfry.json': JSON.stringify({ status: 'ready' }) }),
  });
  await dispatcher.push('belfry', 'continuation', 'hi');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /disk full/);
});
