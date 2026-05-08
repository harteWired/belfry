import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, composeDigest } from '../lib/composer.js';

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

test('appends reply footer when replyFooter=true', () => {
  const text = compose({
    slug: 'life-planner',
    status: 'ready',
    statusFile: { status: 'ready', last_prompt: 'hi' },
    promptCap: 200,
    responseCap: 400,
    replyFooter: true,
  });
  assert.match(text, /↩ Reply to drive$/);
});

test('omits reply footer by default', () => {
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: { status: 'ready' },
    promptCap: 200,
    responseCap: 400,
  });
  assert.doesNotMatch(text, /Reply/);
});

test('composeDigest: includes count and summary body', () => {
  const text = composeDigest({
    slug: 'belfry',
    displayName: 'belfry',
    count: 3,
    summary: 'Shipped feature.\nOne flake, recovered.',
    replyFooter: true,
  });
  assert.match(text, /^📋 belfry — 3 events$/m);
  assert.match(text, /Shipped feature\./);
  assert.match(text, /One flake, recovered\./);
  assert.match(text, /↩ Reply to drive$/);
});

test('composeDigest: pluralization (1 event)', () => {
  const text = composeDigest({ slug: 'x', count: 1, summary: 's' });
  assert.match(text, /— 1 event$/m);
});

test('composeDigest: falls back to latestStatus when summary is null', () => {
  const text = composeDigest({
    slug: 'x',
    count: 5,
    summary: null,
    latestStatus: 'ready',
  });
  assert.match(text, /Latest: ready/);
});
