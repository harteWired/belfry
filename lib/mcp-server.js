/**
 * Hand-rolled HTTP MCP server.
 *
 * Speaks JSON-RPC 2.0 over HTTP POST on a single endpoint (`/`) bound to
 * loopback only. Implements the minimum MCP method set required by our
 * hook clients:
 *
 *   - initialize  → returns server info + capabilities
 *   - tools/list  → returns the tool catalog
 *   - tools/call  → invokes a tool by name
 *
 * Tools:
 *
 *   drain_inbox({ slug, queue })  destructive read of the slug's queue
 *   peek_inbox ({ slug, queue })  non-destructive read
 *
 * tools/call result shape:
 *
 *   { content: [{ type: "text", text: "<inbox content>" }] }   non-empty
 *   { content: [] }                                            empty queue
 *
 * No auth (loopback-only). No SSE — every request gets a single JSON
 * response. No MCP SDK; the JSON-RPC dispatch is ~30 lines.
 */

import { createServer } from 'node:http';

const PROTOCOL_VERSION = '2024-11-05';

const TOOL_DESCRIPTORS = [
  {
    name: 'drain_inbox',
    description:
      'Destructively read pending messages for a slug+queue. Returns the joined contents and clears the queue. Use from a Stop or PreToolUse hook to feed Telegram replies into the active session.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        queue: { type: 'string', enum: ['continuation', 'interrupt'] },
      },
      required: ['slug', 'queue'],
    },
  },
  {
    name: 'peek_inbox',
    description:
      'Non-destructive read of pending messages for a slug+queue. Returns the joined contents without clearing.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        queue: { type: 'string', enum: ['continuation', 'interrupt'] },
      },
      required: ['slug', 'queue'],
    },
  },
];

export class McpServer {
  constructor({ inbox, port, host = '127.0.0.1', log = () => {} }) {
    this.inbox = inbox;
    this.port = port;
    this.host = host;
    this.log = log;
    this.server = null;
  }

  async start() {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = this.server.address();
    // If the constructor was called with port: 0 the OS assigned us a port;
    // sync it back so the Host-header allowlist matches the real port.
    this.port = addr.port;
    this.log(`mcp listening on http://${addr.address}:${addr.port}`);
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async handle(req, res) {
    // DNS rebinding guard: even though we bind to 127.0.0.1, a malicious
    // browser page using DNS rebinding can hit us at a non-loopback hostname.
    // Reject any request whose Host header isn't an explicit loopback name +
    // our port. This + the Content-Type check below means a "simple" CORS
    // request can't reach our handler unscathed.
    const hostHeader = (req.headers.host || '').toLowerCase();
    const allowedHosts = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
    ]);
    if (!allowedHosts.has(hostHeader)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    // Force application/json so browsers can't bypass via text/plain "simple
    // requests". application/json triggers CORS preflight, which our server
    // doesn't satisfy (no Access-Control-Allow-Origin), so browsers will
    // block the followup.
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      res.writeHead(415, { 'content-type': 'text/plain' });
      res.end('unsupported media type');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch (err) {
        respond(res, jsonRpcError(null, -32700, 'Parse error'));
        return;
      }
      const response = this.dispatch(request);
      respond(res, response);
    });
  }

  dispatch(request) {
    const id = request?.id ?? null;
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return jsonRpcError(id, -32600, 'Invalid Request');
    }
    try {
      switch (request.method) {
        case 'initialize':
          return jsonRpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'belfry', version: '0.1.0' },
          });
        case 'tools/list':
          return jsonRpcResult(id, { tools: TOOL_DESCRIPTORS });
        case 'tools/call':
          return this.callTool(id, request.params);
        case 'notifications/initialized':
          // MCP clients send this after initialize; no response required for
          // notifications, but we return a no-op result for simplicity.
          return jsonRpcResult(id, {});
        default:
          return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
      }
    } catch (err) {
      return jsonRpcError(id, -32603, `Internal error: ${err.message}`);
    }
  }

  callTool(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const slug = args.slug;
    const queue = args.queue;
    if (typeof slug !== 'string' || typeof queue !== 'string') {
      return jsonRpcError(id, -32602, 'slug and queue are required strings');
    }
    let text;
    try {
      if (name === 'drain_inbox') text = this.inbox.drain(slug, queue);
      else if (name === 'peek_inbox') text = this.inbox.peek(slug, queue);
      else return jsonRpcError(id, -32602, `unknown tool: ${name}`);
    } catch (err) {
      return jsonRpcError(id, -32602, err.message);
    }
    const content = text ? [{ type: 'text', text }] : [];
    return jsonRpcResult(id, { content });
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function respond(res, body) {
  const json = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}
