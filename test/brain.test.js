import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';

import { BrainSupervisor } from '../lib/brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_PATH = path.join(__dirname, 'fixtures', 'stub-claude.js');

function makeWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-brain-test-'));
  // BrainSupervisor requires an mcpConfigPath; stub doesn't actually read
  // it, but we materialize an empty file so the existence check passes if
  // anyone adds one.
  const mcpConfig = path.join(dir, '.mcp.json');
  fs.writeFileSync(mcpConfig, '{"mcpServers":{}}');
  return { dir, mcpConfig };
}

function buildSupervisor(extra = {}) {
  const { dir, mcpConfig } = makeWorkdir();
  const sup = new BrainSupervisor({
    workdir: dir,
    mcpConfigPath: mcpConfig,
    systemPrompt: 'test',
    claudeCmd: 'node',
    spawnImpl: (_cmd, _args, opts) => {
      // Replace `claude --print --input-format=...` with our stub. The
      // stub doesn't read any flags; it just consumes stream-json from
      // stdin and emits canned responses on stdout.
      return nodeSpawn('node', [STUB_PATH], {
        cwd: opts.cwd,
        stdio: opts.stdio,
        env: { ...opts.env, ...extra.env },
      });
    },
    log: () => {},
    turnTimeoutMs: extra.turnTimeoutMs ?? 5000,
  });
  return { sup, dir };
}

test('start + send: returns the brain\'s result text on success', async () => {
  const { sup, dir } = buildSupervisor();
  sup.start();
  const out = await sup.send('hello');
  assert.equal(out, 'echo: hello');
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isAlive: true after start, false after stop', async () => {
  const { sup, dir } = buildSupervisor();
  assert.equal(sup.isAlive(), false);
  sup.start();
  // Spawn is async; small delay to let the process come up
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sup.isAlive(), true);
  await sup.stop();
  assert.equal(sup.isAlive(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('send: rejects when brain is not alive', async () => {
  const { sup, dir } = buildSupervisor();
  await assert.rejects(sup.send('hi'), /not alive/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('send: rejects with empty content', async () => {
  const { sup, dir } = buildSupervisor();
  sup.start();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(sup.send(''), /non-empty/);
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('send: rejects when brain returns is_error', async () => {
  const { sup, dir } = buildSupervisor({ env: { STUB_RESPOND_AS: 'error' } });
  sup.start();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(sup.send('something'), /turn error/);
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('send: tags 401 turns as auth errors and surfaces the status', async () => {
  const { sup, dir } = buildSupervisor({ env: { STUB_RESPOND_AS: 'auth' } });
  sup.start();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(sup.send('classify me'), (err) => {
    assert.match(err.message, /HTTP 401/);
    assert.match(err.message, /authenticate/i);
    assert.equal(err.apiErrorStatus, 401);
    assert.equal(err.isAuthError, true);
    return true;
  });
  assert.equal(sup.lastAuthError?.status, 401);
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('send: times out when brain hangs', async () => {
  const { sup, dir } = buildSupervisor({ env: { STUB_RESPOND_AS: 'hang' }, turnTimeoutMs: 200 });
  sup.start();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(sup.send('hangs'), /turn timeout/);
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('crash recovery: subprocess respawns with backoff after unexpected exit', async () => {
  const { sup, dir } = buildSupervisor({ env: { STUB_EXIT_AFTER_N: '1' } });
  sup.start();
  // First call exits the stub after responding.
  const r1 = await sup.send('first');
  assert.equal(r1, 'echo: first');
  // Wait for restart backoff (initial 1s) + spawn time.
  let waited = 0;
  while (waited < 3000 && !sup.isAlive()) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  assert.ok(sup.isAlive(), 'should have respawned within 3s');
  // After respawn the second call works on the fresh subprocess.
  const r2 = await sup.send('second');
  assert.equal(r2, 'echo: second');
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serial: a second send while one is in-flight rejects', async () => {
  const { sup, dir } = buildSupervisor();
  sup.start();
  await new Promise((r) => setTimeout(r, 50));
  // Don't await the first send; race a second
  const p1 = sup.send('first');
  const p2 = sup.send('second');
  await assert.rejects(p2, /busy/);
  await p1; // drain
  await sup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop is safe to call when already stopped', async () => {
  const { sup, dir } = buildSupervisor();
  await sup.stop(); // never started
  sup.start();
  await new Promise((r) => setTimeout(r, 50));
  await sup.stop();
  await sup.stop(); // double-stop OK
  fs.rmSync(dir, { recursive: true, force: true });
});

test('constructor: throws on missing required deps', () => {
  assert.throws(() => new BrainSupervisor({}), /workdir required/);
  assert.throws(() => new BrainSupervisor({ workdir: '/x' }), /mcpConfigPath required/);
  assert.throws(() => new BrainSupervisor({ workdir: '/x', mcpConfigPath: '/y' }), /systemPrompt required/);
});
