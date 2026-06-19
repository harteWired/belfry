import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

// Isolate the dashboard dir to a temp path BEFORE importing the hook, so its
// module-level STATUS_DIR (which honors CLAUDE_DASHBOARD_DIR) writes here and
// not into the real /tmp/claude-dashboard the live daemon watches.
const DASH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-dash-'));
process.env.CLAUDE_DASHBOARD_DIR = DASH_DIR;
const { runHook, statusFromEvent, tailTranscript, resolveStatusDir } = await import('../bin/belfry-hook.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('statusFromEvent maps Claude Code hook events to convention statuses', () => {
  assert.equal(statusFromEvent('Stop'), 'ready');
  assert.equal(statusFromEvent('SubagentStop'), 'ready');
  assert.equal(statusFromEvent('Notification'), 'waiting');
  assert.equal(statusFromEvent('PreToolUse'), 'working');
  assert.equal(statusFromEvent('PostToolUse'), 'working');
  assert.equal(statusFromEvent('UserPromptSubmit'), 'working');
  assert.equal(statusFromEvent('SessionStart'), 'idle');
  assert.equal(statusFromEvent('SessionEnd'), 'offline');
  assert.equal(statusFromEvent('Unknown'), 'idle');
});

test('tailTranscript pulls the last user prompt and assistant response', () => {
  const dir = tmpDir('belfry-hook-');
  const transcriptPath = path.join(dir, 't.jsonl');
  // Mix of nested {message:{role,content:[{type:text,text:...}]}} entries
  // (matching Claude Code transcript shape) and direct {role,content} forms.
  const lines = [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'older prompt' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'older response' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'newer prompt' }] } }),
    JSON.stringify({ role: 'assistant', content: 'newer response' }),
    'not json — should be skipped',
  ].join('\n');
  fs.writeFileSync(transcriptPath, lines);
  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_prompt, 'newer prompt');
  assert.equal(out.last_response, 'newer response');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript returns {} on missing or unreadable transcript', () => {
  assert.deepEqual(tailTranscript('/no/such/file'), {});
});

