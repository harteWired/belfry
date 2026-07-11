/**
 * Loopback integration test for the federation wiring (#29, Phase A).
 *
 * Stands up TWO complete daemon halves on 127.0.0.1 — host "j" (Jinn) and host
 * "e" (Erebus) — each a real Registry + a real wireFederation() (fail-closed
 * /fed/* server + mesh client + peer registry + gossip + send_to router). No
 * Telegram, no spokes, no network beyond loopback. This exercises the entire
 * cross-machine data plane end-to-end: gossip discovery, bare + host-qualified
 * routing, ambiguity rejection, local fall-through, and the registry's /send-to
 * HTTP seam forwarding over the mesh and delivering with agent provenance.
 *
 * The real boxes (Erebus over Tailscale) are Phase B; the address-agnostic
 * client/server mean a green run here is the de-risk before any deploy.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Registry } from '../lib/registry.js';
import { wireFederation } from '../lib/federation-daemon.js';

const TOKEN = 'test-mesh-token';

/** Grab an OS-assigned free loopback port (closed before reuse). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** White-box register: insert a fake live session so deliveries land on its queue. */
function fakeSession(registry, slug, id = `inst-${slug}`) {
  const inst = { slug, cwd: '/tmp', pid: 1, queue: [], waiter: null, lastSeen: Date.now() };
  registry.instances.set(id, inst);
  if (!registry.bySlug.has(slug)) registry.bySlug.set(slug, new Set());
  registry.bySlug.get(slug).add(id);
  return inst;
}

let regJ, regE, fedJ, fedE, portJ, portE;
let erebusSession;

before(async () => {
  [portJ, portE] = await Promise.all([freePort(), freePort()]);

  // Registries on ephemeral ports, no auth token (test mode → registry auth skipped).
  regJ = new Registry({ port: 0, authToken: null });
  regE = new Registry({ port: 0, authToken: null });
  await Promise.all([regJ.start(), regE.start()]);

  // Each host knows the other's /fed address from static config (gossip carries
  // slugs, not addresses — mirrors the real deployment).
  fedJ = await wireFederation({
    registry: regJ,
    port: portJ,
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'e', name: 'Erebus', addr: `http://127.0.0.1:${portE}` }],
    },
  });
  fedE = await wireFederation({
    registry: regE,
    port: portE,
    fedConfig: {
      enabled: true, hostLetter: 'e', hostName: 'Erebus', token: TOKEN,
      peers: [{ letter: 'j', name: 'Jinn', addr: `http://127.0.0.1:${portJ}` }],
    },
  });

  // A live session on Erebus, and a local one on Jinn.
  erebusSession = fakeSession(regE, 'erebus-sess');
  fakeSession(regJ, 'jinn-local');
});

after(async () => {
  await Promise.all([fedJ?.stop(), fedE?.stop()]);
  await Promise.all([regJ?.stop(), regE?.stop()]);
});

test('gossip: e announces its slugs and j learns e owns erebus-sess', async () => {
  const result = await fedE.announceOnce();
  assert.equal(result.reached, 1, 'e should reach its one peer (j)');
  const owners = fedJ.peerRegistry.ownerMap(regJ.knownSlugs());
  assert.ok(owners.get('erebus-sess')?.has('e'), 'j should now know e owns erebus-sess');
  // j still owns its own local slug in the merged view.
  assert.ok(owners.get('jinn-local')?.has('j'));
});

test('remoteSlugs() lists peer slugs qualified, excluding this host (#47 Tier 1)', async () => {
  await fedE.announceOnce(); // j learns e's slugs
  const remote = fedJ.remoteSlugs();
  assert.ok(remote.includes('e/erebus-sess'), 'j should see e/erebus-sess as a remote slug');
  assert.ok(!remote.some((s) => s.startsWith('j/')), 'j must not list its own slugs as remote');
});

