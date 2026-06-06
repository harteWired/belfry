import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packForTelegram } from '../lib/pack.js';

function fakeBrain({ response = null, throwErr = null, slow = false, alive = true } = {}) {
  return {
    isAlive: () => alive,
    send: async () => {
      if (slow) await new Promise((r) => setTimeout(r, 200));
      if (throwErr) throw new Error(throwErr);
      return response;
    },
  };
}

test('uses brain output when it fits the budget', async () => {
  const brain = fakeBrain({ response: 'packed body' });
  const r = await packForTelegram('a'.repeat(2000), { brain, limit: 100, reservedFooterChars: 20 });
  assert.equal(r.mode, 'brain');
  assert.equal(r.text, 'packed body');
});

test('falls back to truncate when brain returns over-budget text', async () => {
  // Brain ignored the budget and returned 500 chars; pack should reject
  // that and fall back to deterministic truncation of the original.
  const brain = fakeBrain({ response: 'x'.repeat(500) });
  const r = await packForTelegram('a'.repeat(2000), { brain, limit: 100, reservedFooterChars: 20 });
  assert.equal(r.mode, 'truncate');
  // Body fits in (limit - reservedFooter) = 80 chars.
  assert.ok(r.text.length <= 80, `truncated text too long: ${r.text.length}`);
});

test('falls back to truncate when brain throws', async () => {
  const brain = fakeBrain({ throwErr: 'brain not alive' });
  const r = await packForTelegram('a'.repeat(2000), { brain, limit: 100, reservedFooterChars: 0 });
  assert.equal(r.mode, 'truncate');
});

test('falls back when brain.isAlive() is false', async () => {
  const brain = fakeBrain({ alive: false, response: 'should never be used' });
  const r = await packForTelegram('a'.repeat(2000), { brain, limit: 100 });
  assert.equal(r.mode, 'truncate');
});

test('falls back to truncate when brain times out', async () => {
  // Brain takes 200ms; timeout is 50ms.
  const brain = fakeBrain({ slow: true, response: 'too late' });
  const r = await packForTelegram('a'.repeat(2000), {
    brain,
    limit: 100,
    reservedFooterChars: 0,
    brainTimeoutMs: 50,
  });
  assert.equal(r.mode, 'truncate');
});

test('no brain provided → truncate path', async () => {
  const r = await packForTelegram('a'.repeat(2000), { limit: 100 });
  assert.equal(r.mode, 'truncate');
  assert.ok(r.text.length <= 100);
});

test('rejects bad inputs', async () => {
  await assert.rejects(() => packForTelegram('', { limit: 100 }));
  await assert.rejects(() => packForTelegram('x', { limit: 0 }));
});
