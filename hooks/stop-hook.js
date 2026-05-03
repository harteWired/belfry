#!/usr/bin/env node
/**
 * Belfry Stop hook.
 *
 * Wire-up: install in ~/.claude/settings.json under `hooks.Stop`. See
 * docs/install-hooks.md for the snippet.
 *
 * Behavior:
 *   1. Read the Claude Code Stop event from stdin (JSON; we use `cwd`).
 *   2. Derive the slug the same way claudelike-bar does so the inbox key
 *      matches what the Telegram poller pushed under.
 *   3. Call belfry's MCP `drain_inbox(slug, "continuation")` over loopback.
 *   4. If the inbox returned text, print {"decision":"block","reason":text}
 *      to stdout — Claude Code resumes with that text as the next prompt.
 *      Otherwise exit 0 silently.
 *
 * Failure modes are deliberately quiet: if belfry isn't running, if the
 * MCP errors, if the slug has nothing pending — exit 0 and let Claude
 * Code finish the Stop normally. Hooks must never block the user just
 * because a bridge daemon is down.
 */

import { fileURLToPath } from 'node:url';
import { deriveSlug } from '../lib/slug.js';

const DEFAULT_PORT = 9876;
const RPC_TIMEOUT_MS = 2000;

async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    // If stdin has no data within 200ms, resolve empty — keeps the hook
    // testable from a normal shell where stdin is a tty.
    setTimeout(() => resolve(buf), 200);
  });
}

async function rpc({ host, port, method, params }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return json.result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function runStopHook({ stdin, env = process.env, stdout = process.stdout } = {}) {
  let event = {};
  try {
    event = JSON.parse(stdin || '{}');
  } catch {
    event = {};
  }
  const cwd = event.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const slug = deriveSlug({ cwd, env });
  const port = Number(env.BELFRY_MCP_PORT || DEFAULT_PORT);
  const host = '127.0.0.1';

  const result = await rpc({
    host,
    port,
    method: 'tools/call',
    params: { name: 'drain_inbox', arguments: { slug, queue: 'continuation' } },
  });
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string' && text.length > 0) {
    stdout.write(JSON.stringify({ decision: 'block', reason: text }) + '\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readStdin().then((stdin) => runStopHook({ stdin })).catch(() => process.exit(0));
}
