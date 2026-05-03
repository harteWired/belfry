/**
 * Decide what to do with an inbound Telegram reply.
 *
 * Old design (Phase 1, pre-idle-fix): every routed message went straight to
 * an in-memory inbox; the Stop hook drained it at the next turn boundary.
 * That works while a session is mid-conversation but breaks the moment the
 * session goes idle — Stop never fires again, the reply rots in the inbox.
 *
 * New design: dispatcher reads the slug's dashboard JSON
 * (`/tmp/claude-dashboard/<slug>.json`) to decide:
 *   - status === 'working' → push to inbox; the Stop hook will drain it at
 *     the end of the in-flight turn.
 *   - anything else (ready, error, missing, parse fail) → spawn
 *     `claude --resume <session-id> --print "<reply>"` in the slug's cwd.
 *     Capture stdout, send back to Telegram so the user sees the answer
 *     without needing to alt-tab to the terminal.
 *
 * Quacks like an Inbox for the `push(slug, queue, text)` shape — the Poller
 * doesn't need to know which path will be taken. Returns a Promise so a
 * caller can await if needed; the Poller fires-and-forgets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class Dispatcher {
  constructor({
    inbox,
    runner,
    sessionResolver,
    subscriptions,
    dashboardDir = '/tmp/claude-dashboard',
    sendReply,
    log = () => {},
    fsImpl = fs,
  }) {
    this.inbox = inbox;
    this.runner = runner;
    this.sessionResolver = sessionResolver;
    this.subscriptions = subscriptions;
    this.dashboardDir = dashboardDir;
    this.sendReply = sendReply;
    this.log = log;
    this.fsImpl = fsImpl;
  }

  /**
   * Mirror of Inbox#push. Interrupt queue is unconditionally inboxed —
   * interrupts only make sense mid-tool-call, so the active session
   * assumption is intrinsic. Continuation goes through the smart path.
   */
  push(slug, queue, text) {
    if (queue !== 'continuation') {
      this.inbox.push(slug, queue, text);
      return Promise.resolve();
    }
    return this.dispatchContinuation(slug, text);
  }

  async dispatchContinuation(slug, text) {
    const status = this.readDashboardStatus(slug);
    // 'ready' = turn finished, session is idle waiting for the next prompt.
    // Everything else (working, tool_end, notification, etc.) means the
    // session is mid-conversation; the Stop hook will fire and drain the
    // inbox at the next turn boundary, so push there.
    // Missing JSON / error: treat as idle and let the spawn path try.
    const idle = status === 'ready' || status === null || status === 'error';
    if (!idle) {
      this.inbox.push(slug, 'continuation', text);
      this.log(`dispatcher: ${slug} active (status=${status}) — pushed to inbox (${text.length} chars)`);
      return;
    }

    const sub = this.subscriptions[slug];
    if (!sub?.cwd) {
      this.log(`dispatcher: ${slug} has no cwd configured — falling back to inbox`);
      this.inbox.push(slug, 'continuation', text);
      return;
    }

    const sessionId = this.sessionResolver(sub.cwd);
    this.log(`dispatcher: spawning claude for ${slug} (status=${status ?? 'missing'}, session=${sessionId ?? 'fresh'})`);

    let result;
    try {
      result = await this.runner({ prompt: text, cwd: sub.cwd, sessionId });
    } catch (err) {
      this.log(`dispatcher: runner threw for ${slug}: ${err.message}`);
      await this.safeReply(slug, `⚠ belfry could not drive ${slug}: ${err.message}`);
      return;
    }

    if (result.ok && result.stdout) {
      this.log(`dispatcher: ${slug} returned ${result.stdout.length} chars; relaying to telegram`);
      await this.safeReply(slug, result.stdout);
      return;
    }

    const reason = result.timedOut
      ? 'timed out (60s)'
      : (result.stderr || `exit ${result.code}`).slice(0, 300);
    this.log(`dispatcher: claude run failed for ${slug}: ${reason}`);
    await this.safeReply(slug, `⚠ belfry could not drive ${slug}: ${reason}`);
  }

  readDashboardStatus(slug) {
    try {
      const raw = this.fsImpl.readFileSync(path.join(this.dashboardDir, `${slug}.json`), 'utf8');
      const json = JSON.parse(raw);
      return typeof json.status === 'string' ? json.status : null;
    } catch {
      return null;
    }
  }

  async safeReply(slug, text) {
    if (!this.sendReply) return;
    try {
      await this.sendReply({ slug, text });
    } catch (err) {
      this.log(`dispatcher: telegram reply failed for ${slug}: ${err.message}`);
    }
  }
}
