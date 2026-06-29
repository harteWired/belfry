/**
 * Brain supervisor — manages a long-running `claude --print
 * --input-format=stream-json --output-format=stream-json` subprocess that
 * serves as belfry's language layer. The user never sees / interacts with
 * the subprocess directly; the daemon owns its lifecycle.
 *
 * Wire format (verified against claude-2.1.119 on 2026-05-09):
 *   stdin: one user message per line:
 *     {"type":"user","message":{"role":"user","content":"<text>"}}
 *   stdout: stream of JSON lines, including:
 *     {"type":"system","subtype":"init"|"hook_*", ...} — lifecycle
 *     {"type":"assistant","message":{...content blocks...}} — partial turns
 *       (content array may include text, thinking, tool_use blocks)
 *     {"type":"result","subtype":"success","result":"<text>",...} — the
 *       turn-end marker. The .result field is the final assistant text.
 *     {"type":"result","subtype":"...","is_error":true,...} — turn-end
 *       error. Returned to caller so they can fall back.
 *
 * Tool-use happens via the belfry-brain MCP server (separate stdio plugin
 * the brain talks to over its own MCP channel). Tool calls don't flow
 * through this supervisor's stdin/stdout — they're handled out-of-band.
 *
 * Crash policy: on unexpected exit, schedule a respawn with exponential
 * backoff (1s, 2s, 4s, …, capped at 30s). isAlive() is the public health
 * check; callers can fall back to "language layer is down" reply when it's
 * false.
 */

import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const RESTART_BACKOFF_INITIAL_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const TURN_TIMEOUT_MS = 60_000; // single classify/summarize call — generous
const SHUTDOWN_GRACE_MS = 3_000;

export class BrainSupervisor {
  constructor({
    workdir,
    mcpConfigPath,
    systemPrompt,
    model = DEFAULT_MODEL,
    claudeCmd = 'claude',
    spawnImpl = nodeSpawn,
    log = () => {},
    turnTimeoutMs = TURN_TIMEOUT_MS,
  } = {}) {
    if (!workdir) throw new Error('workdir required');
    if (!mcpConfigPath) throw new Error('mcpConfigPath required');
    if (!systemPrompt) throw new Error('systemPrompt required');
    this.workdir = workdir;
    this.mcpConfigPath = mcpConfigPath;
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.claudeCmd = claudeCmd;
    this.spawnImpl = spawnImpl;
    this.log = log;
    this.turnTimeoutMs = turnTimeoutMs;

    this.child = null;
    this.alive = false;
    this.stopping = false;
    this.stdinBuf = ''; // not used (we write whole lines), kept for symmetry
    this.stdoutBuf = '';
    this.pendingTurn = null; // { resolve, reject, timer }
    this.lastAuthError = null; // { status, at, detail } — set on a 401/403 turn, cleared on success
    this.restartBackoff = RESTART_BACKOFF_INITIAL_MS;
    this.restartTimer = null;
  }

