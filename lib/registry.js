/**
 * Hub-and-spoke registry: tracks per-session belfry-mcp plugin instances,
 * fans out routed Telegram messages to the right one(s), and proxies
 * outbound replies from spokes back to Telegram.
 *
 * Four loopback HTTP endpoints, all JSON:
 *   POST /register     { instance_id, slug, cwd, pid } → 200 ok
 *   POST /unregister   { instance_id }                  → 200 ok
 *   GET  /recv?instance_id=X                            → 200 { text } or 204
 *   POST /send         { instance_id, text, reply_to_message_id? }
 *                                                       → 200 { message_id }
 *   POST /send-to      { instance_id, to_slug, text }   → 200 { delivered }
 *                                  agent-to-agent relay (#36); 429 if guarded
 *
 * /recv is a long-poll (default 25s). Plugin loops it; whenever the daemon
 * routes a Telegram reply to the plugin's slug, the long-poll resolves with
 * the message text. Plugin then emits MCP `notifications/claude/channel` to
 * inject into its parent Claude Code session.
 *
 * /send is the outbound complement: spokes call it from their `reply` MCP
 * tool, the registry resolves the instance's slug, and the daemon-supplied
 * `onSend` callback delivers to Telegram and records the new message_id in
 * the reply-tracker so subsequent quote-replies thread correctly.
 *
 * One slug → potentially many instances (you might have two terminals open
 * on the same project). `deliver` broadcasts; whichever drains first wins
 * for the user-visible turn — but both injection notifications fire so the
 * "stuck" instance's session also moves forward when the user touches it.
 *
 * Loopback-bound. Layered guards:
 *   1. DNS-rebinding: Host header must be 127.0.0.1:PORT or localhost:PORT.
 *   2. CSRF: Content-Type must be application/json on POST (blocks
 *      browser CORS-simple requests from a malicious page hitting loopback).
 *   3. Local-process auth: optional bearer token. The daemon generates one
 *      at startup, writes it 0600 to the state dir, and only spokes that
 *      can read that file send a matching Authorization header. Without
 *      this, any local user/process could /register an arbitrary slug and
 *      drain another session's Telegram replies via /recv.
 *   4. Per-request body cap (16 KiB) and socket timeout (5 s) to bound
 *      damage from a slow-loris or oversized body on the loopback socket.
 */

import { createServer } from 'node:http';

/**
 * Convert a queue item into the JSON shape /recv returns. Pre-attachment
 * code put plain strings on the queue; current code puts {text, ...attachment}
 * objects. Tolerate both so a string-style queue entry from a third party
 * still serializes correctly.
 */
function normalizeRecvItem(item) {
  if (typeof item === 'string') return { text: item };
  return item;
}

const DEFAULT_RECV_TIMEOUT_MS = 25_000;
// Per-request body cap. Needs to comfortably exceed MAX_SEND_TEXT_LEN
// (currently 64 KiB) plus JSON wrapper overhead — otherwise a long
// /send body would 413 on the read before the handler's own length check
// runs. 80 KiB gives ~16 KiB of room for the wrapper which is plenty.
const MAX_BODY_BYTES = 80 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_QUEUE_DEPTH = 64;
const INSTANCE_IDLE_GC_MS = 5 * 60_000; // evict instance with no /recv touch in 5 min
// Daemon-side cap on text accepted via /send. Larger than Telegram's
// per-message cap because the daemon's onSend pipeline packs / chunks
// oversized replies (lib/pack.js + lib/chunk.js) so a single Claude turn
// can be safely shipped end-to-end. Still bounded so a runaway plugin
// can't pin the daemon's heap.
const MAX_SEND_TEXT_LEN = 64 * 1024;
const PENDING_REPLY_TTL_MS = 60 * 60_000; // drop owes-reply markers after 1h

