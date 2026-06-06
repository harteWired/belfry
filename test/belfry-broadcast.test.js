import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, splitList } from '../bin/belfry-broadcast.js';

test('splitList parses comma lists, trims, drops empties', () => {
  assert.deepEqual(splitList('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitList(' a , b ,, c '), ['a', 'b', 'c']);
  assert.equal(splitList(''), null);
  assert.equal(splitList(undefined), null);
});

test('parseArgs collects the message words', () => {
  const o = parseArgs(['wrap', 'up', 'and', 'commit']);
  assert.deepEqual(o.words, ['wrap', 'up', 'and', 'commit']);
  assert.equal(o.only, null);
  assert.equal(o.except, null);
  assert.equal(o.help, false);
});

test('parseArgs handles --only and --except (space and = forms)', () => {
  const a = parseArgs(['--only', 'api,web', 'redeploy', 'now']);
  assert.deepEqual(a.only, ['api', 'web']);
  assert.deepEqual(a.words, ['redeploy', 'now']);

  const b = parseArgs(['--except=scratch,tmp', 'wrap', 'up']);
  assert.deepEqual(b.except, ['scratch', 'tmp']);
  assert.deepEqual(b.words, ['wrap', 'up']);
});

test('parseArgs recognizes help flags', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs keeps message words even when filters are present', () => {
  const o = parseArgs(['--only', 'a', 'hello', '--except', 'b', 'world']);
  assert.deepEqual(o.only, ['a']);
  assert.deepEqual(o.except, ['b']);
  assert.deepEqual(o.words, ['hello', 'world']);
});
