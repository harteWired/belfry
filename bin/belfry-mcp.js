#!/usr/bin/env node
/**
 * belfry-mcp — per-session MCP plugin.
 *
 * One process per Claude Code session that wants to receive Telegram replies.
 * Communicates with its parent claude over stdio JSON-RPC (standard MCP) and
 * with the central belfry daemon over HTTP loopback.
 *
 * Lifecycle:
 *   1. claude spawns us; we read MCP `initialize` from stdin, respond with
 *      `claude/channel` capability declared (matches plugin:telegram).
 *   2. After client signals `notifications/initialized`, we POST /register to
 *      the daemon: { instance_id, slug, cwd, pid }. Slug is derived the same
 *      way the existing watcher does it (env CLAUDELIKE_BAR_NAME → path index
 *      → cwd basename).
 *   3. We long-poll the daemon's GET /recv?instance_id=… loop. Whenever it
 *      returns text, we emit `notifications/claude/channel` over stdio with
 *      that text as `params.content`. Claude Code injects it as user input.
 *   4. On stdin EOF (client disconnect) or signals, we POST /unregister and
 *      exit cleanly.
 *
 * Auth: the daemon writes a random token to ~/.local/state/belfry/registry.token
 * at startup (0600). We read it once and send it as `Authorization: Bearer …`
 * on every request. Without this, any local process could register and drain
 * another session's queue.
 *
 * Transport: line-delimited JSON-RPC over stdio. Hand-rolled to honor the
 * project's no-SDK rule. Spec compliance is minimal — we respond to
 * `initialize` and `tools/list`, refuse everything else, and proactively
 * push channel notifications. That's all the channel role needs.
 */

import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { deriveSlug } from '../lib/slug.js';

const DAEMON_BASE = (process.env.BELFRY_MCP_BASE || 'http://127.0.0.1:9876').replace(/\/$/, '');
const RECV_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 2_000;
const MIN_RECV_LOOP_MS = 1_000;

const cwd = process.cwd();
const slug = deriveSlug({ cwd, env: process.env });
const instanceId = randomUUID();

let registered = false;
let registerInFlight = false;
let shuttingDown = false;
let recvAbort = null;

const stateDir =
  (process.env.BELFRY_STATE_DIR ?? '').trim() ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'belfry');
const tokenPath = join(stateDir, 'registry.token');