export class Registry {
  constructor({
    port = 49876,
    log = () => {},
    recvTimeoutMs = DEFAULT_RECV_TIMEOUT_MS,
    authToken = null,
    onSend = null,
    onBroadcast = null,
    brainHandlers = null,
    relayGuard = null,
  } = {}) {
    this.port = port;
    this.log = log;
    this.recvTimeoutMs = recvTimeoutMs;
    this.authToken = authToken;
    /**
     * Optional flood/loop guard for agent-to-agent relays (#36). An object with
     * `check(fromSlug, toSlug, text) → { ok, reason? }`. When null, relays are
     * unguarded (tests / single-shot use). See lib/agent-relay-guard.js.
     */
    this.relayGuard = relayGuard;
    /**
     * Daemon-supplied outbound dispatcher. Called by /send and by the
     * auto-reply path in the watcher. Async signature:
     *   ({ slug, text, replyToMessageId }) → { message_id }
     * Throws on Telegram failure; the handler maps that to 502.
     * @type {null | (args: { slug: string, text: string, replyToMessageId: number | null }) => Promise<{ message_id: number }>}
     */
    this.onSend = onSend;
    /**
     * Daemon-supplied broadcast orchestrator. Called by the `/broadcast` HTTP
     * route (local CLI) and directly by the poller's `/all` dispatch. Owns the
     * fan-out (via this.broadcast()) plus the Telegram-side concerns the
     * registry shouldn't know about: per-slug owes-reply threading, the
     * completion tracker, and the confirmation/summary messages. Async:
     *   ({ text, targetSlugs, excludeSlugs, messageId, source }) → { count, slugs }
     * When unset, `/broadcast` falls back to a bare this.broadcast() fan-out.
     * @type {null | (args: object) => Promise<{ count: number, slugs: string[] }>}
     */
    this.onBroadcast = onBroadcast;
    /**
     * Daemon-supplied handlers for the brain MCP plugin's HTTP endpoints
     * (/brain/*). Built by lib/brain-handlers.js makeBrainHandlers().
     * Mounted only when the brain feature is enabled.
     * @type {null | object}
     */
    this.brainHandlers = brainHandlers;
    /** @type {Map<string, { slug, cwd, pid, queue: string[], waiter: (() => void) | null, lastSeen: number }>} */
    this.instances = new Map();
    /** @type {Map<string, Set<string>>} slug → instance ids */
    this.bySlug = new Map();
    /**
     * Per-slug "owes Telegram a reply" marker. Set when an inbound Telegram
     * message routes to a slug; consumed by the watcher when the session
     * next produces a fresh `last_response`. Lazily expired after TTL so a
     * session that never replies doesn't leak the marker forever.
     * @type {Map<string, { messageId: number, ts: number }>}
     */
    this.pendingReply = new Map();
    this.server = null;
    this.allowedHosts = null; // built once after listen()
  }

  /**
   * Late-binding setter: bin/belfry.js builds nicknames + watcher + brain
   * after the registry is already running, so brainHandlers must be
   * attachable post-construction. Tests can also pass brainHandlers via
   * the constructor for a single-shot wire.
   */
  setBrainHandlers(handlers) {
    this.brainHandlers = handlers;
  }

