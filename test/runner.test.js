import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runClaude } from '../lib/runner.js';

function fakeSpawn({ stdout = '', stderr = '', code = 0, delayMs = 0, throwOnSpawn = false } = {}) {
  let captured;
  const spawnImpl = (bin, args, opts) => {
    captured = { bin, args, opts };
    if (throwOnSpawn) throw new Error('ENOENT');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, delayMs);
    return child;
  };
  return { spawnImpl, getCaptured: () => captured };
}

test('runClaude with sessionId passes --resume <id>', async () => {
  const { spawnImpl, getCaptured } = fakeSpawn({ stdout: 'hello back', code: 0 });
  const result = await runClaude({
    prompt: 'hi',
    cwd: '/tmp',
    sessionId: 'abc-123',
    spawnImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hello back');
  const { args, opts } = getCaptured();
  assert.deepEqual(args, ['--print', '--resume', 'abc-123', 'hi']);
  assert.equal(opts.cwd, '/tmp');
});

test('runClaude without sessionId omits --resume', async () => {
  const { spawnImpl, getCaptured } = fakeSpawn({ stdout: 'fresh', code: 0 });
  const result = await runClaude({ prompt: 'hi', cwd: '/tmp', spawnImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(getCaptured().args, ['--print', 'hi']);
});

test('runClaude returns ok:false when exit code is non-zero', async () => {
  const { spawnImpl } = fakeSpawn({ stderr: 'boom', code: 1 });
  const result = await runClaude({ prompt: 'hi', cwd: '/tmp', spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'boom');
});

test('runClaude rejects empty prompt', async () => {
  const { spawnImpl } = fakeSpawn();
  const result = await runClaude({ prompt: '', cwd: '/tmp', spawnImpl });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /empty prompt/);
});

test('runClaude rejects missing cwd', async () => {
  const { spawnImpl } = fakeSpawn();
  const result = await runClaude({ prompt: 'hi', cwd: '', spawnImpl });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /missing cwd/);
});

test('runClaude handles spawn throwing synchronously', async () => {
  const { spawnImpl } = fakeSpawn({ throwOnSpawn: true });
  const result = await runClaude({ prompt: 'hi', cwd: '/tmp', spawnImpl });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /ENOENT/);
});

test('runClaude times out and reports timedOut=true', async () => {
  const { spawnImpl } = fakeSpawn({ stdout: 'slow', code: 0, delayMs: 200 });
  const result = await runClaude({ prompt: 'hi', cwd: '/tmp', spawnImpl, timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});
