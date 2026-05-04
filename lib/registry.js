/**
 * Hub-and-spoke registry: tracks per-session belfry-mcp plugin instances
 * and fans out routed Telegram messages to the right one(s).
 *
 * Three loopback HTTP endpoints, all JSON:
 *   POST /register     { instance_id, slug, cwd, pid } → 200 ok
 *   POST /unregister   { instance_id }                  → 200 ok
 *   GET  /recv?instance_id=X                            → 200 { text } or 204
 *
 * /recv is a long-poll (default 25s). Plugin loops it; whenever the daemon
 * routes a Telegram reply to the plugin's slug, the long-poll resolves with
 * the message text. Plugin then emits MCP `notifications/claude/channel` to
 * inject into its parent Claude Code session.
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

const DEFAULT_RECV_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_QUEUE_DEPTH = 64;
const INSTANCE_IDLE_GC_MS = 5 * 60_000; // evict instance with no /recv touch in 5 min

export class Registry {
  constructor({
    port = 9876,
    log = () => {},
    recvTimeoutMs = DEFAULT_RECV_TIMEOUT_MS,
    authToken = null,
  } = {}) {
    this.port = port;
    this.log = log;
    this.recvTimeoutMs = recvTimeoutMs;
    this.authToken = authToken;
    /** @type {Map<string, { slug, cwd, pid, queue: string[], waiter: (() => void) | null, lastSeen: number }>} */
    this.instances = new Map();
    /** @type {Map<string, Set<string>>} slug → instance ids */
    this.bySlug = new Map();
    this.server = null;
    this.allowedHosts = null; // built once after listen()
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
  deliver(slug, text) {
    const ids = this.bySlug.get(slug);
    if (!ids || ids.size === 0) {
      this.log(`registry: no instance for slug "${slug}" — dropping ${text.length} chars`);
      return 0;
    }
    let notified = 0;
    const now = Date.now();
    // Walk a snapshot — removeInstance() mutates this.bySlug.
    for (const id of [...ids]) {
      const inst = this.instances.get(id);
      if (!inst) continue;
      // Idle GC: if nothing has touched this instance in a while and there's
      // no waiter parked, assume the spoke is gone.
      if (!inst.waiter && now - inst.lastSeen > INSTANCE_IDLE_GC_MS) {
        this.log(`registry: GC idle instance ${id} (slug ${slug}, ${(now - inst.lastSeen) / 1000 | 0}s since last seen)`);
        this.removeInstance(id);
        continue;
      }
      inst.queue.push(text);
      if (inst.queue.length > MAX_QUEUE_DEPTH) {
        this.log(`registry: instance ${id} queue depth ${inst.queue.length} — evicting as dead`);
        this.removeInstance(id);
        continue;
      }
      if (inst.waiter) {
        const w = inst.waiter;
        inst.waiter = null;
        w();
      }
      notified++;
    }
    return notified;
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

    const url = new URL(req.url, `http://${hostHeader}`);
    if (req.method === 'POST' && url.pathname === '/register') return this.handleRegister(req, res);
    if (req.method === 'POST' && url.pathname === '/unregister') return this.handleUnregister(req, res);
    if (req.method === 'GET' && url.pathname === '/recv') return this.handleRecv(req, res, url);

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
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
      this.log(`registry: re-registered ${slug} (instance ${instance_id}, ${existing.queue.length} queued)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    this.instances.set(instance_id, {
      slug,
      cwd: typeof cwd === 'string' ? cwd : '',
      pid: typeof pid === 'number' ? pid : null,
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

  async handleRecv(req, res, url) {
    const id = url.searchParams.get('instance_id');
    if (!id || !this.instances.has(id)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown instance');
      return;
    }
    const inst = this.instances.get(id);
    inst.lastSeen = Date.now();

    // Fast path: queue already non-empty.
    if (inst.queue.length > 0) {
      const text = inst.queue.shift();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text }));
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
        finish(200, JSON.stringify({ text: inst.queue.shift() }));
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
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    let len = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      len += c.length;
      if (len > MAX_BODY_BYTES) {
        aborted = true;
        try { req.destroy(); } catch {}
        resolve(null);
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