  /** Spawn the subprocess. Idempotent — safe to call again after a crash. */
  start() {
    if (this.child) return;
    this.stopping = false;
    // Pre-approve the brain's own MCP tools so Claude Code's permission
    // gate doesn't default-deny them (no TTY to prompt on with --print).
    // Without this, the brain would output "I can't access tools due to
    // permissions" text — confirmed by the user-facing reply we saw
    // before this flag existed. Other Claude Code tools (Bash, Edit,
    // Gmail/Drive/Calendar MCPs, etc.) remain default-deny so the brain
    // can't reach beyond belfry's surface.
    // Server name `belfrybrain` (no hyphen) matches the .mcp.json key
    // bin/belfry.js writes. Claude transforms non-alphanumeric chars in
    // server names to underscores in the tool prefix, so a hyphenated
    // name would mean these allow-list strings wouldn't match the actual
    // mcp__belfry_brain__* tool names. Using a flat-alphanumeric server
    // name avoids the transform entirely.
    const allowedTools = [
      'mcp__belfrybrain__list_sessions',
      'mcp__belfrybrain__get_session',
      'mcp__belfrybrain__recent_messages',
      'mcp__belfrybrain__get_nicknames',
      'mcp__belfrybrain__get_help_text',
      'mcp__belfrybrain__deliver_to_slug',
      'mcp__belfrybrain__reply_to_telegram',
      'mcp__belfrybrain__decline',
    ];
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose', // required for stream-json output with --print
      '--no-session-persistence',
      '--permission-mode', 'default', // default-deny anything not explicitly allowed
      '--model', this.model,
      '--system-prompt', this.systemPrompt,
      '--mcp-config', this.mcpConfigPath,
      '--allowedTools', ...allowedTools,
    ];
    this.log(`brain: spawn ${this.claudeCmd} ${args.slice(0, 4).join(' ')} … (cwd ${this.workdir})`);
    let child;
    try {
      child = this.spawnImpl(this.claudeCmd, args, {
        cwd: this.workdir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      this.log(`brain: spawn failed: ${err.message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.alive = true;
    this.stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdoutData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Surface stderr lines for debugging but don't fail the supervisor —
      // claude logs many informational lines here.
      const lines = chunk.toString().split('\n').filter((l) => l.trim());
      for (const line of lines.slice(0, 3)) this.log(`brain stderr: ${line.slice(0, 200)}`);
    });
    child.on('exit', (code, signal) => this.onChildExit(code, signal));
    child.on('error', (err) => this.log(`brain process error: ${err.message}`));
  }

  /**
   * Send a user message to the brain. Returns the brain's final text
   * response (the .result field from the stream-json terminator). Rejects
   * on supervisor crash, timeout, or brain-side error.
   *
   * Concurrency: only one turn can be in-flight at a time. The brain's
   * stream-json mode pipelines turns sequentially — sending a second
   * message while the first is still resolving would interleave outputs
   * with no way to disambiguate. Caller serializes.
   */
  send(content) {
    if (this.pendingTurn) {
      return Promise.reject(new Error('brain busy: another turn in flight'));
    }
    if (!this.alive || !this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error('brain not alive'));
    }
    if (typeof content !== 'string' || content.length === 0) {
      return Promise.reject(new Error('content must be non-empty string'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log(`brain: turn timed out after ${this.turnTimeoutMs}ms — killing subprocess to force a clean respawn`);
        this.pendingTurn = null;
        reject(new Error(`brain turn timeout (${this.turnTimeoutMs}ms)`));
        // Kill the child so its eventual stale .result line never lands
        // on a fresh subsequent send. The 'exit' handler will schedule a
        // respawn through the normal backoff path.
        try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
      }, this.turnTimeoutMs);
      this.pendingTurn = { resolve, reject, timer };
      const message = JSON.stringify({
        type: 'user',
        message: { role: 'user', content },
      });
      this.child.stdin.write(message + '\n', (err) => {
        if (err && this.pendingTurn) {
          // EPIPE etc — fail fast instead of waiting for the timeout.
          clearTimeout(timer);
          const turn = this.pendingTurn;
          this.pendingTurn = null;
          turn.reject(new Error(`brain stdin write failed: ${err.message}`));
        }
      });
    });
  }

  /** True when the brain subprocess is running and ready to accept input. */
  isAlive() {
    return this.alive && !!this.child && this.child.stdin?.writable === true;
  }

  /**
   * Graceful shutdown: close stdin (brain exits cleanly when input stream
   * ends), wait for exit up to SHUTDOWN_GRACE_MS, then SIGTERM, then
   * SIGKILL. Cancels any pending restart timer.
   */
  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child) return;
    if (this.pendingTurn) {
      clearTimeout(this.pendingTurn.timer);
      this.pendingTurn.reject(new Error('brain shutting down'));
      this.pendingTurn = null;
    }
    const child = this.child;
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        const t2 = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 1000);
        t2.unref?.();
      }, SHUTDOWN_GRACE_MS);
      t.unref?.();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.child = null;
    this.alive = false;
  }

  // === internals ===

  onStdoutData(chunk) {
    this.stdoutBuf += chunk;
    while (true) {
      const nl = this.stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Tolerate malformed lines (rare; usually claude-side log noise).
        continue;
      }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg?.type === 'result') {
      // Turn terminator. msg.is_error → reject, otherwise resolve with .result.
      const turn = this.pendingTurn;
      if (!turn) return; // late arrival or no caller waiting
      this.pendingTurn = null;
      clearTimeout(turn.timer);
      if (msg.is_error) {
        // Surface api_error_status + the result text, not just msg.subtype.
        // A turn that fails on a 401 still carries subtype:"success", so the
        // old `brain turn error: ${subtype}` logged the useless "success"
        // and masked an expired-credentials outage as a vague error
        // (diagnosed 2026-06-29: brain auth-dead for 8 days, unreadable in
        // the log). Tag auth failures (401/403) on the Error so callers can
        // distinguish "can't authenticate" from a transient turn error.
        const status = typeof msg.api_error_status === 'number' ? msg.api_error_status : null;
        const detail = typeof msg.result === 'string' && msg.result.trim()
          ? `: ${msg.result.trim().slice(0, 200)}`
          : '';
        const statusStr = status ? ` (HTTP ${status})` : '';
        const err = new Error(`brain turn error${statusStr} [${msg.subtype ?? 'unknown'}]${detail}`);
        err.apiErrorStatus = status;
        err.isAuthError = status === 401 || status === 403;
        if (err.isAuthError) {
          this.lastAuthError = { status, at: Date.now(), detail: detail.slice(2) };
        }
        turn.reject(err);
      } else {
        // Reset the restart backoff on a successful turn — the brain is healthy.
        this.restartBackoff = RESTART_BACKOFF_INITIAL_MS;
        this.lastAuthError = null; // a real turn went through — credentials are good again

        turn.resolve(typeof msg.result === 'string' ? msg.result : '');
      }
      return;
    }
    // Other types (system, assistant, rate_limit_event) are informational.
    // We don't surface them to the caller — they'll see only the .result text.
  }

  onChildExit(code, signal) {
    this.alive = false;
    // Drain any buffered stdout so a turn whose .result line arrived in
    // the same tick as 'exit' still resolves cleanly. Without this, a
    // brain that exits immediately after emitting its result (the stub
    // does this in tests; could happen in real life on a clean shutdown
    // by the brain itself) would reject the in-flight turn.
    if (this.stdoutBuf) {
      const trailing = this.stdoutBuf;
      this.stdoutBuf = '';
      for (const line of trailing.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { this.onMessage(JSON.parse(t)); } catch { /* ignore */ }
      }
    }
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    if (turn) {
      clearTimeout(turn.timer);
      turn.reject(new Error(`brain exited mid-turn (code ${code}, signal ${signal})`));
    }
    this.child = null;
    if (this.stopping) return;
    this.log(`brain: subprocess exited (code ${code}, signal ${signal}) — scheduling restart`);
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.stopping) return;
    if (this.restartTimer) return;
    const delay = this.restartBackoff;
    this.restartBackoff = Math.min(this.restartBackoff * 2, RESTART_BACKOFF_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Re-check stopping inside the timer callback. Without this, a
      // stop() that ran while the timer was pending in the macrotask
      // queue would clear the timer too late: the callback was already
      // scheduled, fires here, calls start() — which resets `stopping`
      // back to false and spawns a zombie subprocess the supervisor no
      // longer references. clearTimeout in stop() handles the typical
      // case; this guard handles the macrotask-race edge.
      if (this.stopping) return;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}
