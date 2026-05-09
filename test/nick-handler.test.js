import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeNickHandler } from '../lib/nick-handler.js';
import { NicknameRegistry } from '../lib/nicknames.js';

function fakeSender() {
  const calls = [];
  const fn = async ({ text, replyToMessageId }) => {
    calls.push({ text, replyToMessageId });
    return { message_id: 1000 + calls.length };
  };
  fn.calls = calls;
  return fn;
}

function fakeNicks(slugs = ['life-planner', 'belfry']) {
  return new NicknameRegistry({ getActiveSlugs: () => new Set(slugs) });
}

test('nick-set: ok path replies with confirmation', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks();
  const h = makeNickHandler({ nicknames, send });
  await h({ action: 'nick-set', nickname: 'lp', slug: 'life-planner', messageId: 7 });
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /nicked 'lp' → life-planner/);
  assert.equal(send.calls[0].replyToMessageId, 7);
  assert.equal(nicknames.resolve('lp'), 'life-planner');
});

test('nick-set: rejection echoes reason', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks(['life-planner']);
  const h = makeNickHandler({ nicknames, send });
  await h({ action: 'nick-set', nickname: 'foo', slug: 'nonexistent', messageId: 7 });
  assert.match(send.calls[0].text, /couldn't set nickname/);
  assert.match(send.calls[0].text, /no active session/);
  assert.equal(nicknames.resolve('foo'), null);
});

test('nick-unset: existing nickname removed', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks();
  nicknames.set('lp', 'life-planner');
  const h = makeNickHandler({ nicknames, send });
  await h({ action: 'nick-unset', nickname: 'lp', messageId: 7 });
  assert.match(send.calls[0].text, /removed nickname 'lp'/);
  assert.equal(nicknames.resolve('lp'), null);
});

test('nick-unset: missing nickname says so', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks();
  const h = makeNickHandler({ nicknames, send });
  await h({ action: 'nick-unset', nickname: 'lp', messageId: 7 });
  assert.match(send.calls[0].text, /no nickname 'lp'/);
});

test('nick-list: empty', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks();
  const h = makeNickHandler({ nicknames, send });
  await h({ action: 'nick-list', messageId: 7 });
  assert.match(send.calls[0].text, /no nicknames set/);
});

test('nick-list: lists entries sorted', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks();
  nicknames.set('zz', 'belfry');
  nicknames.set('aa', 'life-planner');
  nicknames.set('mm', 'belfry');
  const h = makeNickHandler({ nicknames, send });
  await h({ action: 'nick-list', messageId: 7 });
  const lines = send.calls[0].text.split('\n');
  assert.deepEqual(lines, ['aa → life-planner', 'mm → belfry', 'zz → belfry']);
});

test('nick-list: truncates very long lists', async () => {
  const send = fakeSender();
  const nicknames = fakeNicks(['a']);
  const h = makeNickHandler({ nicknames, send });
  for (let i = 0; i < 35; i++) nicknames.set(`n${String(i).padStart(2, '0')}`, 'a');
  await h({ action: 'nick-list', messageId: 7 });
  const text = send.calls[0].text;
  assert.match(text, /and 5 more/);
  // Truncation cap = 30 entries + 1 "and N more" line.
  assert.equal(text.split('\n').length, 31);
});
