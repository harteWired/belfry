#!/usr/bin/env node
/**
 * Brain MCP server — the stdio MCP plugin Claude loads when running as
 * the daemon's "brain" subprocess. Exposes belfry's daemon-side state and
 * actions as tools the brain can call.
 *
 * Architecture:
 *   - Daemon supervises a long-running `claude --resume` subprocess (the
 *     brain). The brain handles language work — summarization, classifying
 *     unmatched Telegram messages, conversational answers — using the
 *     user's subscription auth (the same OAuth token claude uses for
 *     normal sessions).
 *   - This module is the MCP server the brain loads via .mcp.json. Tool
 *     calls flow: brain → this server (stdio JSON-RPC) → HTTP POST to
 *     daemon registry's /brain/* endpoints → daemon executes → returns
 *     result through the same chain.
 *
 * Why stdio + HTTP loopback rather than direct in-process calls: the
 * brain runs in its own process for crash isolation and so the user's
 * subscription auth lives in claude's own credential file. The daemon
 * doesn't see the OAuth token; it just invokes claude.
 *
 * Tools exposed (read-only):
 *   - list_sessions          → array of {slug, status, last_outbound_*}
 *   - get_session            → full status JSON for one slug
 *   - recent_messages        → recent outbound belfry messages for a slug
 *   - get_nicknames          → current nickname → slug map
 *   - get_help_text          → canonical help text by topic
 *
 * Tools exposed (actions):
 *   - deliver_to_slug        → forward a message to a session as user input
 *   - reply_to_telegram      → send a Telegram message (optionally a
 *                              quote-reply to the originating inbound)
 *   - decline                → polite "I can't help with that" + log
 *
 * The daemon endpoints all require a Bearer token (same one belfry-mcp.js
 * uses) read from BELFRY_BRAIN_TOKEN at startup. The supervisor passes the
 * token in the env when spawning the brain.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DAEMON_BASE = (process.env.BELFRY_MCP_BASE ?? 'http://127.0.0.1:49876').trim();
const TOKEN_PATH = process.env.BELFRY_BRAIN_TOKEN_PATH
  ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'belfry', 'registry.token');

let authToken = '';
try {
  authToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
} catch {
  // Token file not readable — tool calls will fail with 401, surfaced to the brain as an error.
}

function authHeaders() {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
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

function log(msg) {
  process.stderr.write(`belfry-brain-mcp ${msg}\n`);
}

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'Return active Claude Code sessions belfry knows about. Each row: slug, status, last_outbound_kind, last_outbound_ts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_session',
    description: 'Return the full dashboard JSON for one slug — status, last_prompt, last_response, displayName.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'recent_messages',
    description: 'Return up to n recent outbound belfry messages for a slug (newest first). Use to answer "what has X been doing?" style questions.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        n: { type: 'integer', minimum: 1, maximum: 32 },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_nicknames',
    description: 'Return the current nickname → slug map (read-only; nicknames are managed via the /nick command, not by the brain).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_help_text',
    description: 'Return canonical help text for a topic (all, routing, nicknames, status, agent). Use when the user asks how something works.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: ['all', 'routing', 'nicknames', 'status', 'agent'] },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'deliver_to_slug',
    description: 'Forward a body of text into a specific session as user input. The session sees it the same way it would see typed input. Use for "route this to session X" intents.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        body: { type: 'string' },
        reply_to_message_id: { type: 'integer' },
      },
      required: ['slug', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply_to_telegram',
    description: 'Send a Telegram message back to the user. If reply_to_message_id is supplied, it threads as a quote-reply.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        reply_to_message_id: { type: 'integer' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'decline',
    description: 'Politely punt on an unanswerable / off-topic request. Sends the message to Telegram and ends this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        reply_to_message_id: { type: 'integer' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

// Map tool names → daemon endpoints + arg shape conversion.
const TOOL_ENDPOINTS = {
  list_sessions: { method: 'GET', path: '/brain/list-sessions' },
  get_session: { method: 'POST', path: '/brain/get-session' },
  recent_messages: { method: 'POST', path: '/brain/recent-messages' },
  get_nicknames: { method: 'GET', path: '/brain/nicknames' },
  get_help_text: { method: 'POST', path: '/brain/help' },
  deliver_to_slug: { method: 'POST', path: '/brain/deliver' },
  reply_to_telegram: { method: 'POST', path: '/brain/reply' },
  decline: { method: 'POST', path: '/brain/decline' },
};

async function dispatchTool(name, args) {
  const endpoint = TOOL_ENDPOINTS[name];
  if (!endpoint) throw new Error(`unknown tool: ${name}`);
  const url = `${DAEMON_BASE}${endpoint.path}`;
  const init = { method: endpoint.method, headers: { ...authHeaders() } };
  if (endpoint.method === 'POST') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args ?? {});
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${endpoint.path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

async function handleInitialize(msg) {
  respond(msg.id, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'belfry-brain', version: '0.1.0' },
    instructions:
      'You are belfry\'s daemon brain. You handle language work for the user\'s Telegram → Claude Code bridge. ' +
      'When called, you\'ll typically be summarizing or classifying. Use tools to read state and take actions; ' +
      'don\'t paraphrase reference text (call get_help_text). The user\'s deterministic routes (/status, /nick, /help, /resume, slug-prefix, quote-reply) handle most things; you only see what falls through.',
  });
}

async function handleToolsList(msg) {
  respond(msg.id, { tools: TOOLS });
}

async function handleToolCall(msg) {
  const name = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  try {
    const result = await dispatchTool(name, args);
    respond(msg.id, {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    });
  } catch (err) {
    log(`tool ${name} failed: ${err.message}`);
    respondError(msg.id, -32603, `tool ${name} failed: ${err.message}`);
  }
}

function handleMessage(msg) {
  if (msg.method === 'initialize') return handleInitialize(msg);
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') return handleToolsList(msg);
  if (msg.method === 'tools/call') return handleToolCall(msg);
  if (msg.id !== undefined) {
    respondError(msg.id, -32601, `method not found: ${msg.method}`);
  }
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
      log(`parse error: ${err.message}`);
      continue;
    }
    handleMessage(msg);
  }
});

process.stdin.on('end', () => process.exit(0));