test('bare-slug send_to forwards across the mesh and delivers with agent provenance', async () => {
  await fedE.announceOnce(); // ensure j knows the owner
  const before = erebusSession.queue.length;
  const r = await fedJ.relayRemote('jinn-local', 'erebus-sess', 'ping from jinn');
  assert.deepEqual(
    { handled: r.handled, ok: r.ok, delivered: r.delivered, host: r.host },
    { handled: true, ok: true, delivered: 1, host: 'e' },
  );
  const item = erebusSession.queue[before];
  assert.equal(item.text, 'ping from jinn');
  assert.equal(item.origin, 'agent');
  assert.equal(item.from, 'j/jinn-local', 'sender is surfaced host-qualified so the reply can route back');
});

test('host-qualified target forwards even with no gossip about it', async () => {
  const before = erebusSession.queue.length;
  const r = await fedJ.relayRemote('jinn-local', 'e/erebus-sess', 'explicit route');
  assert.equal(r.ok, true);
  assert.equal(r.host, 'e');
  assert.equal(erebusSession.queue[before].text, 'explicit route');
});

test('qualified target to a peer with no such live session → delivered:0 (not an error)', async () => {
  const r = await fedJ.relayRemote('jinn-local', 'e/ghost', 'anyone home?');
  assert.equal(r.handled, true);
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 0, 'peer is reachable but has no session for that slug');
});

test('local target falls through to local delivery (handled:false)', async () => {
  const r = await fedJ.relayRemote('peer', 'jinn-local', 'stay local');
  assert.equal(r.handled, false, 'a slug we own is the local relay path, not a mesh forward');
  assert.equal(r.localSlug, 'jinn-local');
});

test('SELF-qualified target falls through with the BARE slug (j/x on host j)', async () => {
  const r = await fedJ.relayRemote('peer', 'j/jinn-local', 'stay local, qualified');
  assert.equal(r.handled, false);
  assert.equal(r.localSlug, 'jinn-local', 'caller must deliver under the bare slug the local index knows');
});

test('unknown bare slug falls through to local (same offline signal)', async () => {
  const r = await fedJ.relayRemote('peer', 'nobody-knows-this', 'hello?');
  assert.equal(r.handled, false);
});

test('ambiguous bare slug is rejected with candidates to qualify', async () => {
  // Both hosts own a slug named "build": e announces it, j has it locally.
  fakeSession(regE, 'build');
  fakeSession(regJ, 'build');
  await fedE.announceOnce();
  const r = await fedJ.relayRemote('jinn-local', 'build', 'which one?');
  assert.equal(r.handled, true);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.deepEqual(r.candidates.sort(), ['e/build', 'j/build']);
});

