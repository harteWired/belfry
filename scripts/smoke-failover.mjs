/**
 * #38 Phase 1 — live-ish failover smoke test (no real Telegram, no real boxes).
 *
 * Stands up TWO complete daemon halves in one process — host "j" (priority 1)
 * and host "e" (priority 2) — each a real Registry + real wireFederation (real
 * /fed gossip over loopback) + real TelegramOwner + real Poller + the real
 * priority gate. Only Telegram itself is mocked: a single shared "bot" with a
 * 409 lease, so ownership is genuinely exclusive and we can see who holds it.
 *
 * It exercises the exact behaviour Phase 1 adds, end-to-end:
 *   1. Converge — both start; the gate makes j (higher priority) own the bot and
 *      e stand by (never polls).
 *   2. Egress-dead failover — j's Telegram path "dies" (its poll throws) but j
 *      keeps gossiping; j's reachableAt goes stale → e takes over. THIS is the
 *      weekend-outage case the old mesh-aliveness design got wrong.
 *   3. Handback — j's Telegram path recovers (it now gets a 409 from e, which
 *      still counts as reachable) → e yields → j reclaims.
 *
 * Run: node scripts/smoke-failover.mjs   (exits 0 = all phases passed)
 */

import { Registry } from '../lib/registry.js';
import { wireFederation } from '../lib/federation-daemon.js';
import { Poller } from '../lib/poller.js';
import { TelegramOwner } from '../lib/federation-owner.js';
import { ReplyTracker } from '../lib/reply-tracker.js';
import { createServer } from 'node:http';

const TOKEN = 'smoke-mesh-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Mock Telegram: ONE bot, a single-owner getUpdates lease (whoever is actively
 * polling holds it; a concurrent poller gets 409 — the real exclusivity). The
 * lease frees if its holder stops re-polling within LEASE_MS. `fetchFor(who)`
 * gives each daemon a fetchFn that also lets us simulate that host's egress
 * dying via the `dead` flag.
 */
function makeMockTelegram() {
  const LEASE_MS = 300;
  let holder = null, leaseAt = 0;
  const polls = { j: 0, e: 0 };
  const dead = { j: false, e: false };
  const fetchFor = (who) => async (url) => {
    if (dead[who]) throw new Error(`mock: ${who} egress dead`);
    if (url.includes('getUpdates') && !url.includes('offset=-1')) {
      const now = Date.now();
      if (holder && holder !== who && now - leaseAt > LEASE_MS) holder = null; // stale lease frees
      if (holder && holder !== who) return { ok: false, status: 409, text: async () => 'Conflict' };
      holder = who; leaseAt = now; polls[who]++;
      await sleep(50); // short long-poll
      if (holder === who) leaseAt = Date.now();
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: [] }) }; // primeOffset etc.
  };
  return { fetchFor, polls, dead, holder: () => holder };
}

async function makeHost({ letter, priority, peerLetter, peerPort, port, mock }) {
  const registry = new Registry({ port: 0, authToken: null });
  await registry.start();
  const owner = new TelegramOwner({ standbyIntervalMs: 40, errorBackoffMs: 40 });
  const fed = await wireFederation({
    registry, port, owner,
    gossipIntervalMs: 40,
    ownerConfirmTtlMs: 250, // small so the egress-dead case fails over fast in the demo
    fedConfig: {
      enabled: true, hostLetter: letter, hostName: letter.toUpperCase(), token: TOKEN, priority,
      peers: [{ letter: peerLetter, name: peerLetter.toUpperCase(), addr: `http://127.0.0.1:${peerPort}`, priority: priority === 1 ? 2 : 1 }],
    },
  });
  const poller = new Poller({
    botToken: 'SHARED-BOT', expectedChatId: 1, replyTracker: new ReplyTracker(),
    target: registry, owner, isPreempted: fed.isPreempted,
    fetchFn: mock.fetchFor(letter), longPollSeconds: 1,
  });
  return { registry, fed, owner, poller, letter };
}

async function waitFor(label, cond, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

function pollDelta(mock) {
  const before = { ...mock.polls };
  return async (ms = 250) => { await sleep(ms); return { j: mock.polls.j - before.j, e: mock.polls.e - before.e }; };
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const mock = makeMockTelegram();
  const [portJ, portE] = await Promise.all([freePort(), freePort()]);
  const j = await makeHost({ letter: 'j', priority: 1, peerLetter: 'e', peerPort: portE, port: portJ, mock });
  const e = await makeHost({ letter: 'e', priority: 2, peerLetter: 'j', peerPort: portJ, port: portE, mock });

  j.fed.startGossip(); e.fed.startGossip();
  j.poller.start(); e.poller.start();

  try {
    // ── Phase 1: converge ──────────────────────────────────────────────────
    console.log('\nPhase 1 — converge (j priority 1 should own, e should stand by)');
    await waitFor('j holds the bot', () => mock.holder() === 'j');
    await sleep(300); // let the gate settle
    check('j owns the bot', mock.holder() === 'j');
    check('e is preempted (standing by)', e.fed.isPreempted() === true);
    check('j is not preempted (it is the top priority)', j.fed.isPreempted() === false);
    let d = await pollDelta(mock)(250);
    check('only j is polling Telegram', d.j > 0 && d.e === 0, `polls j=${d.j} e=${d.e}`);

    // ── Phase 2: egress-dead failover (the weekend-outage case) ─────────────
    console.log('\nPhase 2 — j\'s Telegram egress dies but j keeps gossiping (e must take over)');
    mock.dead.j = true; // j's poll now throws; j keeps announcing, but reachableAt freezes
    await waitFor('e takes the bot', () => mock.holder() === 'e');
    check('e now owns the bot', mock.holder() === 'e');
    check('e is no longer preempted', e.fed.isPreempted() === false);
    d = await pollDelta(mock)(250);
    check('e is now the one polling', d.e > 0, `polls j=${d.j} e=${d.e}`);

    // ── Phase 3: handback ──────────────────────────────────────────────────
    console.log('\nPhase 3 — j\'s egress recovers (it now gets 409 from e → reachable again → handback)');
    mock.dead.j = false; // j reaches Telegram again; e holds the lease so j gets 409 (still "reachable")
    await waitFor('j reclaims the bot', () => mock.holder() === 'j');
    await sleep(300);
    check('j owns the bot again', mock.holder() === 'j');
    check('e is preempted again', e.fed.isPreempted() === true);
    d = await pollDelta(mock)(250);
    check('only j is polling again', d.j > 0 && d.e === 0, `polls j=${d.j} e=${d.e}`);
  } finally {
    await Promise.all([j.poller.stop(), e.poller.stop()]);
    await Promise.all([j.fed.stop(), e.fed.stop()]);
    await Promise.all([j.registry.stop(), e.registry.stop()]);
  }

  console.log(`\n${failures === 0 ? '✅ SMOKE TEST PASSED' : `❌ SMOKE TEST FAILED (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\n❌ SMOKE TEST ERROR:', err.message); process.exit(1); });
