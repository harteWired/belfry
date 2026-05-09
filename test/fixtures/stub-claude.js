#!/usr/bin/env node
/**
 * Stub claude binary for BrainSupervisor tests. Mimics
 * `claude --print --input-format=stream-json --output-format=stream-json`
 * just enough to exercise supervisor logic without requiring the real
 * binary or a network call.
 *
 * Behavior knobs via env:
 *   STUB_RESPOND_AS=text|error|hang   (default text)
 *     text  — emit a {type:result, result:"echo: <content>"} line
 *     error — emit a {type:result, is_error:true} line
 *     hang  — never respond (tests timeout)
 *   STUB_EXIT_AFTER_N=N               (default infinity)
 *     If set, exit after processing N user messages (tests crash recovery).
 *   STUB_PRE_LINES='line1\nline2'     (optional)
 *     Emit these JSON lines before processing the first input message
 *     (e.g. simulate the system/init lines real claude emits).
 */

const RESPOND_AS = process.env.STUB_RESPOND_AS ?? 'text';
const EXIT_AFTER_N = process.env.STUB_EXIT_AFTER_N
  ? Number(process.env.STUB_EXIT_AFTER_N)
  : Infinity;
const PRE_LINES = process.env.STUB_PRE_LINES
  ? process.env.STUB_PRE_LINES.split('\n').filter(Boolean)
  : [];

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

for (const line of PRE_LINES) {
  process.stdout.write(line + '\n');
}

let processed = 0;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  while (true) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg?.type !== 'user') continue;
    processed++;
    const content = msg.message?.content ?? '';
    if (RESPOND_AS === 'hang') {
      // never respond
    } else if (RESPOND_AS === 'error') {
      emit({ type: 'result', subtype: 'error', is_error: true, result: '' });
    } else {
      // Default: echo the content with a "echo:" prefix
      emit({ type: 'system', subtype: 'init' }); // realism — claude emits this
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${content}` }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${content}` });
    }
    if (processed >= EXIT_AFTER_N) {
      // Tiny delay so the parent reads our final result before our exit
      // event fires. The supervisor handles this race by draining the
      // stdout buffer on 'exit', but real claude leaves a small gap too.
      setTimeout(() => process.exit(0), 20).unref?.();
    }
  }
});

process.stdin.on('end', () => process.exit(0));
