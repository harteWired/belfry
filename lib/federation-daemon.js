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
// How fresh a higher-priority peer's `reachableAt` must be for us to yield the
// bot to it (#38). It rides the gossip announcement (30s cadence), so this must
// comfortably exceed one gossip interval to tolerate a missed round without a
// false promotion — and it bounds failover latency for the egress-dead case
// (the peer is up on the mesh but stops reaching Telegram, so reachableAt ages
// out and we take over). A dedicated faster heartbeat is GitHub #42.
export const OWNER_CONFIRM_TTL_MS = 90_000;

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
  // Telegram bridge (#44): { slug, deliver(fromQualified, text) → { delivered } }.
  // When a peer messages this slug, it isn't a local session — it's the human
  // over Telegram, so the message is handed to `deliver` (which posts it to the
  // chat) instead of the local registry. This is the return leg of a
  // human→federated-session DM.
  telegramBridge = null,
  owner = null, // TelegramOwner (#38) — source of our `reachableAt` for gossip + the gate
  ownerConfirmTtlMs = OWNER_CONFIRM_TTL_MS,
  // #38 Fornax-flip prerequisite. A peer's gossiped reply-tracker anchor lands
  // here so the bot owner can resolve a quote-reply to a remote ping. Injected
  // by the daemon as (messageId, '<host>/<slug>') → replyTracker.record(...).
  // Null on a node with no Telegram role (fed-only) — nothing to resolve.
  recordReplyMap = null,
  fetchImpl = globalThis.fetch,
  bind = '127.0.0.1',
  port = DEFAULT_FED_PORT,
  gossipIntervalMs = DEFAULT_GOSSIP_INTERVAL_MS,
  now = () => Date.now(),
  log = () => {},
  // Wintermute message-flow tap (#49): (kind, fields) => void, metadata only,
  // fire-and-forget. Null = off, zero behavior change.
  tap = null,
}) {
  const { hostLetter: selfLetter, hostName, token, peers, priority: selfPriority = null } = fedConfig;
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
      reachableAt: env.reachableAt ?? 0, // #38: peer's last-reached-Telegram stamp
    });
    tap?.('gossip-recv', { from: env.from.host, slugs: env.slugs.length });
    return { applied, slugs: env.slugs.length };
  };

  // A peer relayed an agent message addressed to one of OUR slugs. Deliver it
  // locally with agent provenance, surfacing the sender host-qualified
  // (`<host>/<slug>`) so the local model answers with send_to("<host>/<slug>")
  // and the reply routes straight back across the mesh. relayAgentMessage does
  // NOT markOwesReply, so a peer message never trips Telegram auto-reply.
  const onMessage = async (env) => {
    // Telegram bridge target (#44): the slug is the local Telegram identity, not
    // a session. A peer messaging it is a federated session replying to a
    // human→peer DM — hand it to the bridge so it posts to the chat (and records
    // the reply-tracker mapping so a quote-reply continues the thread).
    if (telegramBridge && env.to.slug === telegramBridge.slug) {
      const fromQualified = `${env.from.host}/${env.from.slug}`;
      try {
        const out = await telegramBridge.deliver(fromQualified, env.text);
        return { delivered: out?.delivered ?? 1 };
      } catch (err) {
        log(`telegram-bridge: deliver from ${fromQualified} failed: ${err.message}`);
        return { delivered: 0, error: err.message };
      }
    }
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
      // The registry never sees a webhook-bridge delivery — tap it here (#49).
      tap?.('fed-recv', { from: `${env.from.host}/${env.from.slug}`, to: env.to.slug, bridged: true, chars: env.text?.length ?? 0 });
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

  // #38 Phase 2 — REMOTE side. A forwarded human message landed for one of our
  // local slugs. Deliver via the HUMAN path (null originatingMessageId, so no
  // LOCAL owes-reply marker), then set the REMOTE owes-reply marker carrying the
  // owner's Telegram context so the session's answer direct-sends back itself.
  const onInbound = async (env) => {
    const n = registry.deliver(env.to.slug, env.text, null);
    if (n > 0) {
      registry.markRemoteOwesReply(env.to.slug, {
        ownerHost: env.from.host,
        correlationId: env.correlationId,
        chatId: env.chatId,
        originatingMessageId: env.originatingMessageId,
      });
    }
    return { delivered: n };
  };

  // #38 Fornax-flip prerequisite — REMOTE side. A peer synced a reply-tracker
  // anchor for one of ITS local sessions (it pinged that session; the quote-
  // reply may land HERE if we own the bot now or after failover). Record it
  // host-qualified so a lookup yields `<peer>/<slug>`, which the inbound router
  // forwards back over the mesh (FED_SLUG_RE) instead of treating as local.
  const onReplyMap = async (env) => {
    const qualified = `${env.from.host}/${env.slug}`;
    recordReplyMap?.(env.messageId, qualified);
    return { recorded: !!recordReplyMap };
  };

  const server = new FederationServer({ port, bind, token, log, onAnnounce, onMessage, onReply, onInbound, onReplyMap });

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
    // Resolved to us → local path owns it. Hand back the BARE slug: the
    // caller fell through with the qualified target ("j/wintermute"), which
    // the local bySlug index doesn't know — without this, a self-qualified
    // send_to silently dropped as "no live session" (06-19 review warning).
    if (r.local) return { handled: false, localSlug: r.slug };

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
    tap?.('fed-send', { from: fromSlug, to: `${r.hostLetter}/${r.slug}`, delivered, chars: text.length });
    return { handled: true, ok: true, delivered, host: r.hostLetter };
  };

  // #38 Phase 2 — OWNER side. Forward a HUMAN Telegram message to the host that
  // owns the target slug, used as a fallback when local delivery found no
  // session here but the gossip map shows a live peer owns the slug. The remote
  // delivers it via the human path (belfry provenance) and direct-sends its
  // reply back to the chat itself (the A+ return leg). `target` may be a bare
  // slug or a `<letter>/<slug>` address.
  const forwardInbound = async (target, text, { chatId, originatingMessageId } = {}) => {
    const owners = peerRegistry.ownerMap(registry.knownSlugs());
    const r = resolveTarget(target, { selfLetter, owners });
    if (r.kind !== 'resolved' || r.local) return { forwarded: false };
    const peer = peersByLetter.get(r.hostLetter);
    if (!peer || !peer.addr) return { forwarded: false };
    if (!Number.isInteger(chatId) || !Number.isInteger(originatingMessageId)) {
      log(`federation: forwardInbound for ${r.hostLetter}/${r.slug} needs integer chatId+originatingMessageId — skipping`);
      return { forwarded: false };
    }
    let envelope;
    try {
      envelope = buildEnvelope({
        kind: 'inbound',
        from: { host: selfLetter },
        to: { host: r.hostLetter, slug: r.slug },
        text,
        correlationId: correlation.open({ kind: 'telegram', chatId, originatingMessageId, ownerHost: selfLetter }),
        chatId,
        originatingMessageId,
      });
    } catch (err) {
      log(`federation: forwardInbound build failed: ${err.message}`);
      return { forwarded: false };
    }
    const sent = await client.send(peer, envelope);
    if (!sent.ok) {
      log(`federation: forwardInbound ${selfLetter}→${r.hostLetter}/${r.slug} failed: ${sent.error}`);
      return { forwarded: false };
    }
    let delivered = 1;
    try { const b = sent.body ? JSON.parse(sent.body) : null; if (b && typeof b.delivered === 'number') delivered = b.delivered; } catch { /* non-JSON 2xx */ }
    log(`federation: forwarded inbound ${selfLetter}→${r.hostLetter}/${r.slug} (${text.length} chars, delivered ${delivered})`);
    return { forwarded: delivered > 0, delivered };
  };

  // #38 Fornax-flip prerequisite — SOURCE side. We pinged a LOCAL session and
  // recorded its message_id→slug locally; gossip that anchor to every peer so
  // whichever host owns the bot can resolve a quote-reply to this ping and
  // forward it back (the 'inbound' path). Fire-and-forget — a missed sync just
  // degrades that one quote-reply to 🤔, never blocks the ping. Guards:
  //   - skip non-integer ids / empty slugs (record() would reject them anyway)
  //   - skip already-qualified slugs (a bridge return-leg or daemon-level send,
  //     never a local session anchor)
  //   - skip slugs with no live local session — a quote-reply forwarded back
  //     would land on nothing, so there's nothing to anchor
  const syncReplyMap = (messageId, slug) => {
    if (!Number.isInteger(messageId) || typeof slug !== 'string' || !slug || slug.includes('/')) return;
    if (!registry.hasSlug(slug)) return;
    if (peers.length === 0) return;
    let envelope;
    try {
      envelope = buildEnvelope({ kind: 'replymap', from: { host: selfLetter }, messageId, slug });
    } catch (err) {
      log(`federation: replymap build failed: ${err.message}`);
      return;
    }
    // Returns the fan-out promise (the daemon hot path ignores it; tests await).
    return Promise.all(peers.map((p) => client.send(p, envelope))).catch(() => {});
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
  // The announce also carries our `reachableAt` (#38): the last time our poller
  // reached Telegram (ok or 409). Peers feed it to their priority gate to tell a
  // recoverable owner (yield to it) from an egress-dead one (take over).
  const announceOnce = async () => {
    const slugs = [...registry.knownSlugs()];
    const envelope = buildEnvelope({
      kind: 'announce',
      from: { host: selfLetter },
      slugs,
      reachableAt: owner?.reachableAt ?? null,
    });
    const results = await Promise.all(peers.map((p) => client.send(p, envelope)));
    const reached = results.filter((x) => x.ok).length;
    // One aggregated event per gossip round (#49) — not one per peer POST.
    tap?.('gossip', { reached, total: peers.length, slugs: slugs.length });
    return { reached, total: peers.length, slugs: slugs.length };
  };

  // ---- failover: should THIS host stand down from owning the bot? (#38) ----
  // True iff a higher-priority peer is both live on the mesh AND has recently
  // reached Telegram. Two distinct non-yield cases fall out:
  //   - peer not live (gossip stopped, pruned)        → it's gone, we take over
  //   - peer live but reachableAt stale (egress dead) → the Daedalus case, take over
  // A live higher-priority peer that reached Telegram recently — whether it owns
  // the bot (ok) or is merely standing by ready (409) — IS a valid owner to defer
  // to, which is what makes recovery/handback work. With no self priority the
  // whole feature is off (pure 409 election, unchanged).
  const isPreempted = () => {
    if (selfPriority == null) return false;
    const t = now();
    for (const peer of peers) {
      if (peer.priority == null || peer.priority >= selfPriority) continue; // not higher-priority
      const rec = peerRegistry.peer(peer.letter); // null once pruned (lastSeen stale)
      if (!rec) continue; // not live on the mesh
      if (rec.reachableAt > 0 && t - rec.reachableAt <= ownerConfirmTtlMs) return true;
    }
    return false;
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
  registry.setBridgeReplyHandler(bridgeReply);
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
    relayRemote, bridgeReply, announceOnce, startGossip, stop, isPreempted,
    forwardInbound, syncReplyMap,
    selfLetter, port: server.port,
    // Resolve a bare-or-qualified target against the live gossip ownership map
    // (self + peers). Used by the inbound router to route a remote session by
    // its real name (#44). Returns the same shape as resolveTarget().
    resolveAddress: (target) => resolveTarget(target, {
      selfLetter,
      owners: peerRegistry.ownerMap(registry.knownSlugs()),
    }),
    // Every peer-owned slug as a qualified `<letter>/<slug>` address (excludes
    // this host's own slugs). Feeds the /watch menu's fleet-wide discovery (#47
    // Tier 1) so a remote session shows up alongside local ones.
    remoteSlugs: () => {
      const out = [];
      for (const [slug, letters] of peerRegistry.ownerMap(registry.knownSlugs())) {
        for (const letter of letters) if (letter !== selfLetter) out.push(`${letter}/${slug}`);
      }
      return out;
    },
  };
}
