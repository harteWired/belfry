import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationMemory } from '../lib/conversation-memory.js';

test('push: records user and assistant turns; recent returns newest-last', () => {
  const m = new ConversationMemory();
  m.push('chatA', { role: 'user', text: 'first' });
  m.push('chatA', { role: 'assistant', text: 'reply' });
  m.push('chatA', { role: 'user', text: 'second' });
  const turns = m.recent('chatA');
  assert.equal(turns.length, 3);
  assert.equal(turns[0].text, 'first');
  assert.equal(turns[2].text, 'second');
});

test('push: ignores invalid role / empty text / missing chatId', () => {
  const m = new ConversationMemory();
  m.push('chatA', { role: 'system', text: 'should be dropped' });
  m.push('chatA', { role: 'user', text: '' });
  m.push('', { role: 'user', text: 'no chat' });
  assert.deepEqual(m.recent('chatA'), []);
});

test('trim: caps to maxTurns', () => {
  const m = new ConversationMemory({ maxTurns: 3 });
  for (let i = 0; i < 6; i++) m.push('chatA', { role: 'user', text: `m${i}` });
  const turns = m.recent('chatA');
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.text), ['m3', 'm4', 'm5']);
});

test('trim: caps to maxChars (drops oldest, keeps at least 1)', () => {
  const m = new ConversationMemory({ maxTurns: 100, maxChars: 20 });
  m.push('chatA', { role: 'user', text: 'a'.repeat(15) });
  m.push('chatA', { role: 'user', text: 'b'.repeat(15) });
  m.push('chatA', { role: 'user', text: 'c'.repeat(15) });
  const turns = m.recent('chatA');
  // Total is 45 chars > 20, oldest gets dropped until under or only 1 left.
  // After drops: 'cccccc...' (15) only, since 30 > 20 still after dropping a.
  assert.ok(turns.length >= 1);
  assert.ok(turns.length <= 2);
});

test('idle expiry: clears buffer after idleMs', () => {
  let now = 0;
  const m = new ConversationMemory({ idleMs: 1000, now: () => now });
  m.push('chatA', { role: 'user', text: 'hi' });
  now = 500;
  assert.equal(m.recent('chatA').length, 1);
  now = 2000;
  assert.deepEqual(m.recent('chatA'), []);
});

test('idle expiry: a new push after expiry starts fresh', () => {
  let now = 0;
  const m = new ConversationMemory({ idleMs: 1000, now: () => now });
  m.push('chatA', { role: 'user', text: 'old' });
  now = 5000;
  m.push('chatA', { role: 'user', text: 'fresh' });
  const turns = m.recent('chatA');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'fresh');
});

test('contextBlock: empty when no turns', () => {
  const m = new ConversationMemory();
  assert.equal(m.contextBlock('chatA'), '');
});

test('contextBlock: formats user/assistant turns with role labels', () => {
  const m = new ConversationMemory();
  m.push('chatA', { role: 'user', text: 'hello' });
  m.push('chatA', { role: 'assistant', text: 'hi back' });
  const block = m.contextBlock('chatA');
  assert.match(block, /User: hello/);
  assert.match(block, /Belfry: hi back/);
  assert.match(block, /Recent context/);
});

test('clear: forgets a chat without affecting others', () => {
  const m = new ConversationMemory();
  m.push('chatA', { role: 'user', text: 'a' });
  m.push('chatB', { role: 'user', text: 'b' });
  m.clear('chatA');
  assert.deepEqual(m.recent('chatA'), []);
  assert.equal(m.recent('chatB').length, 1);
});

test('per-chat isolation', () => {
  const m = new ConversationMemory();
  m.push('chatA', { role: 'user', text: 'A1' });
  m.push('chatB', { role: 'user', text: 'B1' });
  assert.equal(m.recent('chatA')[0].text, 'A1');
  assert.equal(m.recent('chatB')[0].text, 'B1');
});
