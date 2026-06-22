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
// Per-slug owes-reply queue cap. Multiple inbound messages to one session each
// owe a reply; we FIFO-queue them so a later message doesn't overwrite an
// earlier one's marker (which silently dropped the earlier reply). Bounded so a
// session that never answers can't grow it without limit — oldest is evicted.
const MAX_OWED_REPLIES = 16;

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
    /**
     * Optional federation router (#29). When set, `/send-to` consults it BEFORE
     * local delivery so a `send_to` for a slug that lives on a peer host is
     * forwarded over the mesh instead of dropped as "no live session". Async:
     *   (fromSlug, target, text) → {
     *     handled: boolean,            // false → fall through to local relay
     *     ok?: boolean, status?, reason?, candidates?, delivered?, host?
     *   }
     * Null on a daemon with federation disabled — every existing single-host
     * deployment keeps the pure-local path. Wired by lib/federation-daemon.js.
     * @type {null | ((fromSlug: string, target: string, text: string) => Promise<object>)}
     */
    this.federationRouter = null;
    /**
     * Optional webhook-bridge reply router (#29 Phase C). A headless agent
     * reached via a bridge (e.g. the NAS life-planner) POSTs its async reply to
     * `/bridge/reply { correlationId, text }`; this resolves the correlation and
     * routes the reply back over the mesh to the original sender. Async:
     *   (correlationId, text) → { ok, delivered?, to?, status?, reason? }
     * Null until lib/federation-daemon.js wires it (bridges configured).
     * @type {null | ((correlationId: string, text: string) => Promise<object>)}
     */
    this.bridgeReplyHandler = null;
    this.onRemoteReply = null; // #38 Phase 2 A+ return-leg handler (late-bound)
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
    /**
     * Parallel owes-reply marker for a HUMAN message that was FORWARDED here from
     * the bot owner (#38 Phase 2). Separate from `pendingReply` (local Telegram
     * messages) because it carries the originating Telegram context the remote
     * needs to direct-send the reply itself. Mutually exclusive per slug with the
     * local marker — a slug owes a reply to exactly one place per turn.
     * @type {Map<string, { ownerHost, correlationId, chatId, originatingMessageId, ts }>}
     */
    this.remotePendingReply = new Map();
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

  /**
   * Late-binding setter for the federation router (#29). The daemon builds it
   * after the registry is running (it closes over the peer registry + mesh
   * client), so it must be attachable post-construction. See lib/federation-daemon.js.
   */
  setFederationRouter(fn) {
    this.federationRouter = fn;
  }

  /**
   * Late-binding setter for the webhook-bridge reply router (#29 Phase C).
   * Wired by lib/federation-daemon.js when bridges are configured.
   */
  setBridgeReplyHandler(fn) {
    this.bridgeReplyHandler = fn;
  }

  /**
   * Late-binding setter for the #38 Phase 2 A+ return-leg handler. Wired by
   * bin/belfry.js: given { slug, text, remote }, it direct-sends the reply to
   * the owner's chat (non-exclusive sendMessage), swaps the inbound reaction,
   * and syncs the message_id→slug to the current owner. Null when the daemon
   * has no Telegram side (a pure mesh node).
   */
  setRemoteReplyHandler(fn) {
    this.onRemoteReply = fn;
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
    if (req.method === 'POST' && pathname === '/bridge/reply') return this.handleBridgeReply(req, res);
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
   * Enqueue that `slug` owes a reply to Telegram message `messageId`. FIFO —
   * a second inbound to the same session no longer OVERWRITES the first (which
   * silently dropped the first reply when the session answered both). Each
   * reply consumes the OLDEST owed message (clearOwesReply), so messages get
   * answered in order. Bounded by MAX_OWED_REPLIES; oldest is dropped if over.
   */
  markOwesReply(slug, messageId) {
    if (typeof slug !== 'string' || slug.length === 0) return;
    if (typeof messageId !== 'number' || messageId <= 0) return;
    // Mutual exclusion (#38 Phase 2): a local Telegram inbound supersedes any
    // pending REMOTE-forwarded marker for this slug — this turn is local.
    this.remotePendingReply.delete(slug);
    const q = this.pendingReply.get(slug) ?? [];
    q.push({ messageId, ts: Date.now() });
    while (q.length > MAX_OWED_REPLIES) q.shift();
    this.pendingReply.set(slug, q);
  }

  /**
   * Mark `slug` as owing a reply to a HUMAN message FORWARDED from the bot owner
   * (#38 Phase 2). Stores the Telegram context so the remote session's reply can
   * direct-send back. Mutually exclusive with the local marker — clears it.
   */
  markRemoteOwesReply(slug, { ownerHost, correlationId, chatId, originatingMessageId } = {}) {
    if (typeof slug !== 'string' || slug.length === 0) return;
    this.pendingReply.delete(slug); // this turn is remote-forwarded, not local
    this.remotePendingReply.set(slug, {
      ownerHost, correlationId, chatId, originatingMessageId, ts: Date.now(),
    });
  }

  /** The remote owes-reply context for `slug`, or null if absent / expired. */
  getRemoteOwesReply(slug) {
    const entry = this.remotePendingReply.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.ts > PENDING_REPLY_TTL_MS) {
      this.remotePendingReply.delete(slug);
      return null;
    }
    return entry;
  }

  clearRemoteOwesReply(slug) {
    this.remotePendingReply.delete(slug);
  }

  /**
   * Peek the OLDEST owed-reply messageId for `slug` (the next message to answer),
   * or null if none. Evicts expired entries from the front first. Does NOT pop —
   * a reply threads to this id, then clearOwesReply() consumes it.
   */
  getOwesReply(slug) {
    const q = this.pendingReply.get(slug);
    if (!q || q.length === 0) return null;
    const now = Date.now();
    while (q.length > 0 && now - q[0].ts > PENDING_REPLY_TTL_MS) q.shift();
    if (q.length === 0) {
      this.pendingReply.delete(slug);
      return null;
    }
    return q[0].messageId;
  }

  /** Consume the OLDEST owed reply for `slug` (a reply just went out for it). */
  clearOwesReply(slug) {
    const q = this.pendingReply.get(slug);
    if (!q || q.length === 0) return;
    q.shift();
    if (q.length === 0) this.pendingReply.delete(slug);
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
    // A reply may carry text, files, or both (#outbound files). Require at least
    // one. Files are absolute paths on THIS host (the daemon reads them and
    // uploads each via Telegram sendDocument); they ride through to onSend.
    const hasText = body && typeof body.text === 'string' && body.text.length > 0;
    const hasFiles = body && Array.isArray(body.files) && body.files.length > 0 &&
      body.files.every((f) => typeof f === 'string' && f.length > 0);
    if (
      !body ||
      typeof body.instance_id !== 'string' ||
      body.instance_id.length === 0 ||
      (!hasText && !hasFiles)
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    if (hasText && body.text.length > MAX_SEND_TEXT_LEN) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('text too long');
      return;
    }
    const files = hasFiles ? body.files : undefined;
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
    // #38 Phase 2 return leg: if this slug owes a reply to a HUMAN message that
    // was FORWARDED from the bot owner, the answer must direct-send back to the
    // owner's chat — this host doesn't own the bot, but sendMessage is non-
    // exclusive. Decided by the remote marker (mutually exclusive with the local
    // one). Skipped when the caller passed an explicit reply_to override.
    const explicitReplyTo = typeof body.reply_to_message_id === 'number' && body.reply_to_message_id > 0;
    const remote = explicitReplyTo ? null : this.getRemoteOwesReply(inst.slug);
    if (remote && this.onRemoteReply) {
      inst.lastSeen = Date.now();
      let result;
      try {
        result = await this.onRemoteReply({ slug: inst.slug, text: body.text, remote, files });
      } catch (err) {
        // Clear the marker even on failure — otherwise a transient Telegram
        // error (429/network) would pin EVERY future /send from this session to
        // the broken direct-send path for the full 1h TTL, silently dropping the
        // human's answers. One lost reply beats an hour-long wedge.
        this.clearRemoteOwesReply(inst.slug);
        this.log(`registry: /send remote return-leg failed for ${inst.slug}: ${err.message}`);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
      this.clearRemoteOwesReply(inst.slug);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: result?.message_id ?? null }));
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
      result = await this.onSend({ slug: inst.slug, text: body.text, replyToMessageId, files });
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
      // Bare slug, or a host-qualified `<letter>/<slug>` target (#29) — the
      // single-char prefix routes across the federation mesh.
      !/^([a-z0-9]\/)?[a-zA-Z0-9._-]{1,128}$/.test(body.to_slug) ||
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

    // Federation (#29): if a router is wired, give it first refusal. It returns
    // handled:false for a local (or unknown→treat-as-local) target so we fall
    // through to the pure-local relay below; handled:true when it resolved the
    // target to a peer host and forwarded over the mesh (or rejected the target
    // as ambiguous/invalid). Best-effort by contract — a transport failure maps
    // to a non-2xx the spoke surfaces, never a daemon crash.
    if (this.federationRouter) {
      let remote;
      try {
        remote = await this.federationRouter(inst.slug, body.to_slug, body.text);
      } catch (err) {
        this.log(`registry: federation router threw for ${inst.slug}→${body.to_slug}: ${err.message}`);
        remote = { handled: true, ok: false, status: 502, reason: `federation error: ${err.message}` };
      }
      if (remote && remote.handled) {
        if (!remote.ok) {
          res.writeHead(remote.status || 502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: remote.reason, candidates: remote.candidates }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, delivered: remote.delivered ?? 1, to_slug: body.to_slug, remote: true, host: remote.host }));
        return;
      }
    }

    const result = this.relayAgentMessage(inst.slug, body.to_slug, body.text);
    if (!result.ok) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: result.reason }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, delivered: result.delivered, to_slug: body.to_slug }));
  }

  /**
   * POST /bridge/reply { correlationId, text } (#29 Phase C). A headless bridge
   * agent (e.g. the NAS life-planner) posts its async reply here; we hand it to
   * the wired bridgeReplyHandler, which resolves the correlation to the original
   * sender and routes the reply back over the mesh. Auth is the same per-process
   * registry token (the agent runs loopback-local to this daemon).
   */
  async handleBridgeReply(req, res) {
    if (typeof this.bridgeReplyHandler !== 'function') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('bridge replies not enabled');
      return;
    }
    const body = await readJson(req);
    if (
      !body ||
      typeof body.correlationId !== 'string' || body.correlationId.length === 0 ||
      typeof body.text !== 'string' || body.text.length === 0
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request (need correlationId + text)');
      return;
    }
    if (body.text.length > MAX_SEND_TEXT_LEN) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('text too long');
      return;
    }
    let result;
    try {
      result = await this.bridgeReplyHandler(body.correlationId, body.text);
    } catch (err) {
      this.log(`registry: bridge reply handler threw: ${err.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: `bridge reply error: ${err.message}` }));
      return;
    }
    res.writeHead(result?.ok ? 200 : (result?.status || 502), { 'content-type': 'application/json' });
    res.end(JSON.stringify(result ?? { ok: false, reason: 'no result' }));
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
