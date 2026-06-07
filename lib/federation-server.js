/**
 * FederationServer — the daemon's inbound mesh listener (#29).
 *
 * A SEPARATE HTTP server from the loopback registry, on its own bind+port, that
 * accepts A2A-shaped envelopes from peer daemons on three routes:
 *   POST /fed/announce  — peer advertises its current slugs (gossip)
 *   POST /fed/message   — peer relays an agent message for one of our slugs
 *   POST /fed/reply     — peer returns a reply to a correlation we opened
 *
 * SECURITY (fail-closed — the loopback registry's "any local process is trusted"
 * model must NOT cross machines):
 *   - A bearer token is MANDATORY. Construction without one throws, so we can
 *     never accidentally expose unauthenticated /fed/* on a network interface.
 *   - Every request must present `Authorization: Bearer <token>`.
 *   - POST + Content-Type: application/json only; per-request body cap; socket
 *     timeout. Bind address is caller-chosen (the tailnet interface), never
 *     defaulted to a wildcard by this module.
 *   - The transport never trusts envelope routing blindly: it validates the
 *     envelope shape (lib/federation-envelope.js) and hands a parsed, typed
 *     envelope to the injected handler, which enforces destination + provenance.
 *
 * Handlers (onAnnounce/onMessage/onReply) are injected async callbacks returning
 * a JSON-serializable result (or throwing → 400). The daemon wires them to the
 * peer registry / local delivery / correlation tracker.
 */

import { createServer } from 'node:http';
import { parseEnvelope } from './federation-envelope.js';

const MAX_BODY_BYTES = 80 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class FederationServer {
  constructor({
    port,
    bind = '127.0.0.1',
    token,
    log = () => {},
    onAnnounce = null,
    onMessage = null,
    onReply = null,
  } = {}) {
    if (!token || typeof token !== 'string') {
      // Fail closed: never start an unauthenticated mesh listener.
      throw new Error('FederationServer requires a bearer token (refusing to expose /fed/* unauthenticated)');
    }
    this.port = port;
    this.bind = bind;
    this.token = token;
    this.log = log;
    this.handlers = {
      announce: onAnnounce,
      message: onMessage,
      reply: onReply,
    };
    this.server = null;
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
          this.log(`federation handler error: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('internal error');
          }
        });
      });
      this.server.once('error', reject);
      this.server.listen(this.port, this.bind, () => {
        this.port = this.server.address().port;
        this.log(`federation listening on http://${this.bind}:${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  async handle(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) return send(res, 415, { error: 'unsupported media type' });
    if ((req.headers.authorization || '') !== `Bearer ${this.token}`) {
      return send(res, 401, { error: 'unauthorized' });
    }

    const pathname = (req.url || '/').split('?')[0];
    const kind = ROUTE_KIND[pathname];
    if (!kind) return send(res, 404, { error: 'not found' });
    const handler = this.handlers[kind];
    if (typeof handler !== 'function') return send(res, 503, { error: `no handler for ${kind}` });

    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: 'body too large or unreadable' });
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return send(res, 400, { error: `bad envelope: ${parsed.error}` });
    if (parsed.envelope.kind !== kind) {
      return send(res, 400, { error: `envelope kind "${parsed.envelope.kind}" does not match route ${pathname}` });
    }

    try {
      const result = await handler(parsed.envelope);
      return send(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (err) {
      this.log(`federation ${kind} handler threw: ${err.message}`);
      return send(res, 400, { ok: false, error: err.message });
    }
  }
}

const ROUTE_KIND = Object.freeze({
  '/fed/announce': 'announce',
  '/fed/message': 'message',
  '/fed/reply': 'reply',
});

function send(res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
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
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}
