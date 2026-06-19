import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, resolveTarget } from '../lib/federation-address.js';

test('parseTarget distinguishes qualified from bare', () => {
  assert.deepEqual(parseTarget('e/api'), { qualified: true, hostLetter: 'e', slug: 'api' });
  assert.deepEqual(parseTarget('api'), { qualified: false, slug: 'api' });
  // A slug containing slashes after the host prefix is preserved.
  assert.deepEqual(parseTarget('d/a/b'), { qualified: true, hostLetter: 'd', slug: 'a/b' });
});

const owners = new Map([
  ['api', new Set(['d'])],
  ['build', new Set(['d', 'e'])], // collision across two hosts
]);

test('resolves a bare globally-unique slug', () => {
  assert.deepEqual(resolveTarget('api', { selfLetter: 'd', owners }), {
    kind: 'resolved', hostLetter: 'd', slug: 'api', local: true,
  });
});

test('resolves a bare slug owned by a remote host', () => {
  assert.deepEqual(resolveTarget('api', { selfLetter: 'e', owners }), {
    kind: 'resolved', hostLetter: 'd', slug: 'api', local: false,
  });
});

test('a bare slug owned by >1 host is ambiguous with sorted candidates', () => {
  const r = resolveTarget('build', { selfLetter: 'd', owners });
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.candidates, ['d/build', 'e/build']);
});

test('a bare slug with no known owner is unknown', () => {
  assert.deepEqual(resolveTarget('ghost', { selfLetter: 'd', owners }), { kind: 'unknown', slug: 'ghost' });
});

test('a host-qualified target always resolves, even if not yet in the gossip view', () => {
  assert.deepEqual(resolveTarget('n/foo', { selfLetter: 'd', owners }), {
    kind: 'resolved', hostLetter: 'n', slug: 'foo', local: false,
  });
});

test('a host-qualified target to our own letter is local', () => {
  assert.deepEqual(resolveTarget('d/whatever', { selfLetter: 'd', owners }), {
    kind: 'resolved', hostLetter: 'd', slug: 'whatever', local: true,
  });
});

test('an empty target is invalid', () => {
  assert.equal(resolveTarget('', { selfLetter: 'd', owners }).kind, 'invalid');
  assert.equal(resolveTarget('   ', { selfLetter: 'd', owners }).kind, 'invalid');
});
