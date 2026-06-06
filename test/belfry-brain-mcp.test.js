import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Registry } from '../lib/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..', 'bin', 'belfry-brain-mcp.js');

function startBrain({ env = {} } = {}) {
  const child = spawn('node', [PLUGIN_PATH], {
    cwd: '/tmp',
    env: { ...process.env, ...env },
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
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const waitFor = async (pred, timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`waitFor timed out: ${JSON.stringify(messages)}\nstderr: ${stderr}`);
  };
  const stop = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(() => child.kill('SIGTERM'), 1000).unref();
    });
  };
  return { send, waitFor, stop, child, messages };
}

let registry;
let tokenPath;
let baseUrl;

before(async () => {
  // Token file the brain MCP server reads at startup.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-brain-test-'));
  tokenPath = path.join(tmpDir, 'token');
  fs.writeFileSync(tokenPath, 'test-token-abc123');
  // Registry with brain handlers wired.
  registry = new Registry({
    port: 0,
    authToken: 'test-token-abc123',
    brainHandlers: {
      listSessions: () => [{ slug: 'belfry', last_outbound_kind: 'event' }],
      getSession: ({ slug }) => ({ status: 'ready', slug }),
      recentMessages: ({ slug, n }) => [{ kind: 'event', text: `${slug}-msg`, ts: 1, n }],
      nicknames: () => ({ b: 'belfry' }),
      help: ({ topic }) => ({ text: `help text for ${topic}` }),
      deliver: ({ slug, body }) => ({ fanout: 1, slug, body }),
      reply: async ({ text }) => ({ message_id: 9999, text }),
      decline: async ({ message }) => ({ sent: true, message }),
    },
  });
  await registry.start();
  baseUrl = `http://127.0.0.1:${registry.port}`;
});

after(async () => {
  await registry.stop();
});

test('brain MCP: tools/list returns the documented 8 tools', async () => {
  const p = startBrain({ env: { BELFRY_MCP_BASE: baseUrl, BELFRY_BRAIN_TOKEN_PATH: tokenPath } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const resp = await p.waitFor((m) => m.id === 2);
  const names = resp.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'decline', 'deliver_to_slug', 'get_help_text', 'get_nicknames',
    'get_session', 'list_sessions', 'recent_messages', 'reply_to_telegram',
  ]);
  await p.stop();
});

test('brain MCP: list_sessions tool dispatches to /brain/list-sessions', async () => {
  const p = startBrain({ env: { BELFRY_MCP_BASE: baseUrl, BELFRY_BRAIN_TOKEN_PATH: tokenPath } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
  const resp = await p.waitFor((m) => m.id === 2);
  assert.ok(resp.result, `expected result, got ${JSON.stringify(resp)}`);
  const text = resp.result.content[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed[0].slug, 'belfry');
  await p.stop();
});

test('brain MCP: deliver_to_slug forwards args to /brain/deliver', async () => {
  const p = startBrain({ env: { BELFRY_MCP_BASE: baseUrl, BELFRY_BRAIN_TOKEN_PATH: tokenPath } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'deliver_to_slug', arguments: { slug: 'belfry', body: 'hi' } },
  });
  const resp = await p.waitFor((m) => m.id === 2);
  const parsed = JSON.parse(resp.result.content[0].text);
  assert.equal(parsed.fanout, 1);
  assert.equal(parsed.slug, 'belfry');
  await p.stop();
});

test('brain MCP: missing token file → tool calls fail with auth error', async () => {
  // Point at a path that doesn't exist; brain reads "" as token, daemon rejects.
  const p = startBrain({ env: { BELFRY_MCP_BASE: baseUrl, BELFRY_BRAIN_TOKEN_PATH: '/nonexistent/token-file' } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
  const resp = await p.waitFor((m) => m.id === 2);
  assert.ok(resp.error, `expected error, got ${JSON.stringify(resp)}`);
  assert.match(resp.error.message, /401/);
  await p.stop();
});

test('brain MCP: unknown tool returns -32601-ish error', async () => {
  const p = startBrain({ env: { BELFRY_MCP_BASE: baseUrl, BELFRY_BRAIN_TOKEN_PATH: tokenPath } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'nonexistent', arguments: {} },
  });
  const resp = await p.waitFor((m) => m.id === 2);
  assert.ok(resp.error);
  assert.match(resp.error.message, /unknown tool/);
  await p.stop();
});
