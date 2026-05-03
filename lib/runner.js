/**
 * Run a one-shot Claude Code turn programmatically.
 *
 * Used to drive a session that has no live terminal attached. The Stop hook
 * only fires when Claude finishes a turn — useless for a fully idle session
 * — so when a Telegram reply arrives for an idle slug, belfry spawns
 *
 *   claude --resume <session-id> --print "<reply>"
 *
 * in the slug's cwd. The subprocess writes one turn into the same JSONL
 * transcript the user was last using, so when they look at the terminal
 * later the conversation has progressed naturally.
 *
 * No session id → fresh session via `claude --print "<reply>"`. The reply
 * lands as the first user prompt; the spawned turn becomes a brand-new
 * jsonl and on next start the session-resolver finds it.
 *
 * Output: { ok, stdout, stderr, code, timedOut }. Caller decides what to
 * relay back to Telegram.
 */

import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BIN = 'claude';

export async function runClaude({
  prompt,
  cwd,
  sessionId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  bin = DEFAULT_BIN,
  spawnImpl = nodeSpawn,
} = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { ok: false, stdout: '', stderr: 'empty prompt', code: null, timedOut: false };
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { ok: false, stdout: '', stderr: 'missing cwd', code: null, timedOut: false };
  }

  const args = ['--print'];
  if (sessionId) args.push('--resume', sessionId);
  args.push(prompt);

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err.message, code: null, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Give it 2s to die gracefully, then SIGKILL.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || err.message, code: null, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
        timedOut,
      });
    });
  });
}
