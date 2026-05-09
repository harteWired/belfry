import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeApprovalHandler } from '../lib/approval-handler.js';
import { ApprovalTokens } from '../lib/approval-tokens.js';

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  fn.calls = calls;
  return fn;
}

function fakeRegistry() {
  const calls = [];
  return {
    delivered: calls,
    deliver(slug, text, msgId, attachment) {
      calls.push({ slug, text, msgId, attachment });
      return 1;
    },
  };
}

test('valid Allow tap: delivers "yes", edits message, answers callback', async () => {
  const tokens = new ApprovalTokens();
  const reg = fakeRegistry();
  const fetchImpl = fakeFetch();
  const tok = tokens.issue('belfry', 100, 'permission prompt body');
  const h = makeApprovalHandler({
    botToken: 'TOK',
    chatId: 1,
    approvalTokens: tokens,
    registry: reg,
    fetchImpl,
    now: () => Date.UTC(2026, 0, 1, 12, 30),
  });
  await h({ callbackQueryId: 'cb1', verb: 'allow', token: tok, messageId: 100 });
  assert.equal(reg.delivered.length, 1);
  assert.equal(reg.delivered[0].slug, 'belfry');
  assert.equal(reg.delivered[0].text, 'yes');
  // Two API calls: editMessageText, answerCallbackQuery
  const urls = fetchImpl.calls.map((c) => c.url);
  assert.ok(urls.some((u) => u.endsWith('/editMessageText')));
  assert.ok(urls.some((u) => u.endsWith('/answerCallbackQuery')));
  // Edit body contains the original prompt + the trailer with verb label.
  const edit = fetchImpl.calls.find((c) => c.url.endsWith('/editMessageText'));
  assert.match(edit.body.text, /permission prompt body/);
  assert.match(edit.body.text, /Allowed/);
  // Keyboard was emptied.
  assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] });
});

test('Deny tap: injects "no"', async () => {
  const tokens = new ApprovalTokens();
  const reg = fakeRegistry();
  const fetchImpl = fakeFetch();
  const tok = tokens.issue('life-planner', 7, 'body');
  const h = makeApprovalHandler({
    botToken: 'TOK', chatId: 1, approvalTokens: tokens, registry: reg, fetchImpl,
  });
  await h({ callbackQueryId: 'cb', verb: 'deny', token: tok, messageId: 7 });
  assert.equal(reg.delivered[0].text, 'no');
});

test('Always tap: injects "yes (always)"', async () => {
  const tokens = new ApprovalTokens();
  const reg = fakeRegistry();
  const fetchImpl = fakeFetch();
  const tok = tokens.issue('s', 1, 'body');
  const h = makeApprovalHandler({
    botToken: 'TOK', chatId: 1, approvalTokens: tokens, registry: reg, fetchImpl,
  });
  await h({ callbackQueryId: 'cb', verb: 'always', token: tok, messageId: 1 });
  assert.equal(reg.delivered[0].text, 'yes (always)');
});

test('Defer tap: drops keyboard but does NOT deliver', async () => {
  const tokens = new ApprovalTokens();
  const reg = fakeRegistry();
  const fetchImpl = fakeFetch();
  const tok = tokens.issue('s', 1, 'body');
  const h = makeApprovalHandler({
    botToken: 'TOK', chatId: 1, approvalTokens: tokens, registry: reg, fetchImpl,
  });
  await h({ callbackQueryId: 'cb', verb: 'defer', token: tok, messageId: 1 });
  assert.equal(reg.delivered.length, 0, 'defer should not deliver');
  // Edit still happened.
  assert.ok(fetchImpl.calls.some((c) => c.url.endsWith('/editMessageText')));
});

test('Stale token: alerts user, no delivery, no edit', async () => {
  const tokens = new ApprovalTokens();
  const reg = fakeRegistry();
  const fetchImpl = fakeFetch();
  const h = makeApprovalHandler({
    botToken: 'TOK', chatId: 1, approvalTokens: tokens, registry: reg, fetchImpl,
  });
  // No issue() — token is unknown.
  await h({ callbackQueryId: 'cb', verb: 'allow', token: 'unknownhex', messageId: 1 });
  assert.equal(reg.delivered.length, 0);
  // Only answerCallbackQuery (with show_alert) — no edit.
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /answerCallbackQuery/);
  assert.equal(fetchImpl.calls[0].body.show_alert, true);
});

test('Unknown verb: answers callback so spinner stops, no delivery', async () => {
  const tokens = new ApprovalTokens();
  const reg = fakeRegistry();
  const fetchImpl = fakeFetch();
  const tok = tokens.issue('s', 1, 'body');
  const logs = [];
  const h = makeApprovalHandler({
    botToken: 'TOK', chatId: 1, approvalTokens: tokens, registry: reg, fetchImpl,
    log: (m) => logs.push(m),
  });
  await h({ callbackQueryId: 'cb', verb: 'mystery', token: tok, messageId: 1 });
  assert.equal(reg.delivered.length, 0);
  // Just answerCallbackQuery — no edit (token is consumed; nothing to draw).
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /answerCallbackQuery/);
  assert.equal(fetchImpl.calls[0].body.show_alert, true);
  assert.ok(logs.some((m) => /unknown verb/.test(m)));
});
