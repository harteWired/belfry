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
 * Loopback-bound and same DNS-rebinding / Content-Type guard as the old
 * MCP HTTP server. No auth.
 */

import { createServer } from 'node:http';

const DEFAULT_RECV_TIMEOUT_MS = 25_000;

export class Registry {
  constructor({ port = 9876, log = () => {}, recvTimeoutMs = DEFAULT_RECV_TIMEOUT_MS } = {}) {
    this.port = port;
    this.log = log;
    this.recvTimeoutMs = recvTimeoutMs;
    /** @type {Map<string, { slug, cwd, pid, queue: string[], waiter: (() => void) | null }>} */
    this.instances = new Map();
    /** @type {Map<string, Set<string>>} slug → instance ids */
    this.bySlug = new Map();
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
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
   */
  deliver(slug, text) {
    const ids = this.bySlug.get(slug);
    if (!ids || ids.size === 0) {
      this.log(`registry: no instance for slug "${slug}" — dropping ${text.length} chars`);
      return 0;
    }
    let notified = 0;
    for (const id of ids) {
      const inst = this.instances.get(id);
      if (!inst) continue;
      inst.queue.push(text);
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
    const allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
    if (!allowedHosts.has(hostHeader)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
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
    if (!body || typeof body.instance_id !== 'string' || typeof body.slug !== 'string') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    const { instance_id, slug, cwd, pid } = body;
    this.instances.set(instance_id, {
      slug,
      cwd: typeof cwd === 'string' ? cwd : '',
      pid: typeof pid === 'number' ? pid : null,
      queue: [],
      waiter: null,
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
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
