import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose } from '../lib/composer.js';

test('composes 3-line message with prompt + response', () => {
  const text = compose({
    slug: 'life-planner',
    status: 'ready',
    event: 'Stop',
    statusFile: {
      status: 'ready',
      statusLabel: 'Done',
      last_prompt: 'write tests for the migration script',
      last_response: 'I added tests for the migration cases…',
    },
    displayName: 'life-planner',
    promptCap: 200,
    responseCap: 400,
  });
  assert.match(text, /^🔔 life-planner — Done$/m);
  assert.match(text, /^You: write tests for the migration script$/m);
  assert.match(text, /^Claude: I added tests for the migration cases…$/m);
});

test('truncates over-long prompt + response with ellipsis', () => {
  const longPrompt = 'a'.repeat(500);
  const longResponse = 'b'.repeat(800);
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: { status: 'ready', last_prompt: longPrompt, last_response: longResponse },
    promptCap: 50,
    responseCap: 80,
  });
  assert.match(text, /You: a{49}…/);
  assert.match(text, /Claude: b{79}…/);
});

test('omits prompt + response section when both fields are absent', () => {
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: { status: 'ready' },
    promptCap: 200,
    responseCap: 400,
  });
  assert.equal(text.split('\n').length, 1);
  assert.match(text, /^🔔 x — ready$/);
});

test('uses statusLabel from claudelike-bar when present', () => {
  const text = compose({
    slug: 'x',
    status: 'working',
    statusFile: { status: 'working', statusLabel: 'Working (3 agents)' },
    promptCap: 200,
    responseCap: 400,
  });
  assert.match(text, /Working \(3 agents\)/);
});

test('error status uses 🚨 emoji', () => {
  const text = compose({
    slug: 'x',
    status: 'error',
    statusFile: { status: 'error', statusLabel: 'Error: rate limit' },
    promptCap: 200,
    responseCap: 400,
  });
  assert.match(text, /^🚨/);
});