test('webhook bridge: mesh message → webhook POST, then /bridge/reply routes back to sender', async () => {
  // Stand up a host "s" (NAS) whose `life-planner` slug is a webhook bridge, and
  // a host "j" that sends to it. Full round-trip: j → s/life-planner (POSTed to
  // the agent's webhook) → agent replies via /bridge/reply → back to j's session.
  const [pJ, pS, pHook] = await Promise.all([freePort(), freePort(), freePort()]);

  // Fake headless agent: captures the POSTed envelope, answers 200.
  let captured = null;
  const hook = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      captured = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => hook.listen(pHook, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${pHook}/api/inbox`;

  const rJ = new Registry({ port: 0, authToken: null });
  const rS = new Registry({ port: 0, authToken: null });
  await Promise.all([rJ.start(), rS.start()]);
  const fS = await wireFederation({
    registry: rS, port: pS,
    bridges: new Map([['life-planner', hookUrl]]),
    fedConfig: { enabled: true, hostLetter: 's', hostName: 'Severin', token: TOKEN,
      peers: [{ letter: 'j', name: 'Jinn', addr: `http://127.0.0.1:${pJ}` }] },
  });
  const fJ = await wireFederation({
    registry: rJ, port: pJ,
    fedConfig: { enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 's', name: 'Severin', addr: `http://127.0.0.1:${pS}` }] },
  });
  const asker = fakeSession(rJ, 'asker');

  try {
    // j → s/life-planner: forwarded over the mesh, delivered to the webhook.
    const r = await fJ.relayRemote('asker', 's/life-planner', 'what should I cook?');
    assert.equal(r.ok, true);
    assert.equal(r.delivered, 1, 'bridge counts a webhook POST as delivered');
    assert.ok(captured, 'webhook received a POST');
    assert.equal(captured.text, 'what should I cook?');
    assert.deepEqual(captured.from, { host: 'j', slug: 'asker' }, 'envelope carries the original sender');
    assert.ok(captured.correlationId, 'envelope carries a correlation id for the reply');

    // The agent replies asynchronously via /bridge/reply on its local daemon (s).
    const res = await fetch(`http://127.0.0.1:${rS.port}/bridge/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ correlationId: captured.correlationId, text: 'try the risotto' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.to, 'j/asker', 'reply routed back to the original sender');

    // The asker session on j received the reply as an agent message from the bridge.
    const item = asker.queue[asker.queue.length - 1];
    assert.equal(item.text, 'try the risotto');
    assert.equal(item.origin, 'agent');
    assert.equal(item.from, 's/life-planner');

    // A stale/unknown correlation id is rejected (single-consume).
    const res2 = await fetch(`http://127.0.0.1:${rS.port}/bridge/reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ correlationId: captured.correlationId, text: 'again?' }),
    });
    assert.equal(res2.status, 404, 'consumed correlation cannot be reused');
  } finally {
    await Promise.all([fJ.stop(), fS.stop()]);
    await Promise.all([rJ.stop(), rS.stop()]);
    await new Promise((r) => hook.close(r));
  }
});

test('registry /send-to HTTP seam forwards a host-qualified target over the mesh', async () => {
  // Register a sender instance on Jinn's registry and drive the real HTTP route,
  // proving the relaxed to_slug regex + federationRouter wiring (not just the
  // closure in isolation).
  const senderId = 'sender-http';
  fakeSession(regJ, 'jinn-local', senderId); // adds another instance under jinn-local; fine for sender lookup
  const before = erebusSession.queue.length;
  const res = await fetch(`http://127.0.0.1:${regJ.port}/send-to`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instance_id: senderId, to_slug: 'e/erebus-sess', text: 'via http' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.remote, true);
  assert.equal(body.host, 'e');
  assert.equal(erebusSession.queue[before].text, 'via http');
});

test('telegram bridge: human→federated-session DM round-trips both legs (#44)', async () => {
  // J runs a telegram bridge (slug "telegram"); E runs a real session. Forward
  // leg: the bot relays a Telegram message from the bridge to e/erebus-sess.
  // Reply leg: the session answers via the mesh to j/telegram, and J's onMessage
  // hands it to the bridge (which is what posts it to the chat in production).
  const [pA, pB] = await Promise.all([freePort(), freePort()]);
  const captured = [];
  const rJ2 = new Registry({ port: 0, authToken: null });
  const rE2 = new Registry({ port: 0, authToken: null });
  await Promise.all([rJ2.start(), rE2.start()]);
  const fJ2 = await wireFederation({
    registry: rJ2, port: pA,
    telegramBridge: {
      slug: 'telegram',
      deliver: (fromQualified, text) => { captured.push({ from: fromQualified, text }); return { delivered: 1 }; },
    },
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'e', name: 'Erebus', addr: `http://127.0.0.1:${pB}` }],
    },
  });
  const fE2 = await wireFederation({
    registry: rE2, port: pB,
    fedConfig: {
      enabled: true, hostLetter: 'e', hostName: 'Erebus', token: TOKEN,
      peers: [{ letter: 'j', name: 'Jinn', addr: `http://127.0.0.1:${pA}` }],
    },
  });
  const sess = fakeSession(rE2, 'erebus-sess');
  try {
    // Forward leg: /keeper resolves to e/erebus-sess; the bot relays it FROM the
    // bridge so the session's reply has somewhere to go.
    const fwd = await fJ2.relayRemote('telegram', 'e/erebus-sess', 'hi from the human');
    assert.equal(fwd.ok, true);
    assert.equal(fwd.delivered, 1);
    const item = sess.queue[sess.queue.length - 1];
    assert.equal(item.text, 'hi from the human');
    assert.equal(item.from, 'j/telegram', 'session sees the bridge as the sender, so it can reply back');

    // Reply leg: the session answers j/telegram; J routes it to the bridge, not
    // a (nonexistent) local "telegram" session.
    const back = await fE2.relayRemote('erebus-sess', 'j/telegram', 'pong to the chat');
    assert.equal(back.ok, true);
    assert.equal(back.delivered, 1, 'the bridge counts the chat post as delivered');
    assert.deepEqual(captured.at(-1), { from: 'e/erebus-sess', text: 'pong to the chat' });
  } finally {
    await Promise.all([fJ2.stop(), fE2.stop()]);
    await Promise.all([rJ2.stop(), rE2.stop()]);
  }
});