function loadToken() {
  try {
    const t = readFileSync(tokenPath, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
const authToken = loadToken();

function authHeaders() {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

function log(msg) {
  process.stderr.write(`belfry-mcp ${slug}[${instanceId}]: ${msg}\n`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      serverInfo: { name: 'belfry', version: '0.2.0' },
      capabilities: {
        tools: {},
        experimental: {
          // `claude/channel` is an experimental capability — it must live
          // under `experimental`, not at the top level, or Claude Code
          // silently drops every `notifications/claude/channel` we emit.
          // Mirrors plugin:telegram's server.ts.
          'claude/channel': {},
        },
      },
      instructions:
        'Messages routed via belfry arrive as user input. They originate from Telegram replies the sender quoted to a belfry message. The sender reads Telegram, not this terminal — anything you want them to see must go through the reply tool. Status pings (ready/error) fire automatically via the daemon and do not need a reply call.',
    });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    // Client is ready to receive notifications. Register and start the recv loop.
    register().catch((err) => log(`register error: ${err.message}`));
    return;
  }
  if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [
        {
          name: 'reply',
          description:
            'Send a message back to the originating Telegram chat for this session. Use to reply to the human who sent the inbound Telegram message that triggered the current turn. Threads as a quote-reply to that message automatically.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'Message text to send to Telegram. ≤ 4096 chars.',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }
  if (msg.method === 'tools/call') {
    handleToolCall(msg).catch((err) => {
      log(`tools/call error: ${err.message}`);
      respondError(msg.id, -32603, `tool error: ${err.message}`);
    });
    return;
  }
  if (msg.method === 'resources/list') {
    respond(msg.id, { resources: [] });
    return;
  }
  if (msg.method === 'prompts/list') {
    respond(msg.id, { prompts: [] });
    return;
  }
  if (msg.method === 'shutdown') {
    respond(msg.id, {});
    return;
  }
  if (msg.id !== undefined) {
    respondError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleToolCall(msg) {
  const name = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  if (name !== 'reply') {
    respondError(msg.id, -32602, `unknown tool: ${name}`);
    return;
  }
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.length === 0) {
    respondError(msg.id, -32602, 'reply: text must be a non-empty string');
    return;
  }
  const res = await fetch(`${DAEMON_BASE}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ instance_id: instanceId, text }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    respondError(msg.id, -32603, `daemon /send ${res.status}: ${errBody.slice(0, 200)}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  respond(msg.id, {
    content: [
      {
        type: 'text',
        text: body?.message_id
          ? `Sent to Telegram (message ${body.message_id}).`
          : 'Sent to Telegram.',
      },
    ],
  });
}

async function register() {
  if (registered || registerInFlight) return;
  registerInFlight = true;
  try {
    const res = await fetch(`${DAEMON_BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ instance_id: instanceId, slug, cwd, pid: process.pid }),
    });
    if (!res.ok) {
      log(`register failed: HTTP ${res.status}`);
      scheduleRetry(register);
      return;
    }
    registered = true;
    log('registered with daemon');
    recvLoop().catch((err) => log(`recv loop crashed: ${err.message}`));
  } catch (err) {
    log(`register fetch error: ${err.message}`);
    scheduleRetry(register);
  } finally {
    registerInFlight = false;
  }
}

function scheduleRetry(fn) {
  if (shuttingDown) return;
  setTimeout(() => fn(), RECONNECT_BACKOFF_MS).unref();
}

async function recvLoop() {
  while (!shuttingDown) {
    const iterStart = Date.now();
    recvAbort = new AbortController();
    // Compose a per-iteration timeout with the shutdown abort. AbortSignal.any
    // fires when either signal aborts; we depend on the daemon's 25s server
    // timeout normally, but RECV_TIMEOUT_MS guards against a wedged daemon
    // that holds the connection without responding.
    const timeoutSignal = AbortSignal.timeout(RECV_TIMEOUT_MS);
    const signal = AbortSignal.any([recvAbort.signal, timeoutSignal]);
    let res;
    try {
      const url = `${DAEMON_BASE}/recv?instance_id=${encodeURIComponent(instanceId)}`;
      res = await fetch(url, { signal, headers: authHeaders() });
    } catch (err) {
      if (shuttingDown) return;
      // TimeoutError, network error, abort — all back off the same way.
      log(`recv error: ${err.message} — backing off`);
      await sleep(RECONNECT_BACKOFF_MS);
      continue;
    }
    if (res.status === 204) {
      // Long-poll timed out with nothing in queue. Loop, but ensure a floor
      // so a wedged daemon returning instant 204s can't tight-loop us.
      const elapsed = Date.now() - iterStart;
      if (elapsed < MIN_RECV_LOOP_MS) await sleep(MIN_RECV_LOOP_MS - elapsed);
      continue;
    }
    if (res.status === 401) {
      log('daemon rejected auth — token may have rotated; re-reading');
      // Best-effort: re-read the token file. If still wrong, back off.
      const fresh = loadToken();
      if (fresh && fresh !== authToken) {
        // Reassign via mutable closure isn't possible — log and exit;
        // claude will respawn us with a fresh process and re-read.
        log('token changed on disk — exiting for respawn');
      }
      await sleep(RECONNECT_BACKOFF_MS);
      continue;
    }
    if (res.status === 404) {
      // Daemon doesn't know us — re-register.
      log('daemon lost our instance — re-registering');
      registered = false;
      await sleep(RECONNECT_BACKOFF_MS);
      await register();
      return; // register() restarts the loop
    }
    if (!res.ok) {
      log(`recv HTTP ${res.status} — backing off`);
      await sleep(RECONNECT_BACKOFF_MS);
      continue;
    }
    let body;
    try {
      body = await res.json();
    } catch (err) {
      log(`recv body parse error: ${err.message} — backing off`);
      await sleep(RECONNECT_BACKOFF_MS);
      continue;
    }
    if (typeof body?.text === 'string' && body.text.length > 0) {
      log(`recv got ${body.text.length} chars — emitting channel notification`);
      injectChannelMessage(body.text);
    }
  }
}

function injectChannelMessage(text) {
  // Mirrors the params shape plugin:telegram emits. The `meta` block tells
  // Claude where this came from so it can mention "via belfry" if asked.
  send({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        source: 'belfry',
        slug,
        ts: new Date().toISOString(),
      },
    },
  });
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  while (true) {
    const nl = stdinBuf.indexOf('\n');
    if (nl < 0) break;
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log(`parse error on stdin: ${err.message}`);
      continue;
    }
    try {
      handleMessage(msg);
    } catch (err) {
      log(`handler error: ${err.stack ?? err.message}`);
    }
  }
});

process.stdin.on('end', () => shutdown('stdin-end'));
process.stdin.on('close', () => shutdown('stdin-close'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  if (recvAbort) {
    try { recvAbort.abort(); } catch {}
  }
  if (registered) {
    try {
      await fetch(`${DAEMON_BASE}/unregister`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ instance_id: instanceId }),
      });
    } catch {}
  }
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  log(`starting (cwd=${cwd}, daemon=${DAEMON_BASE}, auth=${authToken ? 'on' : 'off'})`);
}
