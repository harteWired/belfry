import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeHelpHandler } from '../lib/help-handler.js';

function fakeSender() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { message_id: 9000 + calls.length };
  };
  fn.calls = calls;
  return fn;
}

test('default topic (null/all) returns the overview', async () => {
  const send = fakeSender();
  const h = makeHelpHandler({ send });
  await h({ topic: null, messageId: 100 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /belfry/);
  assert.match(send.calls[0].text, /commands/i);
  assert.equal(send.calls[0].replyToMessageId, 100);
});

test('known topic returns canonical text', async () => {
  const send = fakeSender();
  const h = makeHelpHandler({ send });
  await h({ topic: 'nicknames', messageId: 100 });
  assert.match(send.calls[0].text, /\/nick/);
});

test('unknown topic returns helpful error with valid-topic list', async () => {
  const send = fakeSender();
  const h = makeHelpHandler({ send });
  await h({ topic: 'mystery', messageId: 100 });
  assert.match(send.calls[0].text, /unknown help topic/);
  for (const t of ['all', 'routing', 'nicknames', 'status', 'agent']) {
    assert.match(send.calls[0].text, new RegExp(t));
  }
});