test('gossip propagates a host owner reachableAt to the peer (#38 advertising path)', async () => {
  // A self-contained pair with owners, so we exercise the announceOnce →
  // buildEnvelope(reachableAt) → onAnnounce → PeerRegistry.reachableAt seam
  // end-to-end (the existing fedJ/fedE were wired without owners).
  const [pA, pB] = await Promise.all([freePort(), freePort()]);
  const stamp = Date.now(); // fresh so it's within the confirm TTL under the real clock
  const ownerA = { reachableAt: stamp }; // pretend A's poller just reached Telegram
  const rA = new Registry({ port: 0, authToken: null });
  const rB = new Registry({ port: 0, authToken: null });
  await Promise.all([rA.start(), rB.start()]);
  const fA = await wireFederation({
    registry: rA, port: pA, owner: ownerA,
    fedConfig: {
      enabled: true, hostLetter: 'a', hostName: 'A', token: TOKEN, priority: 1,
      peers: [{ letter: 'b', name: 'B', addr: `http://127.0.0.1:${pB}`, priority: 2 }],
    },
  });
  const fB = await wireFederation({
    registry: rB, port: pB, owner: { reachableAt: 0 },
    fedConfig: {
      enabled: true, hostLetter: 'b', hostName: 'B', token: TOKEN, priority: 2,
      peers: [{ letter: 'a', name: 'A', addr: `http://127.0.0.1:${pA}`, priority: 1 }],
    },
  });
  try {
    await fA.announceOnce();
    assert.equal(fB.peerRegistry.peer('a')?.reachableAt, stamp, 'B learns A reachableAt');
    // B (priority 2) sees a live, recently-reachable higher-priority peer A → preempted.
    assert.equal(fB.isPreempted(), true);
    // A (priority 1, top) is never preempted regardless.
    assert.equal(fA.isPreempted(), false);
  } finally {
    await Promise.all([fA.stop(), fB.stop()]);
    await Promise.all([rA.stop(), rB.stop()]);
  }
});

test('forwardInbound: owner J forwards a human msg → E delivers as human + sets remote marker (#38 P2)', async () => {
  await fedE.announceOnce(); // J learns E owns erebus-sess
  const before = erebusSession.queue.length;
  const r = await fedJ.forwardInbound('erebus-sess', 'hi from matt', { chatId: 8471234222, originatingMessageId: 3100 });
  assert.equal(r.forwarded, true, 'J reports the inbound forwarded');
  assert.equal(erebusSession.queue.length, before + 1, 'E session received it via the human deliver path');
  // E set the REMOTE owes-reply marker carrying J's Telegram context (so the
  // session's reply can direct-send back), NOT a local marker.
  const m = regE.getRemoteOwesReply('erebus-sess');
  assert.ok(m, 'E has a remote owes-reply marker');
  assert.equal(m.ownerHost, 'j');
  assert.equal(m.chatId, 8471234222);
  assert.equal(m.originatingMessageId, 3100);
  regE.clearRemoteOwesReply('erebus-sess');
});

