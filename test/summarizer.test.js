import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarize, summarizeBatch, _internals } from '../lib/summarizer.js';

const { makeCache, parseModelOutput, hashKey, buildDigestUserMessage } = _internals;

function fakeFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    if (typeof r === 'function') return r();
    return r;
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ content: [{ type: 'text', text }] }),
  };
}

test('summarize: parses USER/CLAUDE response and caches by content hash', async () => {
  const cache = makeCache();
  const fetchImpl = fakeFetch([
    jsonResponse('USER: build the dashboard\nCLAUDE: scaffolded the components'),
  ]);
  const out = await summarize({
    prompt: 'please build the dashboard',
    response: 'I scaffolded the components and added tests',
    apiKey: 'sk-test',
    cache,
    fetchImpl,
  });
  assert.deepEqual(out, {
    prompt: 'build the dashboard',
    response: 'scaffolded the components',
  });

  const out2 = await summarize({
    prompt: 'please build the dashboard',
    response: 'I scaffolded the components and added tests',
    apiKey: 'sk-test',
    cache,
    fetchImpl,
  });
  assert.deepEqual(out2, out);
  assert.equal(fetchImpl.calls.length, 1, 'second call must hit cache');
});

test('summarize: returns null when API key missing', async () => {
  const fetchImpl = fakeFetch([]);
  const out = await summarize({
    prompt: 'x',
    response: 'y',
    apiKey: '',
    fetchImpl,
  });
  assert.equal(out, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('summarize: returns null when both prompt and response are empty', async () => {
  const fetchImpl = fakeFetch([]);
  const out = await summarize({
    prompt: '',
    response: null,
    apiKey: 'sk-test',
    fetchImpl,
  });
  assert.equal(out, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('summarize: returns null on non-2xx HTTP', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 500, json: async () => ({}) }]);
  const out = await summarize({
    prompt: 'x',
    response: 'y',
    apiKey: 'sk-test',
    cache: makeCache(),
    fetchImpl,
  });
  assert.equal(out, null);
});

test('summarize: returns null on fetch throw (timeout/abort)', async () => {
  const fetchImpl = fakeFetch([
    () => { throw new Error('aborted'); },
  ]);
  const out = await summarize({
    prompt: 'x',
    response: 'y',
    apiKey: 'sk-test',
    cache: makeCache(),
    fetchImpl,
  });
  assert.equal(out, null);
});

test('summarize: returns null when both summary lines are empty/dash', async () => {
  const fetchImpl = fakeFetch([jsonResponse('USER: -\nCLAUDE: -')]);
  const out = await summarize({
    prompt: 'x',
    response: 'y',
    apiKey: 'sk-test',
    cache: makeCache(),
    fetchImpl,
  });
  assert.equal(out, null);
});

test('summarize: sends correct headers and request body', async () => {
  const fetchImpl = fakeFetch([jsonResponse('USER: a\nCLAUDE: b')]);
  await summarize({
    prompt: 'p',
    response: 'r',
    apiKey: 'sk-secret',
    model: 'claude-haiku-4-5-20251001',
    cache: makeCache(),
    fetchImpl,
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], 'sk-secret');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.init.headers['content-type'], 'application/json');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
  assert.equal(typeof body.system, 'string');
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /User said:[\s\S]*p[\s\S]*Claude said:[\s\S]*r/);
});

test('parseModelOutput: handles single-side summaries', () => {
  assert.deepEqual(
    parseModelOutput('USER: only the prompt\nCLAUDE: -'),
    { prompt: 'only the prompt', response: null },
  );
  assert.deepEqual(
    parseModelOutput('CLAUDE: only the response'),
    { prompt: null, response: 'only the response' },
  );
});

test('parseModelOutput: ignores junk lines and is case-insensitive on labels', () => {
  assert.deepEqual(
    parseModelOutput('preamble that should not appear\nuser: lower-case label\nclaude:  spaced\ntrailing junk'),
    { prompt: 'lower-case label', response: 'spaced' },
  );
});

test('hashKey: differs per (prompt, response, model)', () => {
  const a = hashKey('p', 'r', 'm1');
  const b = hashKey('p', 'r', 'm2');
  const c = hashKey('p', 'r2', 'm1');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, hashKey('p', 'r', 'm1'));
});

