#!/usr/bin/env node
// belfry-doctor — health check + optional self-heal for the belfry daemon.
//
// Checks, in order:
//   1. Supervisor PID alive  (from /workspace/.belfry/belfry.pid)
//   2. node belfry.js child  (scan /proc for the daemon)
//   3. belfry.log freshness  (last log line within MAX_LOG_AGE_S)
//   4. Registry reachable    (GET 127.0.0.1:<port>/ → expects 401 from a
//                              live daemon, since auth check rejects)
//
// Each check emits a `[ok]` / `[warn]` / `[fail]` line. Exit code:
//   0 — everything healthy
//   1 — at least one check failed (or a warning bubbled up)
//   2 — failures present AND --fix specified (after attempting recovery)
//
// Flags:
//   --fix       on any failure, invoke /workspace/shared/belfry-launch.sh
//               (idempotent — bails if supervisor is already alive)
//   --json      machine-readable output (one JSON object on stdout)
//   --quiet     suppress per-check lines; still exits with the right code
//
// Designed to be called manually (`belfry-doctor`) or on a /loop cadence.
// Pure node, no deps.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const RUNTIME = process.env.BELFRY_RUNTIME_DIR ?? '/workspace/.belfry';
const PIDFILE = join(RUNTIME, 'belfry.pid');
const LOGFILE = join(RUNTIME, 'belfry.log');
const LAUNCHER = '/workspace/shared/belfry-launch.sh';
const MCP_PORT = Number(process.env.BELFRY_MCP_PORT || 49876);
const MAX_LOG_AGE_S = Number(process.env.BELFRY_DOCTOR_MAX_LOG_AGE_S || 600); // 10 min default
const REGISTRY_PROBE_TIMEOUT_MS = 2000;

const args = new Set(process.argv.slice(2));
const wantFix = args.has('--fix');
const wantJson = args.has('--json');
const wantQuiet = args.has('--quiet');

const findings = []; // [{name, status: 'ok'|'warn'|'fail', detail}]
function record(name, status, detail) {
  findings.push({ name, status, detail });
  if (wantJson || wantQuiet) return;
  const tag = status === 'ok' ? '[ok]  ' : status === 'warn' ? '[warn]' : '[fail]';
  process.stdout.write(`${tag} ${name}: ${detail}\n`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readCmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return null; }
}

function readPidFile() {
  try {
    const raw = readFileSync(PIDFILE, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// `kill -0 <pid>` is insufficient as proof of life: PIDs get reused. The
// supervisor we want is a bash running our exact loop body, which
// contains the literal string `LOGFILE=/workspace/.belfry/belfry.log`
// (defined at the top of the bash -c script). Match on that. If the PID
// is reachable but has been recycled (e.g. by a claude worker), we treat
// the supervisor as dead and recommend a restart.
function isSupervisorPid(pid) {
  if (!pidAlive(pid)) return false;
  const cmdline = readCmdline(pid);
  if (cmdline === null) return false;
  // The supervisor's bash -c body assigns `LOGFILE="<path>"` near the top —
  // a literal in the script body that ends up in argv[2] of the bash
  // process. Match including the surrounding quotes for extra specificity.
  return cmdline.includes(`LOGFILE="${LOGFILE}"`);
}

// Scan /proc for `node .../bin/belfry.js`. We don't blindly trust the
// pidfile to point at the node child — the pidfile holds the supervisor,
// and we want independent confirmation the daemon itself is running.
function findDaemonPid() {
  let entries;
  try { entries = readdirSync('/proc'); } catch { return null; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const cmdline = readCmdline(name);
    if (cmdline === null) continue;
    // cmdline is NUL-separated; check for the node + bin/belfry.js combo.
    if (cmdline.includes('node\0') && cmdline.includes('/bin/belfry.js')) {
      return Number(name);
    }
  }
  return null;
}

function logFreshnessSeconds() {
  try {
    const st = statSync(LOGFILE);
    return (Date.now() - st.mtimeMs) / 1000;
  } catch {
    return null;
  }
}

async function probeRegistry() {
  // Live daemon with auth on rejects unauth'd requests at 401 — that's
  // perfect proof of life without needing the token. A daemon with no
  // auth (test mode) returns 404 for "/". Either response means the
  // registry HTTP server is up. Connection refused / timeout means down.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Host: `127.0.0.1:${MCP_PORT}` },
    });
    return { ok: res.status === 401 || res.status === 404, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function runChecks() {
  // 1. Supervisor.
  const supPid = readPidFile();
  if (supPid === null) {
    record('supervisor', 'fail', `no pidfile at ${PIDFILE}`);
  } else if (!pidAlive(supPid)) {
    record('supervisor', 'fail', `pidfile points at ${supPid} but process is dead`);
  } else if (!isSupervisorPid(supPid)) {
    record('supervisor', 'fail', `pid ${supPid} alive but cmdline doesn't match supervisor — PID likely recycled`);
  } else {
    record('supervisor', 'ok', `pid ${supPid} alive (supervisor cmdline verified)`);
  }

  // 2. Daemon child.
  const daemonPid = findDaemonPid();
  if (daemonPid === null) {
    record('daemon', 'fail', 'no `node .../bin/belfry.js` process found');
  } else {
    record('daemon', 'ok', `pid ${daemonPid} alive`);
  }

  // 3. Log freshness.
  const ageS = logFreshnessSeconds();
  if (ageS === null) {
    record('log', 'fail', `${LOGFILE} not present`);
  } else if (ageS > MAX_LOG_AGE_S) {
    record('log', 'warn', `last write ${Math.round(ageS)}s ago (> ${MAX_LOG_AGE_S}s threshold)`);
  } else {
    record('log', 'ok', `last write ${Math.round(ageS)}s ago`);
  }

  // 4. Registry HTTP probe.
  const reg = await probeRegistry();
  if (reg.ok) {
    record('registry', 'ok', `127.0.0.1:${MCP_PORT} responded ${reg.status}`);
  } else if (reg.status) {
    record('registry', 'warn', `127.0.0.1:${MCP_PORT} responded ${reg.status} (unexpected)`);
  } else {
    record('registry', 'fail', `127.0.0.1:${MCP_PORT} unreachable: ${reg.error}`);
  }
}

await runChecks();

const failed = findings.some((f) => f.status === 'fail');
const warned = findings.some((f) => f.status === 'warn');

let recovered = null;
if (failed && wantFix) {
  if (!wantQuiet) process.stdout.write(`\n[doctor] attempting recovery via ${LAUNCHER}\n`);
  const out = spawnSync(LAUNCHER, [], { stdio: wantJson || wantQuiet ? 'pipe' : 'inherit' });
  recovered = { code: out.status, signal: out.signal };
  if (!wantQuiet && !wantJson && out.status !== 0) {
    process.stdout.write(`[doctor] launcher exited ${out.status}\n`);
  }
}

if (wantJson) {
  process.stdout.write(JSON.stringify({ findings, recovered, failed, warned }) + '\n');
}

if (failed) process.exit(wantFix ? 2 : 1);
if (warned) process.exit(1);
process.exit(0);
