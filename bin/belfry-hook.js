#!/usr/bin/env node
/**
 * belfry-hook — Claude Code hook that writes the local-machine
 * `/tmp/claude-dashboard/<slug>.json` convention (see docs/CONVENTION.md).
 *
 * Reads Claude Code's hook input JSON from stdin, derives the slug, parses
 * the transcript best-effort to populate last_prompt/last_response, and
 * atomically writes the status JSON. Exits 0 on any error so a hook glitch
 * never blocks the user's session.
 *
 * Wire into a project's `.claude/settings.json`:
 *
 *   {
 *     "hooks": {
 *       "Stop":         [{ "hooks": [{ "type": "command", "command": "belfry-hook" }] }],
 *       "Notification": [{ "hooks": [{ "type": "command", "command": "belfry-hook" }] }]
 *     }
 *   }
 *
 * Use `belfry-install-hook` to add this automatically with detection of
 * an already-present writer of the convention (e.g. claudelike-bar).
 */
import {
  writeFileSync, mkdirSync, renameSync,
  openSync, closeSync, readSync, fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { deriveSlug } from '../lib/slug.js';

const STATUS_DIR = join(tmpdir(), 'claude-dashboard');
// Tail buffer for transcript reads. Large enough to capture a typical final
// exchange (last user prompt + last assistant response), small enough that
// the synchronous read on the hook's hot path is bounded regardless of how
// long the session is. Earlier turns that fall outside the window are
// invisible to the hook — that's fine; we only need the most recent pair.
const TAIL_BUF_BYTES = 64 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let timer = setTimeout(() => resolve(buf), 1000); // hard cap — never hang the session
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

export function statusFromEvent(eventName) {
  switch (eventName) {
    case 'Stop':
    case 'SubagentStop':
      return 'ready';
    case 'Notification':
      return 'waiting';
    case 'PreToolUse':
    case 'PostToolUse':
    case 'UserPromptSubmit':
      return 'working';
    case 'SessionStart':
      return 'idle';
    case 'SessionEnd':
      return 'offline';
    default:
      return 'idle';
  }
}

function extractText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/**
 * Best-effort: read the tail of the JSONL transcript and return the most
 * recent user prompt and assistant response. Bounded I/O regardless of how
 * long the transcript has grown — we only ever read TAIL_BUF_BYTES from the
 * end. If the most recent exchange spans more than that, we may surface only
 * one role (last_response is prioritised). Returns {} on any error.
 *
 * The earlier full-file readFileSync version blocked the hook event loop on
 * long sessions (transcripts can reach tens of MB); this version is constant
 * cost.
 */
export function tailTranscript(transcriptPath) {
  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const stat = fstatSync(fd);
    if (stat.size === 0) return {};
    const readSize = Math.min(stat.size, TAIL_BUF_BYTES);
    const start = stat.size - readSize;
    const buf = Buffer.alloc(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, start);
    closeSync(fd);
    fd = null;
    let chunk = buf.slice(0, bytesRead).toString('utf8');
    // If we started reading mid-file, the first line is probably a partial
    // and won't parse — drop everything up to the first newline.
    if (start > 0) {
      const nl = chunk.indexOf('\n');
      chunk = nl >= 0 ? chunk.slice(nl + 1) : '';
    }
    const lines = chunk.split('\n').filter(Boolean);
    let lastPrompt = null;
    let lastResponse = null;
    // Reverse-scan: the most recent entries are at the end. Stop early once
    // we've found one of each role — no need to walk the whole tail buffer.
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const msg = entry.message ?? entry;
      const role = msg?.role;
      const text = extractText(msg?.content);
      if (!text) continue;
      if (role === 'assistant' && !lastResponse) lastResponse = text;
      else if (role === 'user' && !lastPrompt) lastPrompt = text;
      if (lastPrompt && lastResponse) break;
    }
    const out = {};
    if (lastPrompt) out.last_prompt = lastPrompt;
    if (lastResponse) out.last_response = lastResponse;
    return out;
  } catch {
    return {};
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* swallow */ }
    }
  }
}

function writeAtomic(filePath, payload) {
  // 0700 dir + 0600 files: the JSON carries last_prompt/last_response
  // tailed from the transcript, which can include code being authored,
  // pasted secrets, repo paths, etc. On default umask the dir lands at
  // 0755 and files at 0644 (world-readable), making cross-UID reads
  // trivial on a shared host. Tighten to owner-only.
  mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, filePath);
}

export async function runHook({ stdinText, env = process.env, cwdDefault = process.cwd() } = {}) {
  let input = {};
  if (stdinText && stdinText.trim().length > 0) {
    try { input = JSON.parse(stdinText); } catch { /* swallow */ }
  }
  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : cwdDefault;
  const slug = deriveSlug({ cwd, env });
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
  const status = statusFromEvent(event);
  const tail = typeof input.transcript_path === 'string' && input.transcript_path.length > 0
    ? tailTranscript(input.transcript_path)
    : {};
  const payload = {
    status,
    event,
    ts: new Date().toISOString(),
    ...tail,
  };
  writeAtomic(join(STATUS_DIR, `${slug}.json`), payload);
  return { slug, payload };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readStdin()
    .then((text) => runHook({ stdinText: text }))
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`belfry-hook error: ${err.message}\n`);
      process.exit(0);
    });
}