test('makeCache: bounded LRU evicts oldest', () => {
  const cache = makeCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // should evict 'a'
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('makeCache: get bumps key to most-recent', () => {
  const cache = makeCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // bump a, so b is now oldest
  cache.set('c', 3); // should evict b
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
});

test('summarizeBatch: returns digest text on success', async () => {
  const fetchImpl = fakeFetch([jsonResponse('Shipped 2 features.\nOne error, recovered.')]);
  const out = await summarizeBatch({
    events: [
      { status: 'ready', prompt: 'add feature A', response: 'done' },
      { status: 'error', prompt: 'add feature B', response: 'failed' },
      { status: 'ready', prompt: 'retry', response: 'done' },
    ],
    apiKey: 'sk-test',
    fetchImpl,
  });
  assert.equal(out, 'Shipped 2 features.\nOne error, recovered.');
});

test('summarizeBatch: returns null on missing api key or empty events', async () => {
  assert.equal(await summarizeBatch({ events: [{}], apiKey: '' }), null);
  assert.equal(await summarizeBatch({ events: [], apiKey: 'sk' }), null);
  assert.equal(await summarizeBatch({ events: null, apiKey: 'sk' }), null);
});

test('summarizeBatch: returns null on non-2xx', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 429, json: async () => ({}) }]);
  const out = await summarizeBatch({
    events: [{ status: 'ready', prompt: 'p', response: 'r' }],
    apiKey: 'sk',
    fetchImpl,
  });
  assert.equal(out, null);
});

test('summarizeBatch: returns null on empty model text', async () => {
  const fetchImpl = fakeFetch([jsonResponse('   \n  ')]);
  const out = await summarizeBatch({
    events: [{ status: 'ready', prompt: 'p', response: 'r' }],
    apiKey: 'sk',
    fetchImpl,
  });
  assert.equal(out, null);
});

test('summarize: logFailure called with auth/rate_limit/upstream/parse/timeout categories', async () => {
  const cases = [
    { res: { ok: false, status: 401, json: async () => ({}) }, cat: 'auth' },
    { res: { ok: false, status: 403, json: async () => ({}) }, cat: 'auth' },
    { res: { ok: false, status: 429, json: async () => ({}) }, cat: 'rate_limit' },
    { res: { ok: false, status: 503, json: async () => ({}) }, cat: 'upstream' },
    { res: { ok: false, status: 400, json: async () => ({}) }, cat: 'client_error' },
    { res: jsonResponse('not USER/CLAUDE format'), cat: 'parse' },
  ];
  for (const { res, cat } of cases) {
    const seen = [];
    await summarize({
      prompt: `prompt-${cat}`,
      response: `response-${cat}`,
      apiKey: 'sk',
      cache: makeCache(),
      fetchImpl: fakeFetch([res]),
      logFailure: (category) => seen.push(category),
    });
    assert.deepEqual(seen, [cat], `expected ${cat}`);
  }
});

test('summarize: logFailure timeout category on AbortError throw', async () => {
  const seen = [];
  await summarize({
    prompt: 'p',
    response: 'r',
    apiKey: 'sk',
    cache: makeCache(),
    fetchImpl: fakeFetch([
      () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    ]),
    logFailure: (category) => seen.push(category),
  });
  assert.deepEqual(seen, ['timeout']);
});

test('summarize: logFailure network category on plain throw', async () => {
  const seen = [];
  await summarize({
    prompt: 'p',
    response: 'r',
    apiKey: 'sk',
    cache: makeCache(),
    fetchImpl: fakeFetch([() => { throw new Error('ECONNRESET'); }]),
    logFailure: (category) => seen.push(category),
  });
  assert.deepEqual(seen, ['network']);
});

test('summarize: logFailure not called on success or missing-key paths', async () => {
  const seen = [];
  await summarize({
    prompt: 'p',
    response: 'r',
    apiKey: '',
    fetchImpl: fakeFetch([]),
    logFailure: (c) => seen.push(c),
  });
  assert.deepEqual(seen, []);
  await summarize({
    prompt: 'p',
    response: 'r',
    apiKey: 'sk',
    cache: makeCache(),
    fetchImpl: fakeFetch([jsonResponse('USER: a\nCLAUDE: b')]),
    logFailure: (c) => seen.push(c),
  });
  assert.deepEqual(seen, []);
});

test('summarizeBatch: logFailure called on non-2xx and parse failures', async () => {
  const seen = [];
  await summarizeBatch({
    events: [{ status: 'ready', prompt: 'a', response: 'b' }],
    apiKey: 'sk',
    fetchImpl: fakeFetch([{ ok: false, status: 401, json: async () => ({}) }]),
    logFailure: (c) => seen.push(c),
  });
  await summarizeBatch({
    events: [{ status: 'ready', prompt: 'a', response: 'b' }],
    apiKey: 'sk',
    fetchImpl: fakeFetch([jsonResponse('   \n  ')]),
    logFailure: (c) => seen.push(c),
  });
  assert.deepEqual(seen, ['auth', 'parse']);
});

test('buildDigestUserMessage: formats events with status, prompt, response', () => {
  const text = buildDigestUserMessage([
    { status: 'ready', statusLabel: 'Done', prompt: 'a', response: 'b' },
    { status: 'error', prompt: 'c' },
  ]);
  assert.match(text, /2 event\(s\)/);
  assert.match(text, /#1 \[ready\] \(Done\)/);
  assert.match(text, /user: a/);
  assert.match(text, /claude: b/);
  assert.match(text, /#2 \[error\]/);
  assert.match(text, /user: c/);
});
