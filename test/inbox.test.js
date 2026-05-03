import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inbox } from '../lib/inbox.js';

test('drain returns null when queue is empty', () => {
  const inbox = new Inbox();
  assert.equal(inbox.drain('foo', 'continuation'), null);
  assert.equal(inbox.peek('foo', 'continuation'), null);
});

test('push then drain returns the text and clears', () => {
  const inbox = new Inbox();
  inbox.push('foo', 'continuation', 'hello');
  assert.equal(inbox.drain('foo', 'continuation'), 'hello');
  assert.equal(inbox.drain('foo', 'continuation'), null);
});

test('multiple pushes concatenate with a blank line', () => {
  const inbox = new Inbox();
  inbox.push('foo', 'continuation', 'first');
  inbox.push('foo', 'continuation', 'second');
  inbox.push('foo', 'continuation', 'third');
  assert.equal(inbox.drain('foo', 'continuation'), 'first\n\nsecond\n\nthird');
});

test('peek does not clear the queue', () => {
  const inbox = new Inbox();
  inbox.push('foo', 'continuation', 'hello');
  assert.equal(inbox.peek('foo', 'continuation'), 'hello');
  assert.equal(inbox.peek('foo', 'continuation'), 'hello');
  assert.equal(inbox.drain('foo', 'continuation'), 'hello');
});

test('continuation and interrupt queues are independent', () => {
  const inbox = new Inbox();
  inbox.push('foo', 'continuation', 'cont');
  inbox.push('foo', 'interrupt', 'int');
  assert.equal(inbox.drain('foo', 'continuation'), 'cont');
  assert.equal(inbox.drain('foo', 'interrupt'), 'int');
});

test('different slugs do not interfere', () => {
  const inbox = new Inbox();
  inbox.push('foo', 'continuation', 'foo-msg');
  inbox.push('bar', 'continuation', 'bar-msg');
  assert.equal(inbox.drain('foo', 'continuation'), 'foo-msg');
  assert.equal(inbox.drain('bar', 'continuation'), 'bar-msg');
});

test('unknown queue throws', () => {
  const inbox = new Inbox();
  assert.throws(() => inbox.push('foo', 'nope', 'x'), /unknown queue/);
  assert.throws(() => inbox.drain('foo', 'nope'), /unknown queue/);
  assert.throws(() => inbox.peek('foo', 'nope'), /unknown queue/);
});

test('empty or non-string text is ignored on push', () => {
  const inbox = new Inbox();
  inbox.push('foo', 'continuation', '');
  inbox.push('foo', 'continuation', null);
  inbox.push('foo', 'continuation', undefined);
  assert.equal(inbox.drain('foo', 'continuation'), null);
});
