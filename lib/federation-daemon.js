/**
 * Federation daemon wiring (#29). The single seam that turns the pure mesh
 * modules into a running cross-machine agent mesh and bolts them onto the
 * loopback Registry. `bin/belfry.js` calls `wireFederation` once at startup
 * when a host letter is configured; the loopback integration test calls it
 * twice (two hosts on 127.0.0.1) to exercise the whole data plane without a
 * real network or Telegram.
 *
 * What it wires:
 *   - inbound  : a fail-closed FederationServer whose /fed/announce|message|reply
 *                handlers feed the PeerRegistry / local delivery / correlation.
 *   - outbound : a `relayRemote(fromSlug, target, text)` router attached to the
 *                registry so a `send_to` for a peer-owned slug forwards over the
 *                mesh (FederationClient) instead of being dropped as "no session".
 *   - discovery: a gossip loop that announces this host's local slugs to peers.
 *
 * DESIGN: peer ADDRESSES are static operator config (the small fixed box set
 * each knows the others' Tailscale names); gossip only carries which SLUGS each
 * host currently owns. So a send resolves the owning host from the gossiped view
 * but always dials the address from config — robust to gossip lag and never
 * trusts a peer to tell us where to connect.
 */

import { PeerRegistry } from './federation-peers.js';
import { CorrelationTracker } from './correlation-tracker.js';
import { FederationClient } from './federation-client.js';
import { FederationServer } from './federation-server.js';
import { buildEnvelope } from './federation-envelope.js';
import { resolveTarget } from './federation-address.js';
import { postToWebhook } from './bridge.js';

export const DEFAULT_FED_PORT = 49878;
export const DEFAULT_GOSSIP_INTERVAL_MS = 30_000;

/**
 * @param {object}   opts
 * @param {object}   opts.registry        the loopback Registry (knownSlugs / relayAgentMessage / setFederationRouter)
 * @param {object}   opts.fedConfig       parsed, ENABLED config from parseFederationConfig() ({ hostLetter, hostName, token, peers })
 * @param {object}   [opts.relayGuard]    shared AgentRelayGuard — bounds outbound remote relays like local ones
 * @param {Function} [opts.fetchImpl]     injected fetch (tests)
 * @param {string}   [opts.bind]          /fed/* bind address (the tailnet iface in prod; 127.0.0.1 default/tests)
 * @param {number}   [opts.port]          /fed/* port (0 → ephemeral, for tests)
 * @param {number}   [opts.gossipIntervalMs]
 * @param {Function} [opts.now]           clock for the PeerRegistry (tests)
 * @param {Function} [opts.log]
 */