test('tailTranscript only reads the tail of a large transcript', () => {
  // Build a transcript well over the 64 KiB tail buffer with thousands of
  // older entries followed by the final exchange. The tail-read should pick
  // up only the final two entries and ignore everything earlier.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-big-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  const oldEntry = JSON.stringify({
    message: { role: 'assistant', content: 'older filler — should be ignored by tail-read'.padEnd(200, 'x') },
  });
  // ~200 bytes per line × 2000 lines = ~400 KB, far past TAIL_BUF_BYTES.
  const filler = (oldEntry + '\n').repeat(2000);
  const finalUser = JSON.stringify({ message: { role: 'user', content: 'tail-prompt' } });
  const finalAssistant = JSON.stringify({ message: { role: 'assistant', content: 'tail-response' } });
  fs.writeFileSync(transcriptPath, filler + finalUser + '\n' + finalAssistant + '\n');
  const stat = fs.statSync(transcriptPath);
  assert.ok(stat.size > 100 * 1024, `expected a large transcript, got ${stat.size} bytes`);

  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_prompt, 'tail-prompt');
  assert.equal(out.last_response, 'tail-response');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript handles a small transcript (single line, no partial-line drop needed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-small-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ message: { role: 'assistant', content: 'only line' } }) + '\n',
  );
  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_response, 'only line');
  assert.equal(out.last_prompt, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript returns {} on empty transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-empty-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcriptPath, '');
  assert.deepEqual(tailTranscript(transcriptPath), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runHook writes the convention JSON atomically', async () => {
  const dir = tmpDir('belfry-hook-');
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ message: { role: 'user', content: 'do the thing' } }) + '\n' +
    JSON.stringify({ message: { role: 'assistant', content: 'done' } }) + '\n',
  );
  const slug = `belfry-hook-test-${process.pid}-${Date.now()}`;
  const stdinText = JSON.stringify({
    hook_event_name: 'Stop',
    cwd: '/whatever',
    transcript_path: transcriptPath,
  });
  const result = await runHook({
    stdinText,
    env: { CLAUDE_SESSION_SLUG: slug },
  });
  assert.equal(result.slug, slug);

  const writtenPath = path.join(DASH_DIR, `${slug}.json`);
  const written = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
  assert.equal(written.status, 'ready');
  assert.equal(written.event, 'Stop');
  assert.equal(written.last_prompt, 'do the thing');
  assert.equal(written.last_response, 'done');
  assert.match(written.ts, /^\d{4}-\d{2}-\d{2}T/);

  fs.unlinkSync(writtenPath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript: tool-only turn returns no last_response (does not leak prior turn)', () => {
  // Repro of the 2026-05-22 "one event behind" bug. Current turn ends with
  // thinking + tool_use + tool_result entries — no text block. Walking back
  // past the turn boundary (the user prompt that started this turn) into
  // the previous turn must NOT surface that turn's text as this turn's
  // last_response.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-toolturn-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  const lines = [
    // Previous turn — should never be surfaced as current last_response.
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'older prompt' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'older response' }] } }),
    // Current turn — tool-only ending.
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'current prompt' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }),
  ].join('\n');
  fs.writeFileSync(transcriptPath, lines);
  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_prompt, 'current prompt');
  assert.equal(out.last_response, undefined, 'must not leak previous turn\'s response into the current turn');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript: tool_result user entries do not count as turn boundary', () => {
  // Within a single turn, tool_result user entries appear between
  // assistant tool_use lines. They must be walked past silently — they
  // belong to the current turn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-toolresult-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  const lines = [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'do the work' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r1' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'done with the work' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'r2' }] } }),
  ].join('\n');
  fs.writeFileSync(transcriptPath, lines);
  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_prompt, 'do the work');
  assert.equal(out.last_response, 'done with the work');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript: returns latest text within current turn, not earlier mid-turn text', () => {
  // Multiple text blocks in current turn. Reverse walk hits the LATEST one
  // first and returns it — older mid-turn text is ignored.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-latest-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  const lines = [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'p' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'first thought' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'X' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'i', content: '' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } }),
  ].join('\n');
  fs.writeFileSync(transcriptPath, lines);
  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_response, 'final answer');
  assert.equal(out.last_prompt, 'p');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript: thinking blocks do not count as text', () => {
  // Thinking content is a separate block type that isn't user-visible.
  // It must not satisfy the "has text" check on its own.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-thinking-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  const lines = [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning...' }] } }),
  ].join('\n');
  fs.writeFileSync(transcriptPath, lines);
  const out = tailTranscript(transcriptPath);
  assert.equal(out.last_prompt, 'go');
  assert.equal(out.last_response, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript: retries when first scan misses a still-flushing final text block', async () => {
  // Repro of the v0.1.2-era flush race: Claude Code can fire the Stop
  // hook before the final assistant text block has been flushed to disk.
  // First scan returns null; during the retry's syncSleep, a subprocess
  // appends the missing line; the second scan picks it up.
  //
  // Note: syncSleep uses Atomics.wait which blocks the entire Node event
  // loop including setTimeout. We need a SEPARATE process to do the late
  // append while the main process is blocked.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-flush-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text: 'current prompt' }] },
  }) + '\n');
  const appender = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    fs.appendFileSync(${JSON.stringify(transcriptPath)}, ${JSON.stringify(
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'final answer flushed late' }] } }) + '\n'
    )});
  `], { stdio: 'ignore' });
  const out = tailTranscript(transcriptPath);
  await new Promise((res) => appender.once('exit', res));
  assert.equal(out.last_response, 'final answer flushed late', 'retry must catch the late-flushed text');
  assert.equal(out.last_prompt, 'current prompt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailTranscript: pure-tool turn still returns no last_response after retry', () => {
  // Retry should NOT manufacture content — a legitimate pure-tool turn
  // remains null after the retry runs (just takes ~150ms longer).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belfry-hook-puretool-'));
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r' }] } }),
  ].join('\n') + '\n');
  const t0 = Date.now();
  const out = tailTranscript(transcriptPath);
  const elapsed = Date.now() - t0;
  assert.equal(out.last_response, undefined);
  assert.equal(out.last_prompt, 'do it');
  // Sanity: retry path engaged (sleep ran).
  assert.ok(elapsed >= 140, `expected ~150ms retry delay, got ${elapsed}ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runHook tolerates malformed stdin', async () => {
  const slug = `belfry-hook-bad-${process.pid}-${Date.now()}`;
  const result = await runHook({
    stdinText: 'not json at all',
    env: { CLAUDE_SESSION_SLUG: slug },
  });
  assert.equal(result.slug, slug);
  // Status defaults to idle when no event is supplied.
  assert.equal(result.payload.status, 'idle');
  const writtenPath = path.join(DASH_DIR, `${slug}.json`);
  fs.unlinkSync(writtenPath);
});

