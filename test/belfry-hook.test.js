import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook, statusFromEvent, tailTranscript } from '../bin/belfry-hook.js';

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

  const writtenPath = path.join(os.tmpdir(), 'claude-dashboard', `${slug}.json`);
  const written = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
  assert.equal(written.status, 'ready');
  assert.equal(written.event, 'Stop');
  assert.equal(written.last_prompt, 'do the thing');
  assert.equal(written.last_response, 'done');
  assert.match(written.ts, /^\d{4}-\d{2}-\d{2}T/);

  fs.unlinkSync(writtenPath);
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
  const writtenPath = path.join(os.tmpdir(), 'claude-dashboard', `${slug}.json`);
  fs.unlinkSync(writtenPath);
});
