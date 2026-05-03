import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Registry } from '../lib/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = join(__dirname, '..', 'bin', 'belfry-mcp.js');

let registry;

before(async () => {
  registry = new Registry({ port: 0, recvTimeoutMs: 200 });
  await registry.start();
});

after(async () => {
  await registry.stop();
});

function startPlugin({ cwd = '/tmp', env = {} } = {}) {
  const child = spawn('node', [PLUGIN_PATH], {
    cwd,
    env: {
      ...process.env,
      BELFRY_MCP_BASE: `http://127.0.0.1:${registry.port}`,
      // Force slug to a known value — bypasses the path-index lookup.
      CLAUDELIKE_BAR_NAME: env.CLAUDELIKE_BAR_NAME ?? 'testslug',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try { messages.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
  });
  // Surface stderr if a test wants to debug.
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.stdin.end();
    setTimeout(() => child.kill('SIGTERM'), 1000).unref();
  });
  // Wait for a message matching `pred` to arrive — polling with a deadline.
  const waitFor = async (pred, timeoutMs = 2000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`waitFor timed out. messages so far: ${JSON.stringify(messages)}\nstderr:\n${stderr}`);
  };
  return { child, messages, send, stop, waitFor, stderr: () => stderr };
}

test('plugin responds to initialize with claude/channel capability', async () => {
  const p = startPlugin();
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const resp = await p.waitFor((m) => m.id === 1);
  assert.equal(resp.jsonrpc, '2.0');
  assert.ok(resp.result);
  assert.ok(resp.result.capabilities['claude/channel']);
  assert.equal(resp.result.serverInfo.name, 'belfry-mcp');
  await p.stop();
});

test('plugin registers with daemon after initialized notification', async () => {
  const p = startPlugin({ env: { CLAUDELIKE_BAR_NAME: 'r1' } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // Wait for the registry to see the registration (polling — register is async).
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (registry.bySlug.has('r1')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(registry.bySlug.has('r1'), 'plugin should have registered as slug r1');
  await p.stop();
});

test('plugin emits notifications/claude/channel when daemon delivers', async () => {
  const p = startPlugin({ env: { CLAUDELIKE_BAR_NAME: 'r2' } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // Wait for register to land.
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (registry.bySlug.has('r2')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(registry.bySlug.has('r2'));

  // Deliver a message.
  registry.deliver('r2', 'hello from daemon');

  const notif = await p.waitFor((m) => m.method === 'notifications/claude/channel', 3000);
  assert.equal(notif.params.content, 'hello from daemon');
  assert.equal(notif.params.meta.source, 'belfry');
  assert.equal(notif.params.meta.slug, 'r2');
  await p.stop();
});

test('plugin tools/list returns empty list', async () => {
  const p = startPlugin();
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const resp = await p.waitFor((m) => m.id === 2);
  assert.deepEqual(resp.result.tools, []);
  await p.stop();
});

test('plugin unregisters cleanly on stdin close', async () => {
  const p = startPlugin({ env: { CLAUDELIKE_BAR_NAME: 'unreg' } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  // Wait for register.
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (registry.bySlug.has('unreg')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(registry.bySlug.has('unreg'));
  await p.stop();
  // Wait briefly for unregister POST.
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    if (!registry.bySlug.has('unreg')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(registry.bySlug.has('unreg'), false);
});
