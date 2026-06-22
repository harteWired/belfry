#!/usr/bin/env node
/**
 * belfry-broker — ONE shared process serving every Claude session's MCP
 * channel role, replacing N per-session belfry-mcp.js Node runtimes (~75MB
 * each) with 1 broker + N thin python relays (~8MB each).
 *
 * Why this exists: belfry's inbound path needs Claude Code's `claude/channel`
 * mechanism (push a Telegram reply into a session as user input), which is
 * stdio-only — so each session needs *a* stdio MCP server. But that server can
 * be a transparent relay (bin/belfry-relay.py) piping to this broker, which
 * holds all the real logic ONCE. This is the "one mcp" shape (like the shared
 * google-workspace HTTP server) adapted to the stdio-channel constraint.
 *
 * Transport: a unix-domain socket. Each relay connection = one Claude session.
 * The relay sends ONE handshake line ({slug_hint,cwd,env,broadcast}) so the
 * broker can derive the authoritative slug via lib/slug.js, then pipes the
 * session's line-delimited JSON-RPC. Everything after the handshake is exactly
 * the protocol belfry-mcp.js spoke over process stdio — just per-connection.
 *
 * Each connection independently /registers with the daemon (own instance_id),
 * long-polls /recv, emits notifications/claude/channel down ITS socket, and
 * handles the reply/send_to tools. On socket close we /unregister and clean up.
 * The auth token is shared (it's the daemon's single registry token).
 */
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deriveSlug } from '../lib/slug.js';

const DAEMON_BASE = (process.env.BELFRY_MCP_BASE || 'http://127.0.0.1:49876').replace(/\/$/, '');
const RECV_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 2_000;
const MIN_RECV_LOOP_MS = 1_000;

const stateDir =
  (process.env.BELFRY_STATE_DIR ?? '').trim() ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'belfry');
const SOCK_PATH = process.env.BELFRY_BROKER_SOCK || join(stateDir, 'broker.sock');
const tokenPath = join(stateDir, 'registry.token');

