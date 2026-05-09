import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, fastPathRoute, _internals, TOOLS } from '../lib/agent.js';

const { MIN_CONFIDENCE, MAX_TOOL_TURNS } = _internals;

function fakeFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    if (typeof r === 'function') return r();
    return r;
  };
  fn.calls = calls;
  return fn;
}

function toolUseResponse(blocks) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: 'msg_x', model: 'claude-haiku-4-5', content: blocks, stop_reason: 'tool_use' }),
  };
}

function makeRespond({ intent, ...rest }) {
  return { type: 'tool_use', id: 'tu_1', name: 'respond', input: { intent, ...rest } };
}

test('TOOLS: respond is the only terminator and includes all four intents', () => {
  const respond = TOOLS.find((t) => t.name === 'respond');
  assert.ok(respond, 'respond tool must exist');
  assert.deepEqual(respond.input_schema.properties.intent.enum, ['ask', 'route', 'ambiguous', 'decline']);
});

test('classify: missing apiKey returns decline immediately, no fetch', async () => {
  const fetchImpl = fakeFetch([]);
  const out = await classify({
    text: 'hello',
    apiKey: '',
    activeSlugs: [],
    nicknames: {},
    fetchImpl,
  });
  assert.equal(out.intent, 'decline');
  assert.equal(fetchImpl.calls.length, 0);
});

test('fastPathRoute: hits when first token is an active slug', () => {
  const out = fastPathRoute({
    text: 'belfry restart please',
    activeSlugs: ['belfry'],
    resolveNickname: () => null,
  });
  assert.equal(out.intent, 'route');
  assert.equal(out.target_slug, 'belfry');
  assert.equal(out.body, 'restart please');
});

test('fastPathRoute: hits when first token is a nickname', () => {
  const out = fastPathRoute({
    text: 'ob run intake',
    activeSlugs: ['obsidian-vault'],
    resolveNickname: (t) => (t === 'ob' ? 'obsidian-vault' : null),
  });
  assert.equal(out.target_slug, 'obsidian-vault');
  assert.equal(out.body, 'run intake');
});

test('fastPathRoute: misses for unknown first token', () => {
  const out = fastPathRoute({
    text: 'mystery body',
    activeSlugs: [],
    resolveNickname: () => null,
  });
  assert.equal(out, null);
});

test('classify: fast-path bypasses the API call entirely', async () => {
  const fetchImpl = fakeFetch([]);
  const out = await classify({
    text: 'belfry just do it',
    apiKey: 'sk',
    activeSlugs: ['belfry'],
    nicknames: {},
    fetchImpl,
  });
  assert.equal(out.intent, 'route');
  assert.equal(out.target_slug, 'belfry');
  assert.equal(fetchImpl.calls.length, 0);
});

test('classify: respond tool call → returned intent', async () => {
  const fetchImpl = fakeFetch([
    toolUseResponse([
      makeRespond({ intent: 'ask', message: 'belfry has been busy' }),
    ]),
  ]);
  const out = await classify({
    text: 'how are things going?',
    apiKey: 'sk',
    activeSlugs: ['belfry'],
    nicknames: {},
    fetchImpl,
  });
  assert.equal(out.intent, 'ask');
  assert.equal(out.message, 'belfry has been busy');
  assert.equal(fetchImpl.calls.length, 1);
});

test('classify: route requires confidence ≥ MIN_CONFIDENCE; lower demotes to ambiguous', async () => {
  const fetchImpl = fakeFetch([
    toolUseResponse([
      makeRespond({ intent: 'route', target_slug: 'belfry', body: 'restart', confidence: 0.6 }),
    ]),
  ]);
  const out = await classify({
    text: 'restart',
    apiKey: 'sk',
    activeSlugs: ['belfry'],
    nicknames: {},
    fetchImpl,
  });
  assert.equal(out.intent, 'ambiguous');
  assert.deepEqual(out.candidates, ['belfry']);
});