export async function wireFederation({
  registry,
  fedConfig,
  relayGuard = null,
  bridges = new Map(),
  fetchImpl = globalThis.fetch,
  bind = '127.0.0.1',
  port = DEFAULT_FED_PORT,
  gossipIntervalMs = DEFAULT_GOSSIP_INTERVAL_MS,
  now = () => Date.now(),
  log = () => {},
}) {
  const { hostLetter: selfLetter, hostName, token, peers } = fedConfig;
  const peersByLetter = new Map(peers.map((p) => [p.letter, p]));

  const peerRegistry = new PeerRegistry({ selfLetter, now });
  const correlation = new CorrelationTracker({ log });
  const client = new FederationClient({ token, fetchImpl, log });

  // ---- inbound: /fed/* handlers ----

  // Gossip: a peer advertises the slugs it currently owns. We take the slug set
  // off the wire but the name/addr from OUR config (never trust a peer for where
  // to dial). Unknown letters (a peer not in our config) are still stored so a
  // qualified send could in theory reach them, but with addr=null they can't be
  // dialed — acceptable; the fixed box set is symmetric in practice.
  const onAnnounce = async (env) => {
    const cfg = peersByLetter.get(env.from.host);
    const applied = peerRegistry.applyAnnouncement({
      letter: env.from.host,
      name: cfg?.name ?? env.from.host,
      addr: cfg?.addr ?? null,
      slugs: env.slugs,
    });
    return { applied, slugs: env.slugs.length };
  };

  // A peer relayed an agent message addressed to one of OUR slugs. Deliver it
  // locally with agent provenance, surfacing the sender host-qualified
  // (`<host>/<slug>`) so the local model answers with send_to("<host>/<slug>")
  // and the reply routes straight back across the mesh. relayAgentMessage does
  // NOT markOwesReply, so a peer message never trips Telegram auto-reply.
  const onMessage = async (env) => {
    // Webhook bridge target (#29 Phase C): the slug is a headless agent reached
    // over HTTP, not a spoke. POST the envelope and mint a correlation so the
    // agent's async reply (via /bridge/reply) can route back to env.from.
    const webhookUrl = bridges.get(env.to.slug);
    if (webhookUrl) {
      const correlationId = correlation.open({ host: env.from.host, slug: env.from.slug, bridgeSlug: env.to.slug });
      const out = await postToWebhook(webhookUrl, { ...env, correlationId }, { fetchImpl, log });
      if (!out.ok) {
        correlation.cancel(correlationId);
        log(`bridge: ${env.to.slug} webhook delivery failed: ${out.error}`);
        return { delivered: 0, error: out.error };
      }
      log(`bridge: ${env.from.host}/${env.from.slug}→${env.to.slug} webhook ok (corr ${correlationId})`);
      return { delivered: 1, correlationId };
    }
    const fromQualified = `${env.from.host}/${env.from.slug}`;
    const result = registry.relayAgentMessage(fromQualified, env.to.slug, env.text);
    return { delivered: result.delivered ?? 0 };
  };

  // A correlated reply coming back (the bidirectional-bridge path, #36 Tier 1).
  // Session↔session messaging uses ordinary 'message' envelopes, so this only
  // fires once a correlationId has been minted (Phase C / webhook bridge). An
  // unknown or expired id has nowhere to go — drop it cleanly.
  const onReply = async (env) => {
    const origin = env.correlationId ? correlation.resolve(env.correlationId) : null;
    if (!origin) {
      log(`federation: reply for unknown correlation ${env.correlationId ?? '(none)'} — dropping`);
      return { routed: false };
    }
    if (origin.kind === 'agent' && origin.slug) {
      const result = registry.relayAgentMessage(`${env.from.host}/${env.from.slug}`, origin.slug, env.text);
      return { routed: true, delivered: result.delivered ?? 0 };
    }
    log(`federation: reply origin kind "${origin.kind}" not routable here — dropping`);
    return { routed: false };
  };

  const server = new FederationServer({ port, bind, token, log, onAnnounce, onMessage, onReply });

  // ---- outbound: the registry's /send-to router ----
  // Returns handled:false to mean "this is local (or unknown) — let the pure
  // local relay handle it"; handled:true once we've resolved the target to a
  // peer and forwarded it (or rejected it as ambiguous/invalid/unreachable).
  const relayRemote = async (fromSlug, target, text) => {
    const owners = peerRegistry.ownerMap(registry.knownSlugs());
    const r = resolveTarget(target, { selfLetter, owners });

    if (r.kind === 'invalid') return { handled: true, ok: false, status: 400, reason: r.reason };
    if (r.kind === 'ambiguous') {
      return {
        handled: true, ok: false, status: 409,
        reason: `ambiguous target "${r.slug}" — qualify with a host prefix (${r.candidates.join(', ')})`,
        candidates: r.candidates,
      };
    }
    // Bare slug nobody is known to own: fall through to local — the local relay
    // returns delivered:0 if we don't have it either, which is the same
    // "offline / unknown" signal the model already understands.
    if (r.kind === 'unknown') return { handled: false };
    // Resolved to us → local path owns it.
    if (r.local) return { handled: false };

    // Resolved to a peer → forward over the mesh.
    const peer = peersByLetter.get(r.hostLetter);
    if (!peer || !peer.addr) {
      return { handled: true, ok: false, status: 502, reason: `no configured address for host "${r.hostLetter}"` };
    }
    if (relayGuard) {
      const verdict = relayGuard.check(fromSlug, target, text);
      if (!verdict.ok) return { handled: true, ok: false, status: 429, reason: verdict.reason };
    }
    let envelope;
    try {
      envelope = buildEnvelope({
        kind: 'message',
        from: { host: selfLetter, slug: fromSlug },
        to: { host: r.hostLetter, slug: r.slug },
        text,
      });
    } catch (err) {
      return { handled: true, ok: false, status: 400, reason: err.message };
    }
    const sent = await client.send(peer, envelope);
    if (!sent.ok) {
      log(`federation: relay ${selfLetter}/${fromSlug}→${r.hostLetter}/${r.slug} failed: ${sent.error}`);
      return { handled: true, ok: false, status: 502, reason: sent.error };
    }
    let delivered = 1;
    try {
      const body = sent.body ? JSON.parse(sent.body) : null;
      if (body && typeof body.delivered === 'number') delivered = body.delivered;
    } catch { /* peer returned non-JSON — assume delivered, it answered 2xx */ }
    log(`federation: relayed ${selfLetter}/${fromSlug}→${r.hostLetter}/${r.slug} (${text.length} chars, delivered ${delivered})`);
    return { handled: true, ok: true, delivered, host: r.hostLetter };
  };

  // A webhook agent's async reply (POST /bridge/reply { correlationId, text }):
  // resolve the correlation to the original sender and route the reply back over
  // the mesh — local relay if the sender is on this host, else forward to its
  // host. The reply rides as an ordinary agent message FROM the bridge slug, so
  // the recipient sees origin="agent" from="<host>/<bridge>".
  const bridgeReply = async (correlationId, text) => {
    const origin = correlation.resolve(correlationId);
    if (!origin) return { ok: false, status: 404, reason: 'unknown or expired correlation' };
    const target = origin.host === selfLetter ? origin.slug : `${origin.host}/${origin.slug}`;
    const remote = await relayRemote(origin.bridgeSlug, target, text);
    if (remote && remote.handled) {
      return remote.ok
        ? { ok: true, delivered: remote.delivered, to: target }
        : { ok: false, status: remote.status, reason: remote.reason };
    }
    const local = registry.relayAgentMessage(origin.bridgeSlug, target, text);
    return { ok: true, delivered: local.delivered ?? 0, to: target };
  };

  // ---- discovery: gossip our local slug set to every peer ----
  const announceOnce = async () => {
    const slugs = [...registry.knownSlugs()];
    const envelope = buildEnvelope({ kind: 'announce', from: { host: selfLetter }, slugs });
    const results = await Promise.all(peers.map((p) => client.send(p, envelope)));
    return { reached: results.filter((x) => x.ok).length, total: peers.length, slugs: slugs.length };
  };

  let gossipTimer = null;
  const startGossip = (intervalMs = gossipIntervalMs) => {
    if (gossipTimer) return;
    const tick = () => {
      announceOnce().catch((err) => log(`federation: gossip round failed: ${err.message}`));
    };
    tick(); // announce immediately so peers learn our slugs without a full interval's lag
    gossipTimer = setInterval(tick, intervalMs);
    gossipTimer.unref?.();
  };

  await server.start();
  registry.setFederationRouter(relayRemote);
  if (typeof registry.setBridgeReplyHandler === 'function') registry.setBridgeReplyHandler(bridgeReply);
  log(
    `federation: host "${hostName}" (${selfLetter}) up on http://${bind}:${server.port}, ` +
    `${peers.length} peer(s): ${peers.map((p) => `${p.letter}=${p.addr}`).join(', ') || '—'}` +
    (bridges.size ? `, ${bridges.size} bridge(s): ${[...bridges.keys()].join(', ')}` : ''),
  );

  const stop = async () => {
    if (gossipTimer) { clearInterval(gossipTimer); gossipTimer = null; }
    correlation.cancelAll();
    registry.setFederationRouter(null);
    await server.stop();
  };

  return {
    server, client, peerRegistry, correlation,
    relayRemote, bridgeReply, announceOnce, startGossip, stop,
    selfLetter, port: server.port,
  };
}