test('forwardInbound returns forwarded:false for a slug no live peer owns', async () => {
  const r = await fedJ.forwardInbound('nobody-owns-this', 'x', { chatId: 1, originatingMessageId: 2 });
  assert.equal(r.forwarded, false);
});

// ── reply-map sync: the Fornax-flip prerequisite (#38). A host that pings a
// LOCAL session gossips the message_id→slug anchor so whichever host owns the
// bot can resolve a quote-reply to that ping and forward it back. Uses a fresh
// pair so the RECEIVER (the bot owner) can capture what it records.
test('reply-map sync: source X gossips a local anchor → owner Y records it host-qualified', async () => {
  const [pX, pY] = await Promise.all([freePort(), freePort()]);
  const rX = new Registry({ port: 0, authToken: null });
  const rY = new Registry({ port: 0, authToken: null });
  await Promise.all([rX.start(), rY.start()]);
  const recorded = []; // Y is the (sessionless) bot owner — captures synced anchors
  const fX = await wireFederation({
    registry: rX, port: pX,
    fedConfig: {
      enabled: true, hostLetter: 'x', hostName: 'X', token: TOKEN,
      peers: [{ letter: 'y', name: 'Y', addr: `http://127.0.0.1:${pY}` }],
    },
  });
  const fY = await wireFederation({
    registry: rY, port: pY,
    recordReplyMap: (msgId, qslug) => recorded.push([msgId, qslug]),
    fedConfig: {
      enabled: true, hostLetter: 'y', hostName: 'Y', token: TOKEN,
      peers: [{ letter: 'x', name: 'X', addr: `http://127.0.0.1:${pX}` }],
    },
  });
  try {
    fakeSession(rX, 'x-sess'); // a live local session on X
    await fX.syncReplyMap(5001, 'x-sess');
    assert.deepEqual(recorded, [[5001, 'x/x-sess']], 'Y records the anchor as <sourceHost>/<slug>');

    // Guard: a slug with no live local session on X never syncs (a forwarded
    // quote-reply would land on nothing).
    await fX.syncReplyMap(5002, 'ghost-slug');
    // Guard: an already-qualified slug (bridge return-leg / daemon send) is skipped.
    await fX.syncReplyMap(5003, 'y/remote');
    // Guard: a non-integer message id is skipped (record() would reject it too).
    await fX.syncReplyMap(undefined, 'x-sess');
    assert.deepEqual(recorded, [[5001, 'x/x-sess']], 'guards suppressed all three — still one anchor');
  } finally {
    await Promise.all([fX.stop(), fY.stop()]);
    await Promise.all([rX.stop(), rY.stop()]);
  }
});

// The end-to-end loop: a synced anchor recorded into a REAL ReplyTracker on the
// owner resolves a quote-reply to `<host>/<slug>`, which is exactly the shape
// the inbound delivery target forwards back over the mesh (#38 P2). This binds
// the resolution half (this feature) to the delivery half (forwardInbound).
test('reply-map sync feeds a real ReplyTracker so the owner resolves a remote quote-reply', async () => {
  const { ReplyTracker } = await import('../lib/reply-tracker.js');
  const [pX, pY] = await Promise.all([freePort(), freePort()]);
  const rX = new Registry({ port: 0, authToken: null });
  const rY = new Registry({ port: 0, authToken: null });
  await Promise.all([rX.start(), rY.start()]);
  const ownerTracker = new ReplyTracker(); // in-memory (no persistPath)
  const fX = await wireFederation({
    registry: rX, port: pX,
    fedConfig: {
      enabled: true, hostLetter: 'x', hostName: 'X', token: TOKEN,
      peers: [{ letter: 'y', name: 'Y', addr: `http://127.0.0.1:${pY}` }],
    },
  });
  const fY = await wireFederation({
    registry: rY, port: pY,
    recordReplyMap: (msgId, qslug) => ownerTracker.record(msgId, qslug),
    fedConfig: {
      enabled: true, hostLetter: 'y', hostName: 'Y', token: TOKEN,
      peers: [{ letter: 'x', name: 'X', addr: `http://127.0.0.1:${pX}` }],
    },
  });
  try {
    fakeSession(rX, 'x-sess');
    await fX.syncReplyMap(7777, 'x-sess');
    // The owner's tracker now resolves the quote-reply to a federation address.
    assert.equal(ownerTracker.lookup(7777), 'x/x-sess');
  } finally {
    await Promise.all([fX.stop(), fY.stop()]);
    await Promise.all([rX.stop(), rY.stop()]);
  }
});

