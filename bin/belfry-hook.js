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
  writeFileSync, readFileSync, mkdirSync, renameSync,
  openSync, closeSync, readSync, fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { resolveSlug } from '../lib/slug.js';

// Resolve the status directory (Status-File Contract v1 §A). Precedence:
//   1. CLAUDELIKE_STATUS_DIR (canonical env)
//   2. CLAUDE_DASHBOARD_DIR  (deprecated transition alias)
//   3. default: POSIX → the LITERAL /tmp/claude-dashboard, Windows →
//      os.tmpdir()/claude-dashboard.
// The fixed POSIX literal is invariant to per-process TMPDIR — Claude Code
// sets TMPDIR=/tmp/claude-<uid>, so an os.tmpdir()-derived path would diverge
// from the dir the daemon watches. Must stay in lock-step with lib/watcher.js.
export function resolveStatusDir(env = process.env) {
  return (env.CLAUDELIKE_STATUS_DIR || '').trim()
    || (env.CLAUDE_DASHBOARD_DIR || '').trim()
    || (process.platform === 'win32' ? join(tmpdir(), 'claude-dashboard') : '/tmp/claude-dashboard');
}
const STATUS_DIR = resolveStatusDir(process.env);
// Tail buffer for transcript reads. Large enough to capture a typical final
// exchange (last user prompt + last assistant response), small enough that
// the synchronous read on the hook's hot path is bounded regardless of how
// long the session is. Earlier turns that fall outside the window are
// invisible to the hook — that's fine; we only need the most recent pair.
const TAIL_BUF_BYTES = 64 * 1024;

// Retry budget for the transcript-flush race (2026-05-22). Claude Code can
// fire the Stop hook before the final assistant text block has been flushed
// to disk. If our first scan returns no last_response, sleep briefly and
// retry once — flushes empirically land within ~50–150ms. Cost is bounded
// to FLUSH_RETRY_MS even on legitimate pure-tool turns, which is
// acceptable given Stop / Notification are not on the hot path the way
// PreToolUse is.
const FLUSH_RETRY_MS = 150;

function syncSleep(ms) {
  // Block this subprocess thread for ms. We're in a one-shot CLI invoked
  // synchronously by Claude Code's hook runner — there's no event loop to
  // protect. Atomics.wait on an unshared buffer that never gets notified
  // is the standard Node idiom for "sleep without spinning."
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

// A user JSONL entry whose content is *only* tool_result blocks is the
// model's tool-execution feedback, not a real user prompt — it belongs to
// the current turn, not the previous one. Used by the turn-boundary walk
// in tailTranscript() below to keep walking past tool-result entries
// without treating them as turn boundaries.
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => b && typeof b === 'object' && b.type === 'tool_result');
}

/**
 * Best-effort: read the tail of the JSONL transcript and return the most
 * recent user prompt and assistant response *from the current turn only*.
 * Bounded I/O regardless of how long the transcript has grown — we only
 * ever read TAIL_BUF_BYTES from the end. Returns {} on any error.
 *
 * Turn-boundary awareness (2026-05-22): Claude Code's JSONL stores each
 * content block as its own line — a single assistant turn produces
 * separate {role:"assistant", content:[thinking]}, [tool_use], [text]
 * entries rather than one bundled message. A naive "find the most recent
 * text-bearing line" walk drops into the previous turn whenever the
 * current turn ends with tool_use/thinking entries (which is the common
 * case for tool-heavy turns). That manifested as Telegram pings being
 * one event out of phase — the user observed it on 2026-05-22.
 *
 * Flush-race retry (v0.1.3, 2026-05-22): Claude Code can also fire the
 * Stop hook BEFORE the final assistant text block has been flushed to
 * disk. The user saw this when the v0.1.2 hook captured "Now claudelike-
 * bar." as last_response despite the final text being a 1.6KB summary
 * with a timestamp 100ms earlier — at the time the hook ran, that text
 * was not yet on disk. Defense: if the first scan finds no last_response,
 * sync-sleep ~150ms and retry once.
 *
 * Fix: walk backward but bound the walk at the next non-tool_result user
 * entry (the turn-start prompt). Tool-result user entries are part of
 * this turn and we walk past them; a real user message marks the
 * boundary. If this turn has no text blocks at all (pure-tool turn),
 * return null for last_response rather than surfacing stale text from
 * the previous turn.
 *
 * The earlier full-file readFileSync version blocked the hook event loop
 * on long sessions (transcripts can reach tens of MB); this version is
 * constant cost.
 */
