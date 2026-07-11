import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  assert.ok(resp.result.capabilities.experimental?.['claude/channel']);
  assert.equal(resp.result.serverInfo.name, 'belfry');
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
  // meta.source dropped — the harness already provides `source=` on the
  // wrapper tag, so duplicating it here yielded the doubled-attribute
  // <channel source="belfry" source="belfry" ...> framing the user flagged.
  assert.equal(notif.params.meta.source, undefined);
  assert.equal(notif.params.meta.slug, 'r2');
  assert.equal(typeof notif.params.meta.ts, 'string');
  await p.stop();
});

test('broadcast injection emits meta.broadcast as the STRING "true", and all meta values are strings', async () => {
  // Regression for the long-standing "/all never reached sessions" bug: the
  // channel notification meta is typed Record<string,string>, so a boolean
  // meta value fails the MCP params schema and the whole notification is
  // dropped. Every meta value MUST be a string.
  const p = startPlugin({ env: { CLAUDELIKE_BAR_NAME: 'r-bc' } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (registry.bySlug.has('r-bc')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(registry.bySlug.has('r-bc'));

  registry.broadcast('all hands', { targetSlugs: ['r-bc'] });

  const notif = await p.waitFor((m) => m.method === 'notifications/claude/channel', 3000);
  assert.equal(notif.params.content, 'all hands');
  assert.strictEqual(notif.params.meta.broadcast, 'true', 'must be string "true", not boolean');
  for (const [k, v] of Object.entries(notif.params.meta)) {
    assert.equal(typeof v, 'string', `meta.${k} must be a string (got ${typeof v})`);
  }
  await p.stop();
});

test('plugin tools/list advertises the reply and send_to tools', async () => {
  const p = startPlugin();
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const resp = await p.waitFor((m) => m.id === 2);
  const byName = Object.fromEntries(resp.result.tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['reply', 'send_to']);
  // Outbound files: a reply may be text, files, or both — nothing is required.
  assert.deepEqual(byName.reply.inputSchema.required, []);
  assert.ok(byName.reply.inputSchema.properties.files, 'reply advertises the files param');
  assert.deepEqual(byName.send_to.inputSchema.required, ['slug', 'text']);
  await p.stop();
});

test('reply tool POSTs to daemon /send and reports the message_id', async () => {
  // Spin up a registry with a stub onSend so we can assert what the spoke sent.
  const calls = [];
  const reg = new (await import('../lib/registry.js')).Registry({
    port: 0,
    recvTimeoutMs: 200,
    onSend: async ({ slug, text, replyToMessageId }) => {
      calls.push({ slug, text, replyToMessageId });
      return { message_id: 7777 };
    },
  });
  await reg.start();
  const child = spawn('node', [PLUGIN_PATH], {
    cwd: '/tmp',
    env: {
      ...process.env,
      BELFRY_MCP_BASE: `http://127.0.0.1:${reg.port}`,
      CLAUDELIKE_BAR_NAME: 'reply-test',
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
    throw new Error(`waitFor timed out: ${JSON.stringify(messages)}\nstderr:\n${stderr}`);
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await waitFor((m) => m.id === 1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  // Wait for the spoke to register.
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (reg.bySlug.has('reply-test')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(reg.bySlug.has('reply-test'));

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reply', arguments: { text: 'hello human' } } });
  const resp = await waitFor((m) => m.id === 2);
  assert.ok(resp.result, `expected result, got ${JSON.stringify(resp)}`);
  assert.equal(resp.result.content[0].type, 'text');
  assert.match(resp.result.content[0].text, /7777/);
  // Tool result echoes the sent text so the model can verify (and the user
  // has a verbatim copy in the terminal even when Telegram-side render
  // attenuates).
  assert.match(resp.result.content[0].text, /Sent text:[\s\S]*hello human/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, 'reply-test');
  assert.equal(calls[0].text, 'hello human');

  // A reply over Telegram's 4096-char cap passes through unchanged to the
  // daemon — packing / chunking now lives there (lib/pack.js + the
  // sendOutbound pipeline in bin/belfry.js), not in the spoke. The spoke
  // just hands the full text off and echoes what was sent.
  const huge = 'X'.repeat(5000);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reply', arguments: { text: huge } } });
  const resp2 = await waitFor((m) => m.id === 3);
  assert.match(resp2.result.content[0].text, /5000 chars/);
  assert.doesNotMatch(resp2.result.content[0].text, /truncated/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text.length, 5000);
  assert.equal(calls[1].text, huge);

  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    setTimeout(() => child.kill('SIGTERM'), 1000).unref();
  });
  await reg.stop();
});

test('send_to tool relays to another session via daemon /send-to (#36)', async () => {
  const reg = new (await import('../lib/registry.js')).Registry({ port: 0, recvTimeoutMs: 200 });
  await reg.start();
  // Destination session registered directly on the registry.
  await fetch(`http://127.0.0.1:${reg.port}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: 'dst-inst', slug: 'a2a-dst', cwd: '/x' }),
  });
  const child = spawn('node', [PLUGIN_PATH], {
    cwd: '/tmp',
    env: { ...process.env, BELFRY_MCP_BASE: `http://127.0.0.1:${reg.port}`, CLAUDELIKE_BAR_NAME: 'a2a-src' },
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
      if (line) { try { messages.push(JSON.parse(line)); } catch { /* ignore */ } }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const waitFor = async (pred, timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`waitFor timed out: ${JSON.stringify(messages)}`);
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await waitFor((m) => m.id === 1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (reg.bySlug.has('a2a-src')) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_to', arguments: { slug: 'a2a-dst', text: 'hey peer' } } });
  const resp = await waitFor((m) => m.id === 2);
  assert.match(resp.result.content[0].text, /Relayed to "a2a-dst"/);
  // Destination receives it tagged as an agent message from the sender's slug.
  const r = await fetch(`http://127.0.0.1:${reg.port}/recv?instance_id=dst-inst`);
  assert.deepEqual(await r.json(), { text: 'hey peer', origin: 'agent', from: 'a2a-src' });

  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    setTimeout(() => child.kill('SIGTERM'), 1000).unref();
  });
  await reg.stop();
});

test('plugin hot-swaps token on register 401 and registers in-place', async () => {
  // Reproduces the post-rebuild bug: MCP started before the daemon, so
  // loadToken() at module init returned null. Once the daemon comes up with
  // an auth token, /register returns 401. The fix re-reads the token on 401,
  // hot-swaps the cached value, and retries — without exiting — because the
  // MCP host does not respawn stdio servers on clean exit (verified
  // 2026-05-10 against this Claude Code build).
  const reg = new Registry({ port: 0, recvTimeoutMs: 200, authToken: 'real-token' });
  await reg.start();
  const stateDir = await mkdtemp(join(tmpdir(), 'belfry-mcp-test-'));
  try {
    const child = spawn('node', [PLUGIN_PATH], {
      cwd: '/tmp',
      env: {
        ...process.env,
        BELFRY_MCP_BASE: `http://127.0.0.1:${reg.port}`,
        BELFRY_STATE_DIR: stateDir,
        CLAUDELIKE_BAR_NAME: 'rotated',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.resume();

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // Give the first register a moment to fail with 401 against an empty
    // token file. Then drop the matching token in place.
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(stateDir, 'registry.token'), 'real-token', { mode: 0o600 });

    // Wait for the plugin to register (RECONNECT_BACKOFF_MS=2s).
    const start = Date.now();
    while (Date.now() - start < 6000) {
      if (reg.bySlug.has('rotated')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(reg.bySlug.has('rotated'), `plugin should have registered after token swap; stderr:\n${stderr}`);
    assert.match(stderr, /token reloaded from disk/);
    // Plugin should still be alive — no exit-for-respawn.
    assert.equal(child.exitCode, null);

    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', resolve);
      setTimeout(() => child.kill('SIGTERM'), 1000).unref();
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await reg.stop();
  }
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

test('caption-less photo (empty text + image_path) still injects, with a placeholder (#41 regression)', async () => {
  // The recv guard used to require text.length > 0, silently discarding a
  // photo-only delivery one hop from the session — with the file already on
  // disk. Empty text + attachment must inject, with non-empty placeholder
  // text so the harness never sees an empty-text channel notification (#37).
  const p = startPlugin({ env: { CLAUDELIKE_BAR_NAME: 'r-photo' } });
  p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await p.waitFor((m) => m.id === 1);
  p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (registry.bySlug.has('r-photo')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(registry.bySlug.has('r-photo'));

  registry.deliver('r-photo', '', null, { imagePath: '/tmp/att/photo-fed-1.jpg' });

  const notif = await p.waitFor((m) => m.method === 'notifications/claude/channel', 3000);
  assert.equal(notif.params.content, '[photo attached]');
  assert.equal(notif.params.image_path, '/tmp/att/photo-fed-1.jpg');
  await p.stop();
});
