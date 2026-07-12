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

const DAEMON_BASE = (process.env.BELFRY_MCP_BASE || 'http://127.0.0.1:49876').replace(/\/$/, '');
const RECV_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 2_000;
const MIN_RECV_LOOP_MS = 1_000;

const cwd = process.cwd();
const slug = deriveSlug({ cwd, env: process.env });
const instanceId = randomUUID();

// Broadcast opt-out (#30): BELFRY_BROADCAST=0/off/false/no makes this session
// decline `/all` fan-outs; reported to the daemon at register. Default: accept.
const acceptsBroadcast = !['0', 'off', 'false', 'no'].includes(
  (process.env.BELFRY_BROADCAST ?? '').trim().toLowerCase(),
);

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
// `let` (not const) so 401 paths can hot-swap on token rotation. Earlier code
// exited the process and relied on Claude Code to respawn us — empirically
// the MCP host does NOT respawn stdio servers on a clean exit (verified
// 2026-05-10), so we heal in-place instead.
let authToken = loadToken();

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
        'Belfry messages arrive as user input wrapped in a <channel source="belfry" ...> tag; they originate from Telegram replies the sender quoted to a belfry message. Input typed directly into the terminal carries NO such tag. The reply tool sends text to the sender\'s phone over Telegram, and is valid ONLY on a turn whose inbound message was belfry-tagged. When the current turn came from the terminal (no <channel source="belfry"> tag), answer in the terminal and do NOT call reply — pushing terminal-origin answers to Telegram is noise. The terminal is the canonical full transcript: whenever you DO reply to Telegram, also render the full response as normal terminal text, so the terminal never carries less than what went to the phone. If the channel tag carries broadcast="true", this message was fanned out to every session at once (a /all command) — act on it, but keep any reply SHORT: the daemon aggregates all sessions\' replies into one summary, so reply only if you have a specific result worth surfacing and skip routine acknowledgements. If the channel tag carries origin="agent" from="<slug>", this message came from ANOTHER local Claude Code session, not from the human — answer it (if at all) with the send_to tool addressed to that slug, and do NOT use the reply tool (reply pushes to the human\'s phone, which a peer message must not do). Status pings (ready/error) fire automatically via the daemon and do not need a reply call.',
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
            'Send a message and/or files back to the originating Telegram chat (the human) for this session. Call this ONLY on a turn whose inbound was a belfry <channel source="belfry"> message AND was NOT tagged origin="agent" — for terminal-origin turns (no tag) answer in the terminal, and for peer-agent messages (origin="agent") answer with send_to, never reply. Always also render the full reply text as terminal output; the terminal must never carry less than what goes to Telegram. Threads as a quote-reply to the originating message automatically. Provide text, files, or both.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'Message text to send to Telegram. ≤ 4096 chars. Optional if files are given.',
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths to local files to send to Telegram. Image types (jpg/png/gif/webp) render inline as photos; everything else sends as a document. Up to 10, ≤50MB each. Optional.',
              },
            },
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: 'send_to',
          description:
            'Send a message to ANOTHER local Claude Code session by its slug (agent-to-agent, #36). Use this to coordinate with a peer session — NOT to answer the human. When a channel message arrives tagged origin="agent" from="<slug>", it came from a peer session; reply to it with send_to(slug="<slug>", …), never with the `reply` tool (reply pushes to the human\'s phone). The peer receives your text as an origin="agent" channel message. The daemon rate-limits relays to prevent loops; a 429 means you are sending too fast. The reserved slug "telegram" (or "<letter>/telegram" for another host\'s bridge) posts the message to the HUMAN\'s Telegram, headered with your slug — the deliberate agent-to-human push path. Use it only for messages the human asked to receive proactively; for answering a human\'s belfry-tagged message, the `reply` tool is still the right call.',
          inputSchema: {
            type: 'object',
            properties: {
              slug: {
                type: 'string',
                description: 'Slug of the destination session (e.g. "api", "travel-planner").',
              },
              text: {
                type: 'string',
                description: 'Message text to deliver to that session.',
              },
            },
            required: ['slug', 'text'],
            additionalProperties: false,
          },
        },
        {
          name: 'send_many',
          description:
            'Fan ONE message out to SEVERAL peer sessions in a single call (batch send_to, #50). Use this instead of N send_to calls whenever you are telling multiple sessions the same thing — the daemon owns the fan-out, it costs one rate-limit token instead of one per recipient, and you get a per-recipient result (delivered / no live session / failed) in one response. Recipients may be bare slugs or "<letter>/<slug>" cross-host targets, up to 32. Per-recipient messages that differ in content still need individual send_to calls. Not for answering the human.',
          inputSchema: {
            type: 'object',
            properties: {
              slugs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Destination session slugs (e.g. ["api", "e/nuc", "s/vault"]). 1-32 entries.',
              },
              text: {
                type: 'string',
                description: 'Message text delivered identically to every recipient.',
              },
            },
            required: ['slugs', 'text'],
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
  if (name === 'send_to') {
    await handleSendToTool(msg, args);
    return;
  }
  if (name === 'send_many') {
    await handleSendManyTool(msg, args);
    return;
  }
  if (name !== 'reply') {
    respondError(msg.id, -32602, `unknown tool: ${name}`);
    return;
  }
  const text = typeof args.text === 'string' ? args.text : '';
  const files = Array.isArray(args.files) ? args.files.filter((f) => typeof f === 'string' && f) : [];
  if (text.length === 0 && files.length === 0) {
    respondError(msg.id, -32602, 'reply: provide text and/or files (both empty)');
    return;
  }
  // Provenance (#33/#36) is enforced behaviourally, not structurally: the MCP
  // instructions + tool descriptions tell the model not to call `reply` on a
  // terminal-origin or agent-origin (origin="agent") turn. There is no
  // server-side gate here because the tool handler is stateless (it doesn't
  // know the current turn's inbound origin) — deliberate, matching #33's
  // posture and the single-user/trusted-local-model charter. Structural
  // enforcement would require per-session last-origin tracking.
  // No local truncation: the daemon's /send pipeline packs / chunks
  // oversized text so the full reply makes it through. The user can ask
  // for the original verbatim via the "full" command. Daemon enforces an
  // absolute upper bound (lib/registry.js: MAX_SEND_TEXT_LEN); anything
  // larger surfaces as a 413 here.
  const res = await fetch(`${DAEMON_BASE}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ instance_id: instanceId, text, files: files.length ? files : undefined }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    respondError(msg.id, -32603, `daemon /send ${res.status}: ${errBody.slice(0, 200)}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  // Echo what was sent so the model can verify and the terminal has a
  // verbatim record even when Telegram-side rendering attenuates the
  // visible body (packed / chunked).
  const fileNote = files.length ? ` + ${files.length} file(s)` : '';
  const summary = body?.message_id
    ? `Sent to Telegram (message ${body.message_id}, ${text.length} chars${fileNote}).`
    : `Sent to Telegram (${text.length} chars${fileNote}).`;
  respond(msg.id, {
    content: [
      {
        type: 'text',
        text: `${summary}${text ? `\n\nSent text:\n${text}` : ''}`,
      },
    ],
  });
}

// send_to (#36): relay a message to another local session by slug via the
// daemon's /send-to route. The daemon resolves OUR slug from instance_id (so we
// can't spoof a sender), applies the flood/loop guard, and injects the text into
// the destination session as an origin="agent" channel message.
async function handleSendToTool(msg, args) {
  const toSlug = typeof args.slug === 'string' ? args.slug.trim() : '';
  const text = typeof args.text === 'string' ? args.text : '';
  if (toSlug.length === 0) {
    respondError(msg.id, -32602, 'send_to: slug must be a non-empty string');
    return;
  }
  if (text.length === 0) {
    respondError(msg.id, -32602, 'send_to: text must be a non-empty string');
    return;
  }
  const res = await fetch(`${DAEMON_BASE}/send-to`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ instance_id: instanceId, to_slug: toSlug, text }),
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    respondError(msg.id, -32603, `send_to rate-limited (${body?.reason ?? 'rate'}) — slow down peer messaging to "${toSlug}"`);
    return;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    respondError(msg.id, -32603, `daemon /send-to ${res.status}: ${errBody.slice(0, 200)}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  const delivered = body?.delivered ?? 0;
  const summary = delivered > 0
    ? `Relayed to "${toSlug}" (${delivered} live session(s)).`
    : `"${toSlug}" has no live session right now — nothing delivered.`;
  respond(msg.id, {
    content: [{ type: 'text', text: `${summary}\n\nSent text:\n${text}` }],
  });
}

// send_many (#50): batch fan-out of one text to many peers via the daemon's
// /send-many route — one guard token for the whole batch, per-recipient results.
async function handleSendManyTool(msg, args) {
  const slugs = Array.isArray(args.slugs) ? args.slugs.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
  const text = typeof args.text === 'string' ? args.text : '';
  if (slugs.length === 0) {
    respondError(msg.id, -32602, 'send_many: slugs must be a non-empty array of slug strings');
    return;
  }
  if (text.length === 0) {
    respondError(msg.id, -32602, 'send_many: text must be a non-empty string');
    return;
  }
  const res = await fetch(`${DAEMON_BASE}/send-many`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ instance_id: instanceId, to_slugs: slugs, text }),
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    respondError(msg.id, -32603, `send_many rate-limited (${body?.reason ?? 'rate'}) — slow down peer messaging`);
    return;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    respondError(msg.id, -32603, `daemon /send-many ${res.status}: ${errBody.slice(0, 200)}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  const results = Array.isArray(body?.results) ? body.results : [];
  const lines = results.map((r) => {
    if (r.delivered > 0) return `  ✓ ${r.to} — delivered (${r.delivered} session(s)${r.remote ? `, via host ${r.host}` : ''})`;
    if (r.ok) return `  ✗ ${r.to} — no live session, nothing delivered`;
    return `  ✗ ${r.to} — failed (${r.reason ?? 'unknown'})`;
  });
  const reached = results.filter((r) => r.delivered > 0).length;
  respond(msg.id, {
    content: [{
      type: 'text',
      text: `Fanned out to ${reached}/${results.length} recipient(s):\n${lines.join('\n')}\n\nSent text:\n${text}`,
    }],
  });
}

async function register() {
  if (registered || registerInFlight) return;
  registerInFlight = true;
  try {
    const res = await fetch(`${DAEMON_BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ instance_id: instanceId, slug, cwd, pid: process.pid, accepts_broadcast: acceptsBroadcast }),
    });
    if (res.status === 401) {
      // Common case: the MCP started before the daemon, loadToken() returned
      // null at module init, and now the daemon is up with auth enabled — our
      // header-less /register is being refused. Re-read the token file; if it
      // has appeared (or rotated), hot-swap the cached value and retry.
      const fresh = loadToken();
      if (fresh && fresh !== authToken) {
        authToken = fresh;
        log('register: token reloaded from disk — retrying');
        scheduleRetry(register);
        return;
      }
      log('register failed: HTTP 401');
      scheduleRetry(register);
      return;
    }
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
      // Token may have rotated on the daemon side. Re-read the file; if it
      // differs from our cached value, hot-swap and retry. We can't rely on
      // a clean process exit triggering a respawn — empirically the MCP host
      // does not restart stdio servers on exit (verified 2026-05-10).
      const fresh = loadToken();
      if (fresh && fresh !== authToken) {
        authToken = fresh;
        log('daemon rejected auth — token reloaded from disk');
      } else {
        log('daemon rejected auth — token unchanged, backing off');
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
    // A caption-less photo/voice arrives as EMPTY text + an attachment path.
    // Inject it with a minimal placeholder — the harness may silently drop an
    // empty-text channel notification (#37), and this guard used to discard
    // the item entirely, which is where inbound photos died last (2026-07-10).
    const hasAttachment = typeof body?.image_path === 'string' || typeof body?.voice_path === 'string';
    if (typeof body?.text === 'string' && (body.text.length > 0 || hasAttachment)) {
      const textOut = body.text.length > 0 ? body.text
        : (typeof body.image_path === 'string' ? '[photo attached]' : '[voice note attached]');
      injectChannelMessage(textOut, {
        imagePath: typeof body.image_path === 'string' ? body.image_path : undefined,
        voicePath: typeof body.voice_path === 'string' ? body.voice_path : undefined,
        broadcast: body.broadcast === true,
        origin: typeof body.origin === 'string' ? body.origin : undefined,
        from: typeof body.from === 'string' ? body.from : undefined,
      });
    }
  }
}

function injectChannelMessage(text, attachment = {}) {
  // Channel-notification params. The harness wraps the content in a
  // <channel ...> tag that gets the meta keys flattened to attributes —
  // anything in `meta` shows up next to the harness-supplied `source=`,
  // so don't duplicate `source` here. Slug + ts give the model enough
  // routing context without bloating the framing.
  //
  // image_path / voice_path on params let the receiving harness surface the
  // attachment to Claude as if the user had attached it at the prompt.
  // Mirrors the bundled plugin:telegram shape.
  const params = {
    content: text,
    meta: { slug, ts: new Date().toISOString() },
  };
  if (attachment.imagePath) params.image_path = attachment.imagePath;
  if (attachment.voicePath) params.voice_path = attachment.voicePath;
  // broadcast=true surfaces as a `broadcast="true"` attribute on the <channel>
  // tag (the harness flattens meta keys to attributes), so the model can tell a
  // /all fan-out from a directed message and keep its reply succinct.
  // MUST be the STRING 'true', not a boolean: the channel notification's `meta`
  // is typed `Record<string, string>`, and a non-string value fails the MCP
  // params schema, which drops the ENTIRE notification silently — so a broadcast
  // never reached the model. This was the long-standing "/all doesn't work" bug
  // (broken since #30); directed messages worked because their meta (slug, ts)
  // is all strings.
  if (attachment.broadcast) params.meta.broadcast = 'true';
  // Agent-to-agent provenance (#36): surfaces as origin="agent" from="<slug>" on
  // the channel tag so the model answers a peer via send_to(from), not `reply`.
  if (attachment.origin) params.meta.origin = attachment.origin;
  if (attachment.from) params.meta.from = attachment.from;
  send({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params,
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
