import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getHelpText, HELP_TOPICS } from '../lib/help-text.js';

test('HELP_TOPICS lists at least the documented set', () => {
  for (const topic of ['all', 'routing', 'nicknames', 'status', 'agent']) {
    assert.ok(HELP_TOPICS.includes(topic), `missing topic ${topic}`);
  }
});

test('getHelpText: returns a non-empty string for each documented topic', () => {
  for (const topic of HELP_TOPICS) {
    const text = getHelpText(topic);
    assert.equal(typeof text, 'string', `${topic} should return string`);
    assert.ok(text.length > 50, `${topic} text too short`);
  }
});

test('getHelpText: case-insensitive on topic', () => {
  assert.equal(getHelpText('ROUTING'), getHelpText('routing'));
  assert.equal(getHelpText('Nicknames'), getHelpText('nicknames'));
});

test('getHelpText: returns null for unknown topic', () => {
  assert.equal(getHelpText('nonexistent'), null);
  assert.equal(getHelpText(''), null);
  assert.equal(getHelpText(undefined), getHelpText('all')); // default to all
  assert.equal(getHelpText(null), null);
  assert.equal(getHelpText(42), null);
});

test('nicknames help: includes a concrete example with /nick', () => {
  const text = getHelpText('nicknames');
  assert.match(text, /\/nick/);
  assert.match(text, /\/unnick/);
  assert.match(text, /\/nicks/);
});

test('routing help: mentions all four routing paths', () => {
  const text = getHelpText('routing');
  assert.match(text, /quote-reply/i);
  assert.match(text, /prefix/i);
  assert.match(text, /nickname/i);
  // The fourth path: agent / conversation
  assert.match(text, /(agent|conversation)/i);
});

test('all topic: mentions other topics so user can drill down', () => {
  const text = getHelpText('all');
  for (const topic of ['routing', 'nicknames', 'status', 'agent']) {
    assert.match(text, new RegExp(topic), `'all' should reference '${topic}'`);
  }
});