  /**
   * Late-binding setter for the broadcast orchestrator. The daemon builds it
   * after the registry exists (it closes over registry.broadcast + the
   * completion tracker + sendMessage), so it must be attachable post-construction.
   */
  setBroadcastHandler(fn) {
    this.onBroadcast = fn;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
          if (!res.headersSent) {
            res.writeHead(408, { 'content-type': 'text/plain' });
            res.end('request timeout');
          } else {
            req.destroy();
          }
        });
        this.handle(req, res).catch((err) => {
          this.log(`registry handler error: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('internal error');
          }
        });
      });
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = addr.port;
        this.allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
        this.log(`registry listening on http://127.0.0.1:${addr.port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    // Resolve any pending long-polls so their plugins see the recv close cleanly.
    for (const inst of this.instances.values()) {
      if (inst.waiter) {
        const w = inst.waiter;
        inst.waiter = null;
        w();
      }
    }
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  /**
   * Live O(1) membership check for the prefix-path router. Cheaper than
   * `new Set(this.bySlug.keys())` — `route()` only consults this on the
   * fall-through branch after every other guard has rejected.
   */
  hasSlug(slug) {
    return this.bySlug.has(slug);
  }

  /**
   * Snapshot view of registered slugs. Kept for tests and any caller that
   * needs to enumerate; the poller's hot path uses `hasSlug` instead.
   */
  knownSlugs() {
    return new Set(this.bySlug.keys());
  }

  /**
   * Push `text` into every instance currently registered for `slug`. Returns
   * the number of instances notified. 0 means "nobody's listening" — caller
   * should drop and log; we can't queue indefinitely.
   *
   * If an instance's queue exceeds MAX_QUEUE_DEPTH, treat it as dead and
   * evict it: a healthy spoke long-polls /recv continuously, so a queue
   * that depth means the spoke has stopped draining. Capping bounds memory
   * for the case where a spoke crashes without /unregister.
   */
  deliver(slug, text, originatingMessageId = null, attachment = null) {
    const ids = this.bySlug.get(slug);
    if (!ids || ids.size === 0) {
      // Drop and DO NOT mark owes-reply: nobody received the message, so a
      // future ready transition for this slug would auto-reply with content
      // unrelated to the dropped inbound (last_response from some other turn).
      this.log(`registry: no instance for slug "${slug}" — dropping ${text.length} chars`);
      return 0;
    }
    if (typeof originatingMessageId === 'number' && originatingMessageId > 0) {
      this.markOwesReply(slug, originatingMessageId);
    }
    // Queue items are objects so attachments (image_path, voice_path) ride
    // alongside text. Older spokes only read .text and ignore the rest —
    // forward-compatible.
    const item = { text };
    if (attachment && typeof attachment === 'object') {
      if (typeof attachment.imagePath === 'string') item.image_path = attachment.imagePath;
      if (typeof attachment.voicePath === 'string') item.voice_path = attachment.voicePath;
    }
    let notified = 0;
    const now = Date.now();
    // Walk a snapshot — _pushToInstance → removeInstance() mutates this.bySlug.
    for (const id of [...ids]) {
      if (this._pushToInstance(id, item, now)) notified++;
    }
    return notified;
  }

  /**
   * Enqueue `item` on a single instance, handling idle-GC and dead-queue
   * eviction. Returns true if the instance was notified (queued, and its
   * parked waiter woken if any), false if it was missing / GC'd / evicted.
   * Shared by deliver() (one slug) and broadcast() (all instances).
   */
  _pushToInstance(id, item, now = Date.now()) {
    const inst = this.instances.get(id);
    if (!inst) return false;
    // Idle GC: if nothing has touched this instance in a while and there's
    // no waiter parked, assume the spoke is gone.
    if (!inst.waiter && now - inst.lastSeen > INSTANCE_IDLE_GC_MS) {
      this.log(`registry: GC idle instance ${id} (slug ${inst.slug}, ${(now - inst.lastSeen) / 1000 | 0}s since last seen)`);
      this.removeInstance(id);
      return false;
    }
    inst.queue.push(item);
    if (inst.queue.length > MAX_QUEUE_DEPTH) {
      this.log(`registry: instance ${id} queue depth ${inst.queue.length} — evicting as dead`);
      this.removeInstance(id);
      return false;
    }
    if (inst.waiter) {
      const w = inst.waiter;
      inst.waiter = null;
      w();
    }
    return true;
  }

  /**
   * Fan `text` out to EVERY registered instance — one queue push each — as an
   * independent message (unlike deliver(), which targets a single slug). The
   * queue item carries `broadcast: true` so the receiving plugin can surface it
   * as `meta.broadcast`. Skips instances that opted out (accepts_broadcast:false
   * at register) and honors optional slug allow/deny filters (the
   * `target_slugs`/`exclude_slugs` shape is forward-compatible with #29's
   * per-host filtering).
   *
   * Returns `{ count, slugs }` — instances notified and the distinct slugs
   * reached. The daemon uses `slugs` to thread replies and seed the completion
   * tracker. Does NOT mark owes-reply or send anything itself — that
   * orchestration lives in the daemon's onBroadcast.
   */
  broadcast(text, { targetSlugs = null, excludeSlugs = null } = {}) {
    const item = { text, broadcast: true };
    const target = targetSlugs ? new Set(targetSlugs) : null;
    const exclude = excludeSlugs ? new Set(excludeSlugs) : null;
    let count = 0;
    const slugs = new Set();
    const now = Date.now();
    // Snapshot — _pushToInstance may removeInstance() mid-iteration.
    for (const [id, inst] of [...this.instances]) {
      if (inst.acceptsBroadcast === false) continue;
      if (target && !target.has(inst.slug)) continue;
      if (exclude && exclude.has(inst.slug)) continue;
      if (this._pushToInstance(id, item, now)) {
        count++;
        slugs.add(inst.slug);
      }
    }
    return { count, slugs: [...slugs] };
  }

  /**
   * Relay an agent-to-agent message (#36): deliver `text` from one session to
   * every instance of `toSlug`, tagged with provenance so the recipient knows
   * it came from a peer agent (not the human over Telegram). Unlike deliver():
   *   - it does NOT markOwesReply — a peer message owes Telegram nothing, so it
   *     must never trip the auto-reply path or swap a routing reaction;
   *   - the queue item carries `origin: 'agent'` + `from: <fromSlug>` so the
   *     spoke surfaces `origin="agent" from="…"` on the channel tag and the
   *     model answers via send_to(from), not the Telegram `reply` tool.
   *
   * Returns { ok, delivered, reason? }. `delivered: 0` with ok:true means the
   * target slug has no live session (dropped, logged). ok:false carries a guard
   * `reason` ('rate' | 'duplicate').
   */
  relayAgentMessage(fromSlug, toSlug, text) {
    if (this.relayGuard) {
      const verdict = this.relayGuard.check(fromSlug, toSlug, text);
      if (!verdict.ok) {
        this.log(`registry: relay ${fromSlug}→${toSlug} blocked (${verdict.reason})`);
        return { ok: false, delivered: 0, reason: verdict.reason };
      }
    }
    const ids = this.bySlug.get(toSlug);
    if (!ids || ids.size === 0) {
      this.log(`registry: relay ${fromSlug}→${toSlug} — no live session, dropping ${text.length} chars`);
      return { ok: true, delivered: 0 };
    }
    const item = { text, origin: 'agent', from: fromSlug };
    let delivered = 0;
    const now = Date.now();
    for (const id of [...ids]) {
      if (this._pushToInstance(id, item, now)) delivered++;
    }
    this.log(`registry: relay ${fromSlug}→${toSlug} delivered to ${delivered} instance(s)`);
    return { ok: true, delivered };
  }

  async handle(req, res) {
    const hostHeader = (req.headers.host || '').toLowerCase();
    if (!this.allowedHosts || !this.allowedHosts.has(hostHeader)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    // CSRF guard: reject POSTs whose Content-Type isn't JSON. Browsers
    // can't set application/json on a CORS-simple cross-origin request
    // without triggering preflight (which we don't answer).
    if (req.method === 'POST') {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) {
        res.writeHead(415, { 'content-type': 'text/plain' });
        res.end('unsupported media type');
        return;
      }
    }

    // Per-process auth. Loopback alone doesn't isolate users on a shared
    // host, so when the daemon configured a token, every request must
    // present it. Tests construct Registry with no token — they skip this.
    if (this.authToken) {
      const authHeader = (req.headers.authorization || '');
      const expected = `Bearer ${this.authToken}`;
      if (authHeader !== expected) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
    }

    // Cheap path/query split — `new URL(...)` is comparatively heavy and
    // /recv hits this method continuously per spoke. We only need the path
    // here and the `instance_id` query param inside handleRecv.
    const rawUrl = req.url || '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const query = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';

    if (req.method === 'POST' && pathname === '/register') return this.handleRegister(req, res);
    if (req.method === 'POST' && pathname === '/unregister') return this.handleUnregister(req, res);
    if (req.method === 'GET' && pathname === '/recv') return this.handleRecv(req, res, query);
    if (req.method === 'POST' && pathname === '/send') return this.handleSend(req, res);
    if (req.method === 'POST' && pathname === '/send-to') return this.handleSendTo(req, res);
    if (req.method === 'POST' && pathname === '/broadcast') return this.handleBroadcast(req, res);

    if (pathname.startsWith('/brain/')) return this.handleBrain(req, res, pathname);

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  /**
   * Dispatch /brain/* tool calls from bin/belfry-brain-mcp.js to the
   * daemon-side handlers wired in via the `brainHandlers` constructor
   * option. Maps endpoint name → handler method, parses JSON body if
   * the method is POST, and serializes the return value (or any thrown
   * error) back to the brain MCP server.
   *
   * Auth + Host + Content-Type checks already ran in handle() above —
   * we don't re-do them here.
   */
  async handleBrain(req, res, pathname) {
    if (!this.brainHandlers) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('brain handlers not configured');
      return;
    }
    const ROUTES = {
      '/brain/list-sessions': { method: 'GET', fn: 'listSessions' },
      '/brain/get-session': { method: 'POST', fn: 'getSession' },
      '/brain/recent-messages': { method: 'POST', fn: 'recentMessages' },
      '/brain/nicknames': { method: 'GET', fn: 'nicknames' },
      '/brain/help': { method: 'POST', fn: 'help' },
      '/brain/deliver': { method: 'POST', fn: 'deliver' },
      '/brain/reply': { method: 'POST', fn: 'reply' },
      '/brain/decline': { method: 'POST', fn: 'decline' },
    };
    const route = ROUTES[pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown brain endpoint');
      return;
    }
    if (req.method !== route.method) {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end(`method not allowed; expected ${route.method}`);
      return;
    }
    let args = {};
    if (route.method === 'POST') {
      try {
        args = await readJson(req);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`invalid JSON body: ${err.message}`);
        return;
      }
    }
    const handler = this.brainHandlers[route.fn];
    if (typeof handler !== 'function') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(`brain handler '${route.fn}' not implemented`);
      return;
    }
    try {
      const result = await handler.call(this.brainHandlers, args);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? null));
    } catch (err) {
      this.log(`brain handler '${route.fn}' threw: ${err.message}`);
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(err.message);
    }
  }

  /**
   * Mark `slug` as owing a reply to Telegram message `messageId`. Overwrites
   * any prior marker — a fresher inbound message supersedes the older one.
   */
  markOwesReply(slug, messageId) {
    if (typeof slug !== 'string' || slug.length === 0) return;
    if (typeof messageId !== 'number' || messageId <= 0) return;
    this.pendingReply.set(slug, { messageId, ts: Date.now() });
  }

  /**
   * Return the pending-reply messageId for `slug`, or null if none / expired.
   * Lazily evicts expired entries.
   */
  getOwesReply(slug) {
    const entry = this.pendingReply.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.ts > PENDING_REPLY_TTL_MS) {
      this.pendingReply.delete(slug);
      return null;
    }
    return entry.messageId;
  }

  clearOwesReply(slug) {
    this.pendingReply.delete(slug);
  }

  async handleRegister(req, res) {
    const body = await readJson(req);
    if (
      !body ||
      typeof body.instance_id !== 'string' ||
      typeof body.slug !== 'string' ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(body.slug) ||
      body.instance_id.length === 0 ||
      body.instance_id.length > 128
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const { instance_id, slug, cwd, pid } = body;

    // Re-register: preserve queue + waiter. Clobbering on re-register loses
    // any messages routed between the previous /recv close and the new
    // register POST.
    const existing = this.instances.get(instance_id);
    if (existing) {
      if (existing.slug !== slug) {
        res.writeHead(409, { 'content-type': 'text/plain' });
        res.end('instance_id reused with different slug');
        return;
      }
      existing.lastSeen = Date.now();
      // A re-register may carry a changed broadcast preference (env flip +
      // session relaunch); honor it when present, otherwise keep the prior.
      if (typeof body.accepts_broadcast === 'boolean') existing.acceptsBroadcast = body.accepts_broadcast;
      this.log(`registry: re-registered ${slug} (instance ${instance_id}, ${existing.queue.length} queued)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    this.instances.set(instance_id, {
      slug,
      cwd: typeof cwd === 'string' ? cwd : '',
      pid: typeof pid === 'number' ? pid : null,
      // Broadcast opt-out is spoke-side (BELFRY_BROADCAST=false → reported here).
      // Default true: a session receives /all broadcasts unless it opts out.
      acceptsBroadcast: body.accepts_broadcast !== false,
      queue: [],
      waiter: null,
      lastSeen: Date.now(),
    });
    if (!this.bySlug.has(slug)) this.bySlug.set(slug, new Set());
    this.bySlug.get(slug).add(instance_id);
    this.log(`registry: registered ${slug} (instance ${instance_id}, pid ${pid ?? '?'})`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * `POST /broadcast` — local CLI (bin/belfry-broadcast.js) fan-out. Body:
   *   { text, target_slugs?: string[], exclude_slugs?: string[] }
   * Delegates to the daemon's onBroadcast orchestrator when wired (so a CLI
   * broadcast gets the same threading/tracker/summary as a Telegram /all);
   * falls back to a bare this.broadcast() fan-out otherwise. Auth + Host +
   * Content-Type already enforced centrally in handle().
   */
  async handleBroadcast(req, res) {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || body.text.length === 0) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    if (body.text.length > MAX_SEND_TEXT_LEN) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('text too long');
      return;
    }
    const targetSlugs = Array.isArray(body.target_slugs) ? body.target_slugs : null;
    const excludeSlugs = Array.isArray(body.exclude_slugs) ? body.exclude_slugs : null;
    let result;
    try {
      result = this.onBroadcast
        ? await this.onBroadcast({ text: body.text, targetSlugs, excludeSlugs, messageId: null, source: 'cli' })
        : this.broadcast(body.text, { targetSlugs, excludeSlugs });
    } catch (err) {
      this.log(`registry: /broadcast failed: ${err.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: result?.count ?? 0, slugs: result?.slugs ?? [] }));
  }

  async handleUnregister(req, res) {
    const body = await readJson(req);
    if (!body || typeof body.instance_id !== 'string') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const id = body.instance_id;
    this.removeInstance(id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  removeInstance(id) {
    const inst = this.instances.get(id);
    if (!inst) return;
    if (inst.waiter) {
      const w = inst.waiter;
      inst.waiter = null;
      w();
    }
    this.instances.delete(id);
    const set = this.bySlug.get(inst.slug);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.bySlug.delete(inst.slug);
    }
    this.log(`registry: unregistered ${inst.slug} (instance ${id})`);
  }

  async handleRecv(req, res, query) {
    const id = new URLSearchParams(query).get('instance_id');
    if (!id || !this.instances.has(id)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown instance');
      return;
    }
    const inst = this.instances.get(id);
    inst.lastSeen = Date.now();

    // Fast path: queue already non-empty.
    if (inst.queue.length > 0) {
      const item = inst.queue.shift();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(normalizeRecvItem(item)));
      return;
    }

    // Long-poll. Wait until either deliver() pushes, or timeout, or client aborts.
    let resolved = false;
    const finish = (status, body) => {
      if (resolved) return;
      resolved = true;
      if (inst.waiter === wakeup) inst.waiter = null;
      clearTimeout(timer);
      req.removeListener('close', onAbort);
      if (!res.writableEnded) {
        if (body !== undefined) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        } else {
          res.writeHead(status);
          res.end();
        }
      }
    };
    const wakeup = () => {
      if (inst.queue.length > 0) {
        finish(200, JSON.stringify(normalizeRecvItem(inst.queue.shift())));
      } else {
        // Spurious wakeup (e.g. shutdown): close as a 204.
        finish(204);
      }
    };
    const onAbort = () => finish(204);
    const timer = setTimeout(() => finish(204), this.recvTimeoutMs);
    inst.waiter = wakeup;
    req.on('close', onAbort);
  }

  async handleSend(req, res) {
    const body = await readJson(req);
    if (
      !body ||
      typeof body.instance_id !== 'string' ||
      body.instance_id.length === 0 ||
      typeof body.text !== 'string' ||
      body.text.length === 0
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    if (body.text.length > MAX_SEND_TEXT_LEN) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('text too long');
      return;
    }
    const inst = this.instances.get(body.instance_id);
    if (!inst) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown instance');
      return;
    }
    if (!this.onSend) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('outbound not configured');
      return;
    }
    // Resolve reply_to: explicit param wins; else fall back to the slug's
    // pending owes-reply marker (the message that originated the inbound
    // turn). null if neither — Telegram will post unthreaded.
    let replyToMessageId = null;
    if (typeof body.reply_to_message_id === 'number' && body.reply_to_message_id > 0) {
      replyToMessageId = body.reply_to_message_id;
    } else {
      replyToMessageId = this.getOwesReply(inst.slug);
    }
    inst.lastSeen = Date.now();
    let result;
    try {
      result = await this.onSend({ slug: inst.slug, text: body.text, replyToMessageId });
    } catch (err) {
      this.log(`registry: /send failed for ${inst.slug}: ${err.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    // Successful explicit reply consumes the pending marker — auto-reply
    // shouldn't double-fire on the next ready transition.
    this.clearOwesReply(inst.slug);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message_id: result?.message_id ?? null }));
  }

  /**
   * `POST /send-to` — agent-to-agent relay (#36). Body:
   *   { instance_id, to_slug, text }
   * The sender's slug is resolved from its instance_id (not trusted from the
   * body) so a session can't spoof another's identity. Delivers via
   * relayAgentMessage with provenance + the flood/loop guard. Returns
   * { ok, delivered } on success, or 429 with { reason } when the guard trips,
   * 404 when to_slug has no live session is NOT an error — it returns
   * delivered:0 so the caller learns the peer is offline.
   */
  async handleSendTo(req, res) {
    const body = await readJson(req);
    if (
      !body ||
      typeof body.instance_id !== 'string' ||
      body.instance_id.length === 0 ||
      typeof body.to_slug !== 'string' ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(body.to_slug) ||
      typeof body.text !== 'string' ||
      body.text.length === 0
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    if (body.text.length > MAX_SEND_TEXT_LEN) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('text too long');
      return;
    }
    const inst = this.instances.get(body.instance_id);
    if (!inst) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown instance');
      return;
    }
    inst.lastSeen = Date.now();
    const result = this.relayAgentMessage(inst.slug, body.to_slug, body.text);
    if (!result.ok) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: result.reason }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, delivered: result.delivered, to_slug: body.to_slug }));
  }
}

function readJson(req) {
  // Accumulate Buffers and concat once at end. Beats `body += chunk` (which
  // allocates a fresh string per chunk and discards the prior). Loopback
  // usually delivers one chunk so the win is theoretical here, but the
  // pattern is the right one if registry endpoints ever serve larger bodies.
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      const bytes = Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c);
      len += bytes;
      if (len > MAX_BODY_BYTES) {
        aborted = true;
        try { req.destroy(); } catch {}
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
