import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { McpServer } from '../lib/mcp-server.js';
import { Inbox } from '../lib/inbox.js';

// fetch() forbids overriding the Host header (it's in the spec's forbidden
// list). For the rebinding-guard tests we drop down to node:http, which
// happily sets whatever Host the caller asks for.
function rawHttpRequest({ port, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let server;
let inbox;
let baseUrl;

before(async () => {
  inbox = new Inbox();
  // Port 0 → OS picks a free port.
  server = new McpServer({ inbox, port: 0 });
  await server.start();
  const addr = server.server.address();
  baseUrl = `http://${addr.address}:${addr.port}/`;
});

after(async () => {
  await server.stop();
});

async function rpc(body) {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('initialize returns server info and capabilities', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(r.id, 1);
  assert.equal(r.result.serverInfo.name, 'belfry');
  assert.ok(r.result.capabilities.tools);
});

test('tools/list returns the tool catalog', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['drain_inbox', 'peek_inbox']);
});

test('drain_inbox returns empty content when queue is empty', async () => {
  const r = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'drain_inbox', arguments: { slug: 'foo', queue: 'continuation' } },
  });
  assert.deepEqual(r.result.content, []);
});

test('drain_inbox returns content and clears the queue', async () => {
  inbox.push('bar', 'continuation', 'hello');
  inbox.push('bar', 'continuation', 'world');
  const r = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'drain_inbox', arguments: { slug: 'bar', queue: 'continuation' } },
  });
  assert.deepEqual(r.result.content, [{ type: 'text', text: 'hello\n\nworld' }]);
  // Second call should be empty.
  const r2 = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'drain_inbox', arguments: { slug: 'bar', queue: 'continuation' } },
  });
  assert.deepEqual(r2.result.content, []);
});

test('peek_inbox is non-destructive', async () => {
  inbox.push('baz', 'continuation', 'still here');
  const peek1 = await rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'peek_inbox', arguments: { slug: 'baz', queue: 'continuation' } },
  });
  const peek2 = await rpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'peek_inbox', arguments: { slug: 'baz', queue: 'continuation' } },
  });
  assert.deepEqual(peek1.result.content, [{ type: 'text', text: 'still here' }]);
  assert.deepEqual(peek2.result.content, [{ type: 'text', text: 'still here' }]);
});

test('unknown tool returns error', async () => {
  const r = await rpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'nope', arguments: { slug: 'x', queue: 'continuation' } },
  });
  assert.ok(r.error, 'should be error');
  assert.match(r.error.message, /unknown tool/);
});

test('missing slug or queue returns error', async () => {
  const r = await rpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'drain_inbox', arguments: { slug: 'x' } },
  });
  assert.ok(r.error);
  assert.match(r.error.message, /required/);
});

test('invalid queue value returns error', async () => {
  const r = await rpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'drain_inbox', arguments: { slug: 'x', queue: 'bogus' } },
  });
  assert.ok(r.error);
  assert.match(r.error.message, /unknown queue/);
});

test('unknown method returns error', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 11, method: 'foo/bar' });
  assert.ok(r.error);
  assert.equal(r.error.code, -32601);
});

test('invalid JSON returns parse error', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const r = await res.json();
  assert.equal(r.error.code, -32700);
});

test('GET request returns 405', async () => {
  const res = await fetch(baseUrl, { method: 'GET' });
  assert.equal(res.status, 405);
});

test('binds to loopback only', async () => {
  const addr = server.server.address();
  assert.equal(addr.address, '127.0.0.1');
});

test('rejects requests with non-loopback Host header (DNS rebinding guard)', async () => {
  const addr = server.server.address();
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Simulate a DNS-rebinding browser request: TCP goes to 127.0.0.1
      // but the Host header carries the attacker's hostname.
      'host': `attacker.com:${addr.port}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize' }),
  });
  assert.equal(res.status, 403);
});

test('accepts localhost as Host header', async () => {
  const addr = server.server.address();
  // Connect to the same socket but with Host: localhost
  const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'host': `localhost:${addr.port}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'initialize' }),
  });
  assert.equal(res.status, 200);
});

test('rejects POST without application/json content-type (CORS rebinding guard)', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'initialize' }),
  });
  assert.equal(res.status, 415);
});