export function tailTranscript(transcriptPath) {
  let result = tailTranscriptOnce(transcriptPath);
  if (result.last_response) return result;
  // No last_response found. Could be a legitimate pure-tool turn, or the
  // flush race. One brief retry catches the race without meaningfully
  // delaying the legitimate-null case.
  syncSleep(FLUSH_RETRY_MS);
  const retried = tailTranscriptOnce(transcriptPath);
  // Prefer the retry's result wholesale — the file can only grow between
  // reads, so a successful retry strictly improves on the first.
  return retried.last_response ? retried : result;
}

function tailTranscriptOnce(transcriptPath) {
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
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const msg = entry.message ?? entry;
      const role = msg?.role;
      const content = msg?.content;
      if (role === 'assistant') {
        if (lastResponse === null) {
          const text = extractText(content);
          if (text) lastResponse = text;
        }
        // Keep walking — we still need to find the turn boundary to
        // capture last_prompt and to bound the scan.
      } else if (role === 'user') {
        if (isToolResultOnly(content)) continue;
        // Real user message — the turn boundary. Capture its text as
        // last_prompt and stop here; anything earlier is the previous
        // turn and must not be surfaced as this turn's response.
        const text = extractText(content);
        if (text) lastPrompt = text;
        break;
      }
      // Other roles (system / metadata) are ignored.
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

// belfry-owned status fields (Status-File Contract v1 §D). On every write we
// clear these from any existing file and re-set them from the fresh payload —
// "always write event-specific fields even when empty to clobber stale
// values", so a pure-tool `ready` write doesn't inherit a stale last_response
// from the prior turn. Fields NOT in this set (e.g. `context_percent` from the
// claudelike-bar statusline) are foreign and preserved by the read-merge.
const OWNED_KEYS = ['status', 'event', 'ts', 'last_prompt', 'last_response'];

function writeAtomic(filePath, payload) {
  // 0700 dir + 0600 files: the JSON carries last_prompt/last_response
  // tailed from the transcript, which can include code being authored,
  // pasted secrets, repo paths, etc. On default umask the dir lands at
  // 0755 and files at 0644 (world-readable), making cross-UID reads
  // trivial on a shared host. Tighten to owner-only.
  mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  // Read-merge-write (Contract v1 §D): preserve foreign fields written by
  // other participants in the convention rather than clobbering the file.
  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    // ENOENT or malformed — start from an empty object.
  }
  for (const k of OWNED_KEYS) delete existing[k];
  const merged = { ...existing, ...payload };
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
  renameSync(tmp, filePath);
}

export async function runHook({ stdinText, env = process.env, cwdDefault = process.cwd() } = {}) {
  let input = {};
  if (stdinText && stdinText.trim().length > 0) {
    try { input = JSON.parse(stdinText); } catch { /* swallow */ }
  }
  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : cwdDefault;
  const { slug } = resolveSlug({ cwd, env });
  if (!slug) {
    // STRICT no-match (Contract v1 §B): an unregistered directory mints no
    // status file — this is the fix for the junk-slug accumulation (#40).
    // Register the project (write the path index) or set CLAUDELIKE_BAR_STRICT=0
    // to opt back into the basename fallback.
    return { slug: null, skipped: true };
  }
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