// Shared auth token (the daemon's single registry token). `let` so a 401 can
// hot-swap on rotation, exactly as the per-session spoke did.
function loadToken() {
  try {
    const t = readFileSync(tokenPath, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
let authToken = loadToken();
function authHeaders() {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

function brokerLog(msg) {
  process.stderr.write(`belfry-broker: ${msg}\n`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const TOOLS = [
  {
    name: 'reply',
    description:
      'Send a message and/or files back to the originating Telegram chat (the human) for this session. Call this ONLY on a turn whose inbound was a belfry <channel source="belfry"> message AND was NOT tagged origin="agent" — for terminal-origin turns (no tag) answer in the terminal, and for peer-agent messages (origin="agent") answer with send_to, never reply. Always also render the full reply text as terminal output; the terminal must never carry less than what goes to Telegram. Threads as a quote-reply to the originating message automatically. Provide text, files, or both.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send to Telegram. ≤ 4096 chars. Optional if files are given.' },
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
      'Send a message to ANOTHER local Claude Code session by its slug (agent-to-agent, #36). Use this to coordinate with a peer session — NOT to answer the human. When a channel message arrives tagged origin="agent" from="<slug>", it came from a peer session; reply to it with send_to(slug="<slug>", …), never with the `reply` tool (reply pushes to the human\'s phone). The peer receives your text as an origin="agent" channel message. The daemon rate-limits relays to prevent loops; a 429 means you are sending too fast.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug of the destination session (e.g. "api", "travel-planner").' },
        text: { type: 'string', description: 'Message text to deliver to that session.' },
      },
      required: ['slug', 'text'],
      additionalProperties: false,
    },
  },
];

const INSTRUCTIONS =
  'Belfry messages arrive as user input wrapped in a <channel source="belfry" ...> tag; they originate from Telegram replies the sender quoted to a belfry message. Input typed directly into the terminal carries NO such tag. The reply tool sends text to the sender\'s phone over Telegram, and is valid ONLY on a turn whose inbound message was belfry-tagged. When the current turn came from the terminal (no <channel source="belfry"> tag), answer in the terminal and do NOT call reply — pushing terminal-origin answers to Telegram is noise. The terminal is the canonical full transcript: whenever you DO reply to Telegram, also render the full response as normal terminal text, so the terminal never carries less than what went to the phone. If the channel tag carries broadcast="true", this message was fanned out to every session at once (a /all command) — act on it, but keep any reply SHORT: the daemon aggregates all sessions\' replies into one summary, so reply only if you have a specific result worth surfacing and skip routine acknowledgements. If the channel tag carries origin="agent" from="<slug>", this message came from ANOTHER local Claude Code session, not from the human — answer it (if at all) with the send_to tool addressed to that slug, and do NOT use the reply tool (reply pushes to the human\'s phone, which a peer message must not do). Status pings (ready/error) fire automatically via the daemon and do not need a reply call.';

/** One connected relay == one Claude session. Mirrors belfry-mcp.js per-conn. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.instanceId = randomUUID();
    this.slug = null;             // set from handshake
    this.cwd = null;
    this.acceptsBroadcast = true;
    this.registered = false;
    this.registerInFlight = false;
    this.shuttingDown = false;
    this.recvAbort = null;
    this.handshakeDone = false;
    this.buf = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('end', () => this.shutdown('socket-end'));
    socket.on('close', () => this.shutdown('socket-close'));
    socket.on('error', (err) => {
      this.log(`socket error: ${err.message}`);
      this.shutdown('socket-error');
    });
  }

  log(msg) {
    process.stderr.write(`belfry-broker ${this.slug || '?'}[${this.instanceId.slice(0, 8)}]: ${msg}\n`);
  }

  send(msg) {
    if (this.shuttingDown || this.socket.destroyed) return;
    this.socket.write(JSON.stringify(msg) + '\n');
  }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  respondError(id, code, message) { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }

  onData(chunk) {
    this.buf += chunk;
    while (true) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      if (!this.handshakeDone) {
        this.handleHandshake(line);
        continue;
      }
      let msg;
      try { msg = JSON.parse(line); } catch (err) { this.log(`parse error: ${err.message}`); continue; }
      try { this.handleMessage(msg); } catch (err) { this.log(`handler error: ${err.stack ?? err.message}`); }
    }
  }

  handleHandshake(line) {
    this.handshakeDone = true;
    let hs = {};
    try { hs = JSON.parse(line); } catch { /* tolerate a bad handshake; fall back */ }
    this.cwd = typeof hs.cwd === 'string' ? hs.cwd : process.cwd();
    // Stable per-session id from the relay: reused across reconnects so the
    // daemon's re-register path preserves the queue (messages routed during a
    // broker bounce aren't lost). Falls back to the random id if absent.
    if (typeof hs.session_id === 'string' && hs.session_id) this.instanceId = hs.session_id;
    // Authoritative slug via the shared derivation, seeded with the relay's
    // cwd + the env hints it forwarded (the broker's own env can't identify
    // the session). Falls back to the relay's cheap hint, then cwd basename.
    const env = { ...(hs.env || {}) };
    try {
      this.slug = deriveSlug({ cwd: this.cwd, env }) || hs.slug_hint || 'unknown';
    } catch {
      this.slug = hs.slug_hint || 'unknown';
    }
    this.acceptsBroadcast = !['0', 'off', 'false', 'no'].includes(String(hs.broadcast ?? '').trim().toLowerCase());
    // Track current owner of this id so a stale Session's shutdown can't
    // unregister a live reconnect that took the id over.
    byId.set(this.instanceId, this);
    this.log(`handshake ok (cwd=${this.cwd}, reconnect=${hs.reconnect === true})`);
    // Reconnect: Claude already completed initialize before the broker bounced
    // and will NOT re-send it, so register now (don't wait for
    // notifications/initialized). Pushing channel notifications is safe — the
    // session is already initialized on Claude's side. Fresh sessions still
    // register on notifications/initialized.
    if (hs.reconnect === true) {
      this.register().catch((err) => this.log(`reconnect register error: ${err.message}`));
    }
  }

  handleMessage(msg) {
    if (msg.method === 'initialize') {
      this.respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        serverInfo: { name: 'belfry', version: '0.3.0-broker' },
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    if (msg.method === 'notifications/initialized') {
      this.register().catch((err) => this.log(`register error: ${err.message}`));
      return;
    }
    if (msg.method === 'tools/list') { this.respond(msg.id, { tools: TOOLS }); return; }
    if (msg.method === 'tools/call') {
      this.handleToolCall(msg).catch((err) => {
        this.log(`tools/call error: ${err.message}`);
        this.respondError(msg.id, -32603, `tool error: ${err.message}`);
      });
      return;
    }
    if (msg.method === 'resources/list') { this.respond(msg.id, { resources: [] }); return; }
    if (msg.method === 'prompts/list') { this.respond(msg.id, { prompts: [] }); return; }
    if (msg.method === 'shutdown') { this.respond(msg.id, {}); return; }
    if (msg.id !== undefined) this.respondError(msg.id, -32601, `method not found: ${msg.method}`);
  }

  async handleToolCall(msg) {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === 'send_to') return this.handleSendTo(msg, args);
    if (name !== 'reply') { this.respondError(msg.id, -32602, `unknown tool: ${name}`); return; }
    const text = typeof args.text === 'string' ? args.text : '';
    const files = Array.isArray(args.files) ? args.files.filter((f) => typeof f === 'string' && f) : [];
    if (text.length === 0 && files.length === 0) {
      this.respondError(msg.id, -32602, 'reply: provide text and/or files (both empty)');
      return;
    }
    const res = await fetch(`${DAEMON_BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ instance_id: this.instanceId, text, files: files.length ? files : undefined }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      this.respondError(msg.id, -32603, `daemon /send ${res.status}: ${errBody.slice(0, 200)}`);
      return;
    }
    const body = await res.json().catch(() => ({}));
    const fileNote = files.length ? ` + ${files.length} file(s)` : '';
    const summary = body?.message_id
      ? `Sent to Telegram (message ${body.message_id}, ${text.length} chars${fileNote}).`
      : `Sent to Telegram (${text.length} chars${fileNote}).`;
    this.respond(msg.id, { content: [{ type: 'text', text: `${summary}${text ? `\n\nSent text:\n${text}` : ''}` }] });
  }

  async handleSendTo(msg, args) {
    const toSlug = typeof args.slug === 'string' ? args.slug.trim() : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (toSlug.length === 0) { this.respondError(msg.id, -32602, 'send_to: slug must be a non-empty string'); return; }
    if (text.length === 0) { this.respondError(msg.id, -32602, 'send_to: text must be a non-empty string'); return; }
    const res = await fetch(`${DAEMON_BASE}/send-to`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ instance_id: this.instanceId, to_slug: toSlug, text }),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      this.respondError(msg.id, -32603, `send_to rate-limited (${body?.reason ?? 'rate'}) — slow down peer messaging to "${toSlug}"`);
      return;
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      this.respondError(msg.id, -32603, `daemon /send-to ${res.status}: ${errBody.slice(0, 200)}`);
      return;
    }
    const body = await res.json().catch(() => ({}));
    const delivered = body?.delivered ?? 0;
    const summary = delivered > 0
      ? `Relayed to "${toSlug}" (${delivered} live session(s)).`
      : `"${toSlug}" has no live session right now — nothing delivered.`;
    this.respond(msg.id, { content: [{ type: 'text', text: `${summary}\n\nSent text:\n${text}` }] });
  }

  async register() {
    if (this.registered || this.registerInFlight || this.shuttingDown) return;
    this.registerInFlight = true;
    try {
      const res = await fetch(`${DAEMON_BASE}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ instance_id: this.instanceId, slug: this.slug, cwd: this.cwd, pid: process.pid, accepts_broadcast: this.acceptsBroadcast }),
      });
      if (res.status === 401) {
        const fresh = loadToken();
        if (fresh && fresh !== authToken) { authToken = fresh; this.log('register: token reloaded — retrying'); }
        else this.log('register failed: HTTP 401');
        this.scheduleRetry(() => this.register());
        return;
      }
      if (!res.ok) { this.log(`register failed: HTTP ${res.status}`); this.scheduleRetry(() => this.register()); return; }
      this.registered = true;
      this.log('registered with daemon');
      this.recvLoop().catch((err) => this.log(`recv loop crashed: ${err.message}`));
    } catch (err) {
      this.log(`register fetch error: ${err.message}`);
      this.scheduleRetry(() => this.register());
    } finally {
      this.registerInFlight = false;
    }
  }

  scheduleRetry(fn) {
    if (this.shuttingDown) return;
    setTimeout(() => fn(), RECONNECT_BACKOFF_MS).unref();
  }

  async recvLoop() {
    while (!this.shuttingDown) {
      const iterStart = Date.now();
      this.recvAbort = new AbortController();
      const signal = AbortSignal.any([this.recvAbort.signal, AbortSignal.timeout(RECV_TIMEOUT_MS)]);
      let res;
      try {
        const url = `${DAEMON_BASE}/recv?instance_id=${encodeURIComponent(this.instanceId)}`;
        res = await fetch(url, { signal, headers: authHeaders() });
      } catch (err) {
        if (this.shuttingDown) return;
        this.log(`recv error: ${err.message} — backing off`);
        await sleep(RECONNECT_BACKOFF_MS);
        continue;
      }
      if (res.status === 204) {
        const elapsed = Date.now() - iterStart;
        if (elapsed < MIN_RECV_LOOP_MS) await sleep(MIN_RECV_LOOP_MS - elapsed);
        continue;
      }
      if (res.status === 401) {
        const fresh = loadToken();
        if (fresh && fresh !== authToken) { authToken = fresh; this.log('recv: token reloaded'); }
        await sleep(RECONNECT_BACKOFF_MS);
        continue;
      }
      if (res.status === 404) {
        this.log('daemon lost our instance — re-registering');
        this.registered = false;
        await sleep(RECONNECT_BACKOFF_MS);
        await this.register();
        return;
      }
      if (!res.ok) { this.log(`recv HTTP ${res.status} — backing off`); await sleep(RECONNECT_BACKOFF_MS); continue; }
      let body;
      try { body = await res.json(); } catch (err) { this.log(`recv body parse: ${err.message}`); await sleep(RECONNECT_BACKOFF_MS); continue; }
      if (typeof body?.text === 'string' && body.text.length > 0) {
        this.injectChannel(body.text, {
          imagePath: typeof body.image_path === 'string' ? body.image_path : undefined,
          voicePath: typeof body.voice_path === 'string' ? body.voice_path : undefined,
          broadcast: body.broadcast === true,
          origin: typeof body.origin === 'string' ? body.origin : undefined,
          from: typeof body.from === 'string' ? body.from : undefined,
        });
      }
    }
  }

  injectChannel(text, attachment = {}) {
    const params = { content: text, meta: { slug: this.slug, ts: new Date().toISOString() } };
    if (attachment.imagePath) params.image_path = attachment.imagePath;
    if (attachment.voicePath) params.voice_path = attachment.voicePath;
    if (attachment.broadcast) params.meta.broadcast = 'true';
    if (attachment.origin) params.meta.origin = attachment.origin;
    if (attachment.from) params.meta.from = attachment.from;
    this.send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params });
  }

  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`shutting down (${reason})`);
    if (this.recvAbort) { try { this.recvAbort.abort(); } catch {} }
    // Only unregister from the daemon if WE still own this id. If a reconnect
    // created a newer Session that took the id over, byId points at it — leaving
    // the live session registered. (Same-process reconnect race guard; the
    // common reconnect case is a broker restart where this old process is gone.)
    const stillOwner = byId.get(this.instanceId) === this;
    if (stillOwner) byId.delete(this.instanceId);
    if (this.registered && stillOwner) {
      try {
        await fetch(`${DAEMON_BASE}/unregister`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ instance_id: this.instanceId }),
        });
      } catch {}
    }
    try { this.socket.destroy(); } catch {}
    sessions.delete(this);
  }
}

const sessions = new Set();
// instance_id -> current owning Session, so a stale Session's shutdown can't
// unregister an id a live reconnect has taken over.
const byId = new Map();

function startServer() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Clear a stale socket from a previous broker that didn't clean up.
  if (existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH); } catch {}
  }
  const server = net.createServer((socket) => {
    const s = new Session(socket);
    sessions.add(s);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      brokerLog(`socket ${SOCK_PATH} in use — another broker is running; exiting`);
      process.exit(0);
    }
    brokerLog(`server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(SOCK_PATH, () => {
    try { chmodSync(SOCK_PATH, 0o600); } catch {}
    brokerLog(`listening on ${SOCK_PATH} (auth=${authToken ? 'on' : 'off'})`);
  });

  const bye = () => {
    for (const s of sessions) { try { s.shutdown('broker-exit'); } catch {} }
    try { unlinkSync(SOCK_PATH); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
