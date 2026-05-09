import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDigestFlush } from '../lib/digest-flush.js';

function makeStubs({ messageId = 99, summary = null, summaryFn } = {}) {
  const sent = [];
  const recorded = [];
  const summarizeCalls = [];
  return {
    sent,
    recorded,
    summarizeCalls,
    flush: makeDigestFlush({
      promptCap: 100,
      responseCap: 200,
      summarizeBatchFn: summaryFn ?? (summary === null
        ? null
        : async (args) => { summarizeCalls.push(args); return summary; }),
      send: async ({ slug, text }) => {
        sent.push({ slug, text });
        return { message_id: messageId };
      },
      recordReply: (msgId, slug) => recorded.push({ msgId, slug }),
    }),
  };
}

function event(status, statusFile = {}) {
  return { status, statusFile };
}

test('makeDigestFlush: composes multi-event message and records reply', async () => {
  const s = makeStubs({ summary: 'Did things.\nThen done.' });
  await s.flush('belfry', [
    event('ready', { last_prompt: 'a', last_response: 'b' }),
    event('error', { last_prompt: 'c' }),
  ]);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /belfry — 2 events/);
  assert.match(s.sent[0].text, /Did things\./);
  assert.deepEqual(s.recorded, [{ msgId: 99, slug: 'belfry' }]);
});

test('makeDigestFlush: no summarizer wired → uses Latest fallback', async () => {
  const s = makeStubs(); // summary: null in default → summarizeBatchFn = null
  await s.flush('belfry', [event('ready', { last_response: 'x' })]);
  assert.equal(s.summarizeCalls.length, 0);
  assert.match(s.sent[0].text, /Latest: ready/);
});

test('makeDigestFlush: summarizer returns null → uses Latest fallback', async () => {
  const s = makeStubs({ summary: '' /* triggers summaryFn that returns '' */ });
  // override summary to null explicitly via summaryFn
  const stubs = makeStubs({ summaryFn: async () => null });
  await stubs.flush('belfry', [event('ready', { last_response: 'x' })]);
  assert.match(stubs.sent[0].text, /Latest: ready/);
});

test('makeDigestFlush: empty events array is a no-op', async () => {
  const s = makeStubs();
  await s.flush('belfry', []);
  assert.equal(s.sent.length, 0);
  assert.equal(s.recorded.length, 0);
});

test('makeDigestFlush: truncates oversized prompt/response before summarizer call', async () => {
  const s = makeStubs({ summaryFn: async ({ events }) => {
    // Verify caller sent truncated payload.
    return events.map((e) => `${e.prompt}|${e.response}`).join('\n');
  }});
  const longPrompt = 'p'.repeat(500);
  const longResponse = 'r'.repeat(500);
  await s.flush('belfry', [event('ready', { last_prompt: longPrompt, last_response: longResponse })]);
  // promptCap=100, responseCap=200 → truncated values + ellipsis
  // The summary echoes back the truncated values; assert lengths.
  const text = s.sent[0].text;
  assert.ok(text.includes('p'.repeat(99) + '…'), 'prompt truncated to promptCap');
  assert.ok(text.includes('r'.repeat(199) + '…'), 'response truncated to responseCap');
});

test('makeDigestFlush: send failure is logged but does not throw', async () => {
  const logs = [];
  const flush = makeDigestFlush({
    promptCap: 100,
    responseCap: 200,
    summarizeBatchFn: null,
    send: async () => { throw new Error('telegram down'); },
    log: (m) => logs.push(m),
  });
  await flush('belfry', [event('ready', { last_response: 'x' })]);
  assert.ok(logs.some((m) => /digest send failed/.test(m)));
});

test('makeDigestFlush: skips recordReply when send returns no message_id', async () => {
  const recorded = [];
  const flush = makeDigestFlush({
    promptCap: 100,
    responseCap: 200,
    summarizeBatchFn: null,
    send: async () => undefined,
    recordReply: (msgId, slug) => recorded.push({ msgId, slug }),
  });
  await flush('belfry', [event('ready', { last_response: 'x' })]);
  assert.equal(recorded.length, 0);
});
