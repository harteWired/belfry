import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../lib/mcp-server.js';
import { Inbox } from '../lib/inbox.js';
import { runStopHook } from '../hooks/stop-hook.js';

let server;
let inbox;
let port;

before(async () => {
  inbox = new Inbox();
  server = new McpServer({ inbox, port: 0 });
  await server.start();
  port = server.server.address().port;
});

after(async () => {
  await server.stop();
});

function captureStdout() {
  const chunks = [];
  return {
    stream: { write: (s) => chunks.push(s) },
    text: () => chunks.join(''),
  };
}

test('emits no output when inbox is empty', async () => {
  const out = captureStdout();
  await runStopHook({
    stdin: JSON.stringify({ cwd: '/workspace/projects/empty-slug' }),
    env: { BELFRY_MCP_PORT: String(port), CLAUDELIKE_BAR_NAME: '' },
    stdout: out.stream,
  });
  assert.equal(out.text(), '');
});

test('emits block decision with inbox text when non-empty', async () => {
  inbox.push('test-slug', 'continuation', 'do the thing');
  const out = captureStdout();
  await runStopHook({
    stdin: JSON.stringify({ cwd: '/whatever' }),
    env: { BELFRY_MCP_PORT: String(port), CLAUDELIKE_BAR_NAME: 'test-slug' },
    stdout: out.stream,
  });
  const parsed = JSON.parse(out.text());
  assert.equal(parsed.decision, 'block');
  assert.equal(parsed.reason, 'do the thing');
});

test('drain is destructive — second call returns nothing', async () => {
  inbox.push('once-slug', 'continuation', 'one shot');
  const env = { BELFRY_MCP_PORT: String(port), CLAUDELIKE_BAR_NAME: 'once-slug' };
  const out1 = captureStdout();
  await runStopHook({ stdin: '{}', env, stdout: out1.stream });
  assert.match(out1.text(), /"reason":"one shot"/);
  const out2 = captureStdout();
  await runStopHook({ stdin: '{}', env, stdout: out2.stream });
  assert.equal(out2.text(), '');
});

test('silent failure when belfry MCP is unreachable', async () => {
  const out = captureStdout();
  await runStopHook({
    stdin: '{}',
    // Pick a port nothing is listening on.
    env: { BELFRY_MCP_PORT: '1', CLAUDELIKE_BAR_NAME: 'unreachable-slug' },
    stdout: out.stream,
  });
  assert.equal(out.text(), '', 'must not block Stop when daemon is down');
});

test('handles missing/invalid stdin gracefully', async () => {
  const out = captureStdout();
  await runStopHook({
    stdin: 'not json',
    env: { BELFRY_MCP_PORT: String(port), CLAUDELIKE_BAR_NAME: 'fallback-slug' },
    stdout: out.stream,
  });
  assert.equal(out.text(), '', 'no inbox content for this slug');
});
