#!/usr/bin/env node
/**
 * belfry-broadcast — fan one message out to every registered Claude Code
 * session via the local daemon's loopback registry (#30).
 *
 * Usage:
 *   belfry-broadcast <message...>
 *   belfry-broadcast --only api,web "redeploy now"
 *   belfry-broadcast --except scratch "wrap up and commit"
 *
 * The daemon owns the Telegram side: it threads each session's reply under a
 * confirmation message and posts an aggregated roll-up when all sessions reply
 * or a timeout fires — same as a Telegram `/all`. The message is injected as
 * text the receiving model interprets, NOT a slash command.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DAEMON_BASE = (process.env.BELFRY_MCP_BASE || 'http://127.0.0.1:49876').replace(/\/$/, '');

const USAGE = `belfry-broadcast — fan a message out to every registered session

Usage:
  belfry-broadcast <message...>
  belfry-broadcast --only a,b "message"
  belfry-broadcast --except c "message"

Options:
  --only a,b      broadcast only to these slugs
  --except a,b    broadcast to all slugs except these
  -h, --help      show this help
`;

export function splitList(s) {
  if (!s) return null;
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : null;
}

export function parseArgs(argv) {
  const opts = { only: null, except: null, words: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--only') opts.only = splitList(argv[++i]);
    else if (a.startsWith('--only=')) opts.only = splitList(a.slice('--only='.length));
    else if (a === '--except') opts.except = splitList(argv[++i]);
    else if (a.startsWith('--except=')) opts.except = splitList(a.slice('--except='.length));
    else opts.words.push(a);
  }
  return opts;
}

function stateDir() {
  return (process.env.BELFRY_STATE_DIR ?? '').trim() ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'belfry');
}

function loadToken() {
  try {
    const t = readFileSync(join(stateDir(), 'registry.token'), 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.words.length === 0) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  const body = { text: opts.words.join(' ') };
  if (opts.only) body.target_slugs = opts.only;
  if (opts.except) body.exclude_slugs = opts.except;

  const token = loadToken();
  let res;
  try {
    res = await fetch(`${DAEMON_BASE}/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(`belfry-broadcast: cannot reach daemon at ${DAEMON_BASE} (${err.message})\n`);
    process.exit(2);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    process.stderr.write(`belfry-broadcast: daemon returned ${res.status} ${t.slice(0, 200)}\n`);
    process.exit(2);
  }
  const json = await res.json().catch(() => ({}));
  const count = json?.count ?? 0;
  const slugs = Array.isArray(json?.slugs) ? json.slugs : [];
  process.stdout.write(count > 0
    ? `📡 broadcast to ${count} session(s): ${slugs.join(', ')}\n`
    : '📡 broadcast — no sessions registered\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`belfry-broadcast: ${err.stack ?? err.message}\n`);
    process.exit(2);
  });
}
