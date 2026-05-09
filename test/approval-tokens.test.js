import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalTokens } from '../lib/approval-tokens.js';

test('issue: returns a hex token and stores the entry', () => {
  const a = new ApprovalTokens();
  const token = a.issue('belfry', 1234, 'body');
  assert.match(token, /^[0-9a-f]{16}$/);
  assert.equal(a.size(), 1);
});

test('consume: returns the entry and removes it', () => {
  const a = new ApprovalTokens();
  const token = a.issue('belfry', 5, 'hi');
  const entry = a.consume(token);
  assert.equal(entry.slug, 'belfry');
  assert.equal(entry.messageId, 5);
  assert.equal(entry.originalText, 'hi');
  assert.equal(a.size(), 0);
  // Second consume returns null (idempotent against double-tap).
  assert.equal(a.consume(token), null);
});

test('consume: returns null for unknown / non-string', () => {
  const a = new ApprovalTokens();
  assert.equal(a.consume('nope'), null);
  assert.equal(a.consume(undefined), null);
  assert.equal(a.consume(42), null);
});

test('consume: returns null for expired entry', () => {
  let now = 0;
  const a = new ApprovalTokens({ ttlMs: 1000, now: () => now });
  const token = a.issue('belfry', 1, 'x');
  now = 5000;
  assert.equal(a.consume(token), null);
});

test('gc: drops expired entries', () => {
  let now = 0;
  const a = new ApprovalTokens({ ttlMs: 1000, now: () => now });
  a.issue('a', 1, '');
  a.issue('b', 2, '');
  now = 5000;
  a.issue('c', 3, '');
  a.gc();
  assert.equal(a.size(), 1);
});

test('setMessageId: patches existing entry', () => {
  const a = new ApprovalTokens();
  const tok = a.issue('belfry', null, 'body');
  assert.equal(a.setMessageId(tok, 12345), true);
  const entry = a.consume(tok);
  assert.equal(entry.messageId, 12345);
});

test('setMessageId: returns false on unknown / expired token', () => {
  let now = 0;
  const a = new ApprovalTokens({ ttlMs: 1000, now: () => now });
  assert.equal(a.setMessageId('nonexistent', 1), false);
  const tok = a.issue('s', null, '');
  now = 5000;
  assert.equal(a.setMessageId(tok, 99), false);
});

test('revoke: drops entry without consuming outcome', () => {
  const a = new ApprovalTokens();
  const tok = a.issue('s', null, '');
  a.revoke(tok);
  assert.equal(a.size(), 0);
  assert.equal(a.consume(tok), null);
});