// --- Status-File Contract v1 (#40) ---

test('resolveStatusDir precedence: CLAUDELIKE_STATUS_DIR > CLAUDE_DASHBOARD_DIR > default', () => {
  assert.equal(
    resolveStatusDir({ CLAUDELIKE_STATUS_DIR: '/a', CLAUDE_DASHBOARD_DIR: '/b' }),
    '/a',
    'canonical env wins over the deprecated alias',
  );
  assert.equal(
    resolveStatusDir({ CLAUDE_DASHBOARD_DIR: '/b' }),
    '/b',
    'alias is honored during transition',
  );
  const dflt = resolveStatusDir({});
  if (process.platform === 'win32') {
    assert.match(dflt, /claude-dashboard$/);
  } else {
    assert.equal(dflt, '/tmp/claude-dashboard', 'POSIX default is the fixed literal');
  }
});

test('runHook STRICT: unregistered dir with no env mints no status file (skipped)', async () => {
  // A path with no registered ancestor in the real ~/.claude index. (runHook
  // resolves against os.homedir(), so use a dir nothing could have registered.)
  const cwd = path.join(os.tmpdir(), `belfry-strict-nomatch-${process.pid}-${Date.now()}`, 'deep', 'subdir');
  const result = await runHook({
    stdinText: JSON.stringify({ hook_event_name: 'Stop', cwd }),
    env: {}, // no CLAUDE_SESSION_SLUG → STRICT declines
    cwdDefault: cwd,
  });
  assert.equal(result.slug, null);
  assert.equal(result.skipped, true);
});

test('runHook LEGACY (CLAUDELIKE_BAR_STRICT=0): unregistered dir falls back to basename', async () => {
  const result = await runHook({
    stdinText: JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/some-legacy-dir' }),
    env: { CLAUDELIKE_BAR_STRICT: '0' },
    cwdDefault: '/tmp/some-legacy-dir',
  });
  assert.equal(result.slug, 'some-legacy-dir');
  fs.unlinkSync(path.join(DASH_DIR, 'some-legacy-dir.json'));
});

test('writeAtomic read-merge: preserves foreign fields, refreshes owned fields', async () => {
  const slug = `belfry-hook-merge-${process.pid}-${Date.now()}`;
  const filePath = path.join(DASH_DIR, `${slug}.json`);
  // Simulate the claudelike-bar statusline having written context_percent +
  // a now-stale last_response.
  fs.writeFileSync(filePath, JSON.stringify({
    context_percent: 42,
    status: 'working',
    last_response: 'STALE from a prior turn',
  }));

  const dir = tmpDir('belfry-hook-merge-');
  const transcriptPath = path.join(dir, 't.jsonl');
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({ message: { role: 'user', content: 'fresh prompt' } }) + '\n' +
    JSON.stringify({ message: { role: 'assistant', content: 'fresh response' } }) + '\n',
  );
  await runHook({
    stdinText: JSON.stringify({ hook_event_name: 'Stop', cwd: '/whatever', transcript_path: transcriptPath }),
    env: { CLAUDE_SESSION_SLUG: slug },
  });

  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.context_percent, 42, 'foreign field preserved');
  assert.equal(written.status, 'ready', 'owned field refreshed');
  assert.equal(written.last_response, 'fresh response', 'owned field overwritten, not stale');

  fs.unlinkSync(filePath);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic read-merge: a pure-tool turn CLEARS a stale owned field but keeps foreign', async () => {
  const slug = `belfry-hook-clear-${process.pid}-${Date.now()}`;
  const filePath = path.join(DASH_DIR, `${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    context_percent: 7,
    last_response: 'STALE — should be cleared',
  }));

  const dir = tmpDir('belfry-hook-clear-');
  const transcriptPath = path.join(dir, 't.jsonl');
  // Pure-tool turn: no assistant text block → tail yields no last_response.
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r' }] } }),
  ].join('\n') + '\n');
  await runHook({
    stdinText: JSON.stringify({ hook_event_name: 'Stop', cwd: '/whatever', transcript_path: transcriptPath }),
    env: { CLAUDE_SESSION_SLUG: slug },
  });

  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.context_percent, 7, 'foreign field preserved');
  assert.equal(written.last_response, undefined, 'stale owned field cleared, not inherited');

  fs.unlinkSync(filePath);
  fs.rmSync(dir, { recursive: true, force: true });
});
