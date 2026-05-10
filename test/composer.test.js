import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, composeDigest, escapeHtml } from '../lib/composer.js';

test('composes HTML message with header, response body, and collapsed prompt', () => {
  const text = compose({
    slug: 'life-planner',
    status: 'ready',
    event: 'Stop',
    statusFile: {
      status: 'ready',
      statusLabel: 'Done',
      last_prompt: 'write tests for the migration script',
      last_response: 'I added tests for the migration cases.',
    },
    displayName: 'life-planner',
    promptCap: 1500,
    responseCap: 2500,
  });
  // Italic header for visual de-emphasis.
  assert.match(text, /^<i>🔔 life-planner — Done<\/i>$/m);
  // Response is plain (escaped) body text.
  assert.match(text, /^I added tests for the migration cases\.$/m);
  // Prompt is collapsed inside an expandable blockquote when response is present.
  assert.match(text, /<blockquote expandable>You: write tests for the migration script<\/blockquote>/);
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
  assert.match(text, /b{79}…/);
});

test('omits prompt + response section when both fields are absent', () => {
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: { status: 'ready' },
    promptCap: 1500,
    responseCap: 2500,
  });
  assert.equal(text, '<i>🔔 x — ready</i>');
});

test('renders prompt inline (non-expandable) when response is absent', () => {
  const text = compose({
    slug: 'x',
    status: 'waiting',
    statusFile: { status: 'waiting', last_prompt: 'install the migration script' },
    promptCap: 1500,
    responseCap: 2500,
  });
  // No `expandable` — prompt is the primary content here, don't hide it.
  assert.match(text, /<blockquote>You: install the migration script<\/blockquote>/);
  assert.doesNotMatch(text, /expandable/);
});

test('uses statusLabel from claudelike-bar when present', () => {
  const text = compose({
    slug: 'x',
    status: 'working',
    statusFile: { status: 'working', statusLabel: 'Working (3 agents)' },
    promptCap: 1500,
    responseCap: 2500,
  });
  assert.match(text, /Working \(3 agents\)/);
});

test('error status uses 🚨 emoji', () => {
  const text = compose({
    slug: 'x',
    status: 'error',
    statusFile: { status: 'error', statusLabel: 'Error: rate limit' },
    promptCap: 1500,
    responseCap: 2500,
  });
  assert.match(text, /<i>🚨/);
});

test('appends reply footer when replyFooter=true', () => {
  const text = compose({
    slug: 'life-planner',
    status: 'ready',
    statusFile: { status: 'ready', last_prompt: 'hi' },
    promptCap: 1500,
    responseCap: 2500,
    replyFooter: true,
  });
  assert.match(text, /<i>↩ Reply to drive<\/i>$/);
});

test('omits reply footer by default', () => {
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: { status: 'ready' },
    promptCap: 1500,
    responseCap: 2500,
  });
  assert.doesNotMatch(text, /Reply/);
});

test('escapes HTML special characters in prompt, response, and labels', () => {
  // Without escaping, a `<` in the user's prompt would be parsed by Telegram
  // as an opening tag — at best malformed HTML, at worst stripped silently.
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: {
      status: 'ready',
      statusLabel: 'A & B',
      last_prompt: 'find <Component> in src/',
      last_response: '5 < 10 && true',
    },
    promptCap: 1500,
    responseCap: 2500,
  });
  assert.match(text, /A &amp; B/);
  assert.match(text, /find &lt;Component&gt; in src\//);
  assert.match(text, /5 &lt; 10 &amp;&amp; true/);
  // Original raw `<` / `&` must NOT appear in user content sections.
  assert.doesNotMatch(text, /find <Component>/);
});

test('clamps to Telegram cap and appends truncation suffix', () => {
  // Composed length > 4096 → response gets a visible truncation marker.
  const text = compose({
    slug: 'x',
    status: 'ready',
    statusFile: { status: 'ready', last_response: 'r'.repeat(5000) },
    promptCap: 1500,
    responseCap: 6000, // larger than Telegram's cap on purpose
  });
  assert.ok(text.length <= 4096, `composed length ${text.length} exceeds Telegram cap`);
  assert.match(text, /truncated; full text in terminal/);
});

test('escapeHtml: maps & < > correctly', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('composeDigest: includes count and summary body', () => {
  const text = composeDigest({
    slug: 'belfry',
    displayName: 'belfry',
    count: 3,
    summary: 'Shipped feature.\nOne flake, recovered.',
    replyFooter: true,
  });
  assert.match(text, /<i>📋 belfry — 3 events<\/i>/);
  assert.match(text, /Shipped feature\./);
  assert.match(text, /One flake, recovered\./);
  assert.match(text, /<i>↩ Reply to drive<\/i>$/);
});

test('composeDigest: pluralization (1 event)', () => {
  const text = composeDigest({ slug: 'x', count: 1, summary: 's' });
  assert.match(text, /— 1 event<\/i>/m);
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

test('composeDigest: escapes summary HTML', () => {
  const text = composeDigest({
    slug: 'x',
    count: 2,
    summary: 'fixed bug in <Header> & <Footer>',
  });
  assert.match(text, /fixed bug in &lt;Header&gt; &amp; &lt;Footer&gt;/);
});
