import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkParagraphAware } from '../lib/chunk.js';

test('returns single chunk when text fits', () => {
  assert.deepEqual(chunkParagraphAware('hello', 100), ['hello']);
});

test('empty input → empty array', () => {
  assert.deepEqual(chunkParagraphAware('', 100), []);
});

test('splits on paragraph boundary when available', () => {
  const text = 'one two three\n\nfour five six\n\nseven eight nine';
  const out = chunkParagraphAware(text, 20);
  // Cut should land at \n\n, not mid-word.
  for (const c of out) {
    assert.ok(c.length <= 20, `chunk too long: ${c.length}`);
  }
  // Joined back (with newlines) reconstructs the substantive content.
  const joined = out.join(' ').replace(/\s+/g, ' ');
  const expected = text.replace(/\s+/g, ' ');
  assert.equal(joined, expected);
});

test('falls back to line break then space then hard cut', () => {
  // No paragraph breaks, but line breaks exist.
  const text = 'aaaaa\nbbbbb\nccccc\nddddd';
  const out = chunkParagraphAware(text, 12);
  for (const c of out) {
    assert.ok(c.length <= 12);
  }
  assert.ok(out.length > 1);
});

test('hard cut when no whitespace at all', () => {
  const text = 'x'.repeat(50);
  const out = chunkParagraphAware(text, 10);
  assert.equal(out.length, 5);
  for (const c of out) {
    assert.equal(c.length, 10);
  }
});

test('rejects bad inputs', () => {
  assert.throws(() => chunkParagraphAware(null, 10));
  assert.throws(() => chunkParagraphAware('x', 0));
  assert.throws(() => chunkParagraphAware('x', -1));
  assert.throws(() => chunkParagraphAware('x', 1.5));
});