test('/fed/broadcast: allowlisted mesh agent triggers the local fan-out (wintermute-only policy)', async () => {
  const reg = new Registry({ port: 0, authToken: null });
  await reg.start();
  fakeSession(reg, 'alpha', 'bc-a');
  const calls = [];
  const fed = await wireFederation({
    registry: reg,
    port: await freePort(),
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'w', name: 'Wintermute', addr: 'http://127.0.0.1:1' }],
      broadcastHosts: ['w'],
    },
    onFedBroadcast: async ({ text, targetSlugs, from }) => {
      calls.push({ text, targetSlugs, from });
      return { count: 1, slugs: ['alpha'] };
    },
  });
  const res = await fetch(`http://127.0.0.1:${fed.port}/fed/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ v: 1, kind: 'broadcast', from: { host: 'w', slug: 'wintermute' }, text: 'fleet: report status', ts: 1 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.delivered, 1);
  assert.deepEqual(calls, [{ text: 'fleet: report status', targetSlugs: null, from: 'w/wintermute' }]);
  await fed.stop();
  await reg.stop();
});

test('/fed/broadcast: a host NOT in broadcastHosts is refused even with a valid mesh token', async () => {
  const reg = new Registry({ port: 0, authToken: null });
  await reg.start();
  let called = false;
  const fed = await wireFederation({
    registry: reg,
    port: await freePort(),
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'e', name: 'Erebus', addr: 'http://127.0.0.1:1' }],
      broadcastHosts: ['w'], // e is a fleet member, but not broadcast-authorized
    },
    onFedBroadcast: async () => { called = true; return { count: 0, slugs: [] }; },
  });
  const res = await fetch(`http://127.0.0.1:${fed.port}/fed/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ v: 1, kind: 'broadcast', from: { host: 'e', slug: 'rogue-script' }, text: 'spam', ts: 1 }),
  });
  const body = await res.json();
  assert.equal(body.accepted, false);
  assert.match(body.reason, /not broadcast-authorized/);
  assert.equal(called, false, 'the daemon broadcast orchestrator must never run for an unauthorized host');
  await fed.stop();
  await reg.stop();
});