test('classify: tool turn — model calls list_sessions, then respond', async () => {
  const fetchImpl = fakeFetch([
    toolUseResponse([
      { type: 'tool_use', id: 'tu_a', name: 'list_sessions', input: {} },
    ]),
    toolUseResponse([
      makeRespond({ intent: 'ask', message: 'one active: belfry' }),
    ]),
  ]);
  const tools = {
    list_sessions: () => [{ slug: 'belfry', last_outbound_kind: 'event' }],
    get_session: () => null,
    recent_messages: () => [],
  };
  const out = await classify({
    text: 'list active',
    apiKey: 'sk',
    activeSlugs: ['belfry'],
    nicknames: {},
    tools,
    fetchImpl,
  });
  assert.equal(out.intent, 'ask');
  // Second call should have a tool_result in the messages.
  const secondCall = fetchImpl.calls[1];
  const lastMessage = secondCall.init.body.messages.at(-1);
  assert.equal(lastMessage.role, 'user');
  assert.equal(lastMessage.content[0].type, 'tool_result');
  assert.equal(lastMessage.content[0].tool_use_id, 'tu_a');
});

test('classify: tool-loop cap returns decline', async () => {
  const responses = [];
  for (let i = 0; i < MAX_TOOL_TURNS + 2; i++) {
    responses.push(toolUseResponse([
      { type: 'tool_use', id: `tu_${i}`, name: 'list_sessions', input: {} },
    ]));
  }
  const fetchImpl = fakeFetch(responses);
  const tools = { list_sessions: () => [], get_session: () => null, recent_messages: () => [] };
  const seen = [];
  const out = await classify({
    text: 'spin forever',
    apiKey: 'sk',
    activeSlugs: [],
    nicknames: {},
    tools,
    fetchImpl,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out.intent, 'decline');
  assert.ok(seen.includes('tool_loop_cap'));
});

test('classify: 401 logs auth and returns decline', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401, json: async () => ({}) }]);
  const seen = [];
  const out = await classify({
    text: 'hi',
    apiKey: 'sk',
    activeSlugs: [],
    nicknames: {},
    fetchImpl,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out.intent, 'decline');
  assert.deepEqual(seen, ['auth']);
});

test('classify: text-only response (no tool_use) → decline + parse log', async () => {
  const fetchImpl = fakeFetch([
    {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'I refuse to use tools' }] }),
    },
  ]);
  const seen = [];
  const out = await classify({
    text: 'hi',
    apiKey: 'sk',
    activeSlugs: [],
    nicknames: {},
    fetchImpl,
    logFailure: (cat) => seen.push(cat),
  });
  assert.equal(out.intent, 'decline');
  assert.ok(seen.includes('parse'));
});

test('classify: malformed respond (route without target_slug) → decline', async () => {
  const fetchImpl = fakeFetch([
    toolUseResponse([makeRespond({ intent: 'route', confidence: 0.99 })]),
  ]);
  const out = await classify({
    text: 'hi',
    apiKey: 'sk',
    activeSlugs: ['belfry'],
    nicknames: {},
    fetchImpl,
  });
  assert.equal(out.intent, 'decline');
});

test('classify: ambiguous with candidates passes through', async () => {
  const fetchImpl = fakeFetch([
    toolUseResponse([
      makeRespond({ intent: 'ambiguous', candidates: ['belfry', 'life-planner'], hint: 'restart' }),
    ]),
  ]);
  const out = await classify({
    text: 'restart',
    apiKey: 'sk',
    activeSlugs: ['belfry', 'life-planner'],
    nicknames: {},
    fetchImpl,
  });
  assert.equal(out.intent, 'ambiguous');
  assert.deepEqual(out.candidates, ['belfry', 'life-planner']);
});

test('classify: context line includes active slugs and nicknames', () => {
  assert.equal(typeof MIN_CONFIDENCE, 'number');
  const line = _internals.buildContextLine(['a', 'b'], { x: 'a' });
  assert.match(line, /Active slugs: a, b/);
  assert.match(line, /x=a/);
});
