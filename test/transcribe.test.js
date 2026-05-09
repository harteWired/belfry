import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transcribe } from '../lib/transcribe.js';

const fakeFs = {
  readFileSync: () => Buffer.from('fake audio bytes'),
};

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  fn.calls = calls;
  return fn;
}

test('transcribe: returns trimmed text on success', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => '  hello there  ',
  }));
  const out = await transcribe({
    apiKey: 'gsk-test',
    audioPath: '/tmp/voice.ogg',
    fetchImpl,
    fs: fakeFs,
  });
  assert.equal(out, 'hello there');
  // FormData payload — verify Authorization header sent.
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer gsk-test');
});

test('transcribe: returns null with no apiKey, no fetch', async () => {
  const fetchImpl = fakeFetch(async () => { throw new Error('should not be called'); });
  const out = await transcribe({ apiKey: '', audioPath: '/tmp/x', fetchImpl, fs: fakeFs });
  assert.equal(out, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('transcribe: returns null on read failure', async () => {
  const fs = { readFileSync: () => { throw new Error('ENOENT'); } };
  const fetchImpl = fakeFetch(async () => ({ ok: true, text: async () => 'x' }));
  const seen = [];
  const out = await transcribe({
    apiKey: 'gsk', audioPath: '/missing', fetchImpl, fs,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out, null);
  assert.deepEqual(seen, ['read']);
});

test('transcribe: categorizes 401 as auth', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: false, status: 401, text: async () => '' }));
  const seen = [];
  const out = await transcribe({
    apiKey: 'gsk', audioPath: '/tmp/x', fetchImpl, fs: fakeFs,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out, null);
  assert.deepEqual(seen, ['auth']);
});

test('transcribe: empty body counted as parse failure', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, text: async () => '   \n' }));
  const seen = [];
  const out = await transcribe({
    apiKey: 'gsk', audioPath: '/tmp/x', fetchImpl, fs: fakeFs,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out, null);
  assert.deepEqual(seen, ['parse']);
});

test('transcribe: network throw → network category', async () => {
  const fetchImpl = fakeFetch(async () => { throw new Error('ECONNRESET'); });
  const seen = [];
  const out = await transcribe({
    apiKey: 'gsk', audioPath: '/tmp/x', fetchImpl, fs: fakeFs,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out, null);
  assert.deepEqual(seen, ['network']);
});