test('/fed/broadcast: default (no broadcastHosts) refuses everyone', async () => {
  const reg = new Registry({ port: 0, authToken: null });
  await reg.start();
  const fed = await wireFederation({
    registry: reg,
    port: await freePort(),
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'w', name: 'Wintermute', addr: 'http://127.0.0.1:1' }],
    },
    onFedBroadcast: async () => ({ count: 0, slugs: [] }),
  });
  const res = await fetch(`http://127.0.0.1:${fed.port}/fed/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ v: 1, kind: 'broadcast', from: { host: 'w', slug: 'wintermute' }, text: 'x', ts: 1 }),
  });
  assert.equal((await res.json()).accepted, false);
  await fed.stop();
  await reg.stop();
});

test('/fed/inbound with a photo attachment: receiving host downloads it and delivers image_path (#41)', async () => {
  const reg = new Registry({ port: 0, authToken: null });
  await reg.start();
  const sess = fakeSession(reg, 'web-design-pipeline', 'att-a');
  const downloads = [];
  const fed = await wireFederation({
    registry: reg,
    port: await freePort(),
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'f', name: 'Fornax', addr: 'http://127.0.0.1:1' }],
    },
    downloadAttachment: async (a) => { downloads.push(a); return `/local/att/photo-fed-1.jpg`; },
  });
  const res = await fetch(`http://127.0.0.1:${fed.port}/fed/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      v: 1, kind: 'inbound', from: { host: 'f' }, to: { host: 'j', slug: 'web-design-pipeline' },
      text: 'use this hero image', correlationId: 'corr-att', chatId: 42, originatingMessageId: 900,
      attachment: { fileId: 'AgFAKEPHOTO', kind: 'photo' }, ts: 1,
    }),
  });
  assert.equal((await res.json()).delivered, 1);
  assert.deepEqual(downloads, [{ fileId: 'AgFAKEPHOTO', kind: 'photo' }]);
  assert.equal(sess.queue.length, 1);
  assert.equal(sess.queue[0].text, 'use this hero image');
  assert.equal(sess.queue[0].image_path, '/local/att/photo-fed-1.jpg');
  await fed.stop();
  await reg.stop();
});

test('/fed/inbound with a document attachment: local path is appended to the delivered text (#41)', async () => {
  const reg = new Registry({ port: 0, authToken: null });
  await reg.start();
  const sess = fakeSession(reg, 'api', 'att-d');
  const fed = await wireFederation({
    registry: reg,
    port: await freePort(),
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'f', name: 'Fornax', addr: 'http://127.0.0.1:1' }],
    },
    downloadAttachment: async () => '/local/att/doc-fed-2-spec.pdf',
  });
  const res = await fetch(`http://127.0.0.1:${fed.port}/fed/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      v: 1, kind: 'inbound', from: { host: 'f' }, to: { host: 'j', slug: 'api' },
      text: 'review the spec', correlationId: 'corr-doc', chatId: 42, originatingMessageId: 901,
      attachment: { fileId: 'BQFAKEDOC', kind: 'document', name: 'spec.pdf' }, ts: 1,
    }),
  });
  assert.equal((await res.json()).delivered, 1);
  assert.match(sess.queue[0].text, /review the spec/);
  assert.match(sess.queue[0].text, /"spec\.pdf" saved to \/local\/att\/doc-fed-2-spec\.pdf/);
  assert.equal(sess.queue[0].image_path, undefined);
  await fed.stop();
  await reg.stop();
});

test('/fed/inbound attachment download failure degrades to text-only delivery, never blocks (#41)', async () => {
  const reg = new Registry({ port: 0, authToken: null });
  await reg.start();
  const sess = fakeSession(reg, 'api', 'att-f');
  const logs = [];
  const fed = await wireFederation({
    registry: reg,
    port: await freePort(),
    log: (m) => logs.push(m),
    fedConfig: {
      enabled: true, hostLetter: 'j', hostName: 'Jinn', token: TOKEN,
      peers: [{ letter: 'f', name: 'Fornax', addr: 'http://127.0.0.1:1' }],
    },
    downloadAttachment: async () => { throw new Error('telegram 404'); },
  });
  const res = await fetch(`http://127.0.0.1:${fed.port}/fed/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      v: 1, kind: 'inbound', from: { host: 'f' }, to: { host: 'j', slug: 'api' },
      text: 'photo attached', correlationId: 'corr-fail', chatId: 42, originatingMessageId: 902,
      attachment: { fileId: 'AgGONE', kind: 'photo' }, ts: 1,
    }),
  });
  assert.equal((await res.json()).delivered, 1, 'text still delivers');
  assert.equal(sess.queue[0].text, 'photo attached');
  assert.equal(sess.queue[0].image_path, undefined);
  assert.ok(logs.some((l) => l.includes('failed to download')));
  await fed.stop();
  await reg.stop();
});
