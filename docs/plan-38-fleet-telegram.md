# Plan: #38 — One Telegram feed reaches the whole fleet, survives the owner dying

**Branch:** `main`  ·  **Status:** Phase 1 (priority election) BUILT + tested + **DEPLOYED LIVE** (failover + handback validated by a live kill test 2026-06-15) ✅ · Phase 2 (cross-host inbound forwarding) BUILT + tested + deployed ✅ · reply-tracker-sync (gossip msgId→slug anchors so a remote/sessionless bot owner resolves quote-replies) BUILT + tested 2026-06-21 ✅ · **Fornax flip DONE + verified live 2026-06-21** — bot owner moved Jinn → Fornax (p1), Jinn p2 / Erebus p3 ✅ · follow-ups #42 (fast heartbeat), #43 (startup contention)

> **Moving the bot owner between hosts?** The operational procedure, gotchas, and rollback are written up in [`runbook-bot-owner-migration.md`](runbook-bot-owner-migration.md) — start there.

## Problem

Today the single Belfry Telegram bot can only reach Claude Code sessions **on the
host that owns the bot**. Two gaps:

1. **No failover.** Only one host (Jinn, `j`) polls Telegram. Peers run
   `BELFRY_FED_ONLY=1`, which disables the poller entirely, so when Jinn dies
   nothing claims the bot. The 409 owner-election (`lib/federation-owner.js`)
   exists but is priority-blind and the peers never poll. (This is what took the
   feed down when Daedalus crashed and killed Jinn.)

2. **No cross-host inbound.** When a Telegram message resolves to a slug,
   `registry.deliver(slug, text)` (`lib/registry.js:266`) only looks at
   `this.bySlug` — instances registered on *this* daemon. A slug owned by a peer
   host is dropped (`registry.js:272`, "no instance for slug — dropping").
   `deliver` never consults `federationRouter`; only the agent-to-agent
   `/send-to` route does (`registry.js:815`). So **session→session crosses hosts;
   human(Telegram)→session does not** — even with the owner host healthy.

**Goal:** (A) when the primary owner dies, a priority-ranked standby takes the bot
and keeps the feed working — with the primary reclaiming on recovery; and (B)
reach a session on *any* live host from the one Telegram feed.

## Two phases — build order: 1 then 2

- **Phase 1 — Priority election** (goal A): make bot ownership priority-ranked so
  the highest-priority *live* host owns it, lower hosts stand by, take over on
  failure, hand back on recovery.
- **Phase 2 — Inbound forwarding** (goal B): teach the bot owner to route a human
  Telegram message to a session on any live host, and route that session's reply
  back to Telegram.

**Why Phase 1 first.** Sessions are spread across hosts, so failover immediately
gives a survivor *real local sessions* to drive — the SPOF that caused the outage
is the burning problem, and reliability comes before the cross-host reach feature.
(Gemini flagged the original "Phase 2 first" ordering as backwards; confirmed
against where sessions actually live.) The two phases are independent: Phase 1
ships as its own PR with real value before any forwarding work begins.

---

## What already exists and is reusable

- `lib/federation-envelope.js` — `buildEnvelope`/`parseEnvelope`, kinds
  `message`/`reply`/`announce`. (We extend `announce` and add `inbound`.)
- `lib/federation-daemon.js` — `wireFederation()` wires a fail-closed
  `FederationServer` (`/fed/announce|message|reply`), a `relayRemote` router on
  the registry, a gossip loop, and `bridgeReply` correlation routing.
- `lib/federation-peers.js` — `PeerRegistry` with per-peer `lastSeen` + 90s TTL
  (`prune`), and `ownerMap(selfSlugs)` → `Map<slug, Set<hostLetter>>`. Already the
  live mesh view both phases need.
- `lib/correlation-tracker.js` — open/resolve/cancel correlations (used by the
  webhook bridge; reused for the Phase 2 return-leg).
- `lib/registry.js` — `deliver` (human path, local-only), `relayAgentMessage`
  (agent path), `markOwesReply`/`getOwesReply`/`clearOwesReply`,
  `setFederationRouter`, `knownSlugs`.
- `lib/poller.js` — owns the getUpdates loop and consumes a `TelegramOwner` for
  409→standby. The poll loop is where the priority gate slots in.

---

## Phase 1 — Priority election (BUILD FIRST)

### 1.1 Config: priority per host

- Self: `BELFRY_HOST_PRIORITY` env / `federation.priority` jsonc (integer, lower =
  higher priority; Jinn=1, Erebus=2, future=3…).
- Peers: add `priority` to each peer in `BELFRY_FED_PEERS`
  (`letter,name,addr,priority`) and jsonc `federation.peers[].priority`.
- Backward compatible: if self priority is **unset**, no gating — pure 409
  election, exactly today's behavior. A peer with no configured priority is
  ignored for preemption (can't prove it's higher → don't yield → 409 race
  remains the safety net).

### 1.2 The priority gate — gated on CONFIRMED ownership, not mere aliveness

> **Correctness fix (Gemini, adopted).** The original design had a standby yield
> to any higher-priority peer that was *alive on the mesh*. That breaks on the
> exact failure that caused the outage: if Jinn's container is up and still
> gossiping but its **Telegram egress through Daedalus is dead**, Jinn can't poll
> the bot — yet Erebus keeps seeing it "alive" and yields **forever**. Bot stays
> dead despite a healthy standby. Mesh-aliveness is NOT a sound proxy for
> Telegram-reachability. So a standby must yield only to a higher-priority peer
> that is alive **AND actually holding (or able to hold) the bot**, and a node
> that *cannot* poll must drop its own claim.

**Mechanism: a `reachableAt` stamp in the heartbeat.** Each host stamps its
periodic announcement with `reachableAt` — the timestamp of its last poll that
**reached Telegram**: an `ok` (it owns the bot) **OR** a `409` (it can talk to
getUpdates, but someone else holds it). `PeerRegistry` stores it per peer
alongside `lastSeen`. It is advanced only by a real poll round-trip, never by the
local preempt decision (choosing not to poll proves nothing about reachability).

> **Why `ok`-OR-`409`, not `ok`-only (handback would deadlock otherwise).** If
> `reachableAt` only advanced on a *successful* poll, handback would wedge:
> Erebus owns the bot, Jinn restarts and polls → gets `409` (Erebus holds it) →
> never a success → Jinn never looks "reachable" → Erebus never yields → Jinn
> can never reclaim. Counting a `409` as reachable is exactly the handback
> signal: "Jinn is back and ready, just blocked by me — step down." A genuine
> network failure (the Daedalus egress-dead case) yields neither `ok` nor `409`,
> only errors, so `reachableAt` goes stale and the standby correctly takes over.

In the federation layer expose:

```
isPreempted() → boolean
// true iff some peer P exists where:
//   P is LIVE          (lastSeen within the peer TTL), AND
//   P.priority < selfPriority (numerically higher priority), AND
//   P.reachableAt is FRESH (within OWNER_CONFIRM_TTL)
//        — i.e. P is up AND reaching Telegram (owns it, or is ready to).
```

Self-demotion is **emergent, not an explicit counter**: a node that can't reach
Telegram simply stops advancing its own `reachableAt` (errors don't touch it), so
its advertised stamp ages out and a lower-priority peer's `isPreempted()` flips
false and promotes. No separate "N consecutive errors → demote" logic needed.

Inject `isPreempted` into the poller. **Before each poll attempt:**

- preempted → do NOT call getUpdates; role standby; wait the standby interval;
  re-check.
- not preempted → poll exactly as today; 409 handling (`TelegramOwner`) unchanged
  as the tie-breaker / handover safety net.

`TelegramOwner` stays a pure poll-outcome state machine; the priority decision
lives next to the data it needs (`PeerRegistry`). The gate defaults to
`() => false` (no federation / no priority → today's behavior unchanged).

### 1.3 Why this gives takeover AND handback (and survives the Daedalus case)

- **Normal:** Jinn (p1) polls successfully → its heartbeat carries a fresh
  `reachableAt` → Erebus (p2) is preempted → stands by, never touches the bot.
- **Jinn process dies:** heartbeat stops → Erebus prunes `j` → not preempted →
  Erebus polls → claims the bot.
- **Jinn up but Telegram egress dead (the outage case):** Jinn keeps gossiping but
  its `reachableAt` goes stale (only poll errors, no `ok`/`409`) → Erebus sees `j`
  live but *unreachable on Telegram* → **not preempted** → Erebus takes the bot.
  ✅ This is the case the old design got wrong.
- **Handback:** Jinn recovers and polls → `409` (Erebus still holds the bot) →
  that 409 refreshes Jinn's `reachableAt` → Erebus sees a fresh, reachable
  higher-priority peer → preempted → yields after its current long-poll returns →
  Jinn's next poll succeeds and it re-claims. The 409 mutex prevents
  double-ownership during the brief overlap. (Counting the 409 as reachable is
  what avoids the handback deadlock — see §1.2.)

**Liveness signal & failover speed.** Two timescales: slug-gossip stays slow (90s,
slugs change rarely); the **ownership-confirmed bit** rides the same announcement.
Refreshing it on the 30s gossip cadence bounds failover at ~30–90s. A separate,
faster owner-status ping (cutting that to ~10–30s) is **deferred → GitHub #42** —
not part of this cut; the ownership-confirmed logic is correct at the slower
cadence, #42 only tightens latency.

### 1.4 Files touched (Phase 1)

- `lib/federation-config.js` (+ `lib/config.js` surface) — parse self + peer
  `priority` (`BELFRY_HOST_PRIORITY`, 4-field compact peer env, jsonc). ✅ done
- `lib/federation-envelope.js` — carry `reachableAt` on the `announce` kind
  (optional positive number; absent/0 omitted). ✅ done
- `lib/federation-peers.js` — store peer `reachableAt` on the record alongside
  `lastSeen`; `applyAnnouncement` accepts it. ✅ done
- `lib/federation-owner.js` — `TelegramOwner` gains `reachableAt` (advanced on
  `record('ok')`/`record('conflict')`, NOT on error) + a `preempt()` that stands
  down without touching `reachableAt`. ✅ done
- `lib/federation-daemon.js` — `isPreempted()` export (live + higher-priority +
  fresh `reachableAt`); `announceOnce` stamps `owner.reachableAt`;
  `OWNER_CONFIRM_TTL_MS`. ✅ done
- `lib/poller.js` — consult the gate before polling; standby-without-poll branch
  via `owner.preempt()`. ✅ done
- `bin/belfry.js` — create the `TelegramOwner` before `wireFederation`, pass it in
  (gossip reads its `reachableAt`), and pass `federation.isPreempted` into the
  Poller. ✅ done
- Deployment (operational, not code): a standby Telegram host simply does **not**
  set `BELFRY_FED_ONLY` and gets a `BELFRY_HOST_PRIORITY` + token — it runs the
  poller gated, not disabled. `FED_ONLY` stays for sessionless mesh nodes.

### 1.5 Tests (Phase 1) ✅ all green

- `test/federation-owner.test.js` — `reachableAt` advances on ok/conflict, not on
  error; `preempt()` stands by without touching `reachableAt`.
- `test/federation-config.test.js` — self + peer priority parsing (env, 4-field
  compact, jsonc); invalid priority throws.
- `test/federation-peers.test.js` — `reachableAt` stored / defaults to 0.
- `test/federation-envelope.test.js` — announce carries `reachableAt`, round-trips,
  omitted when 0/absent.
- `test/federation-priority-gate.test.js` (new) — `isPreempted` truth table on an
  injected clock: fresh higher peer → true; **live but stale `reachableAt` → false
  (the Daedalus case)**; pruned → false; equal/lower/null priority → false; no self
  priority → off; handback (stale→fresh re-announce flips back to preempted).
- `test/poller.test.js` — preempted → no getUpdates, stands by via `preempt()`;
  not preempted → polls; no gate wired → inert.
- `test/federation-daemon.test.js` — end-to-end: a host's `owner.reachableAt`
  gossips to the peer and drives its `isPreempted()`.

---

## Phase 2 — Inbound forwarding (BUILD SECOND)

### 2.1 New envelope kind: `inbound`

A **human Telegram message forwarded to the host that owns the target slug.**
Distinct from `message` (agent a2a) because the remote must deliver it via the
**human** path (`registry.deliver`, belfry provenance, `reply` tool valid) — NOT
`relayAgentMessage` (which stamps `origin="agent"` and forbids the `reply` tool).

- Add `'inbound'` to `ENVELOPE_KINDS`. Shape: `from {host}` (the owner that
  forwarded), `to {host, slug}`, `text`, `correlationId` (always — needed for the
  return leg), plus the originating Telegram context (`chatId`,
  `originatingMessageId`) the remote needs to send + react.
- v1 **forwards text only** (image/voice paths are host-local). If the inbound had
  an attachment the owner forwards a note that an attachment was dropped — see
  Open Question 2.

### 2.2 Owner side: forward instead of drop

In the daemon's inbound dispatch (where Telegram→slug currently calls
`registry.deliver`), when the resolved slug is **not local but owned by a live
peer** (consult `peerRegistry.ownerMap(registry.knownSlugs())`):

1. Mint a correlation: `correlation.open({ kind:'telegram', chatId,
   originatingMessageId, ownerHost:selfLetter })`.
2. `buildEnvelope({ kind:'inbound', from:{host:selfLetter}, to:{host:peer,
   slug}, text, correlationId, chatId, originatingMessageId })` and
   `client.send(peer, env)`.
3. On send failure → cancel correlation, fall back to today's drop+log.

Wiring: the federation layer exposes
`forwardInbound(slug, text, { chatId, originatingMessageId }) → { forwarded:bool }`;
`bin/belfry.js` calls it as a **fallback** when `registry.deliver(...)` returns 0
**and** `ownerMap` shows a live remote owner. Local delivery stays the fast path,
unchanged.

### 2.3 Remote side: deliver as human input

New `onInbound(env)` handler in `wireFederation`:

```
const n = registry.deliver(env.to.slug, env.text, /*originatingMessageId*/ null);
if (n > 0) registry.markRemoteOwesReply(env.to.slug, {
  ownerHost: env.from.host, correlationId: env.correlationId,
  chatId: env.chatId, originatingMessageId: env.originatingMessageId });
return { delivered: n };
```

`deliver` with a null `originatingMessageId` will NOT call the local
`markOwesReply` (good — there's no local Telegram message to reply to). Instead we
set a parallel **remote** owes-reply marker. Only mark when `deliver` actually
reached an instance (`n > 0`), matching `deliver`'s own "don't mark owes-reply for
a dropped message" invariant (`registry.js:269`).

#### `markRemoteOwesReply` — precise spec (Gemini flagged the race)

A **separate map** from the existing local `pendingReply`, never the same one —
the two carry different payloads and must not collide:

```
this.remotePendingReply = new Map()
// slug → { ownerHost, correlationId, chatId, originatingMessageId, ts }
markRemoteOwesReply(slug, { ownerHost, correlationId, chatId, originatingMessageId })
getRemoteOwesReply(slug)   // null if absent or older than PENDING_REPLY_TTL_MS
clearRemoteOwesReply(slug)
```

Rules that remove the race with local `markOwesReply`:

1. **A slug owes a reply to exactly one place at a time.** The two markers are
   mutually exclusive per slug: setting the remote marker clears any local one for
   that slug, and `deliver` setting a local marker clears any remote one. (A slug
   is reached *either* locally-as-owner *or* via remote-forward on a given turn,
   never both — different inbound paths.)
2. **`/send` (the `reply` tool) consults remote first.** On a reply for `slug`:
   `getRemoteOwesReply(slug)` set → forwarded conversation, run the return-leg
   (§2.4) and `clearRemoteOwesReply`. Else fall back to today's local
   `getOwesReply` → local Telegram send. One branch or the other, decided by which
   marker is live.
3. **Same TTL** (`PENDING_REPLY_TTL_MS`) and lazy eviction as the local marker, so
   a stale forwarded turn can't misroute a much-later unrelated reply.
4. **Owner-change safety.** If the forwarding owner changed between forward and
   reply, the stored `ownerHost`/`correlationId` may be stale; the §2.4 return-leg
   is owner-death-safe by construction (it sends directly from the remote host,
   not back through the owner), so a stale owner reference doesn't strand the reply.

### 2.4 Return leg — DECIDED: A⁺ (direct-send + two fire-and-forget side-effects)

When the remote session answers (via the `reply` MCP tool → `POST /send`), the
reply must reach Telegram. The remote host does **not** own the bot, but
`sendMessage` is NOT exclusive — only `getUpdates` is (`federation-owner.js:13`).

**Decision: the remote host sends the reply itself.** Rationale: #38's defining
requirement is surviving the owner dying *mid-conversation*; direct-send is the
only strategy robust to that without extra machinery, and the centralized
rate-limiting that forward-to-owner would buy is the weakest concern in Belfry's
single-user, low-volume regime (rare 429s self-heal via the send-queue's
`retry_after` retry). Forward-to-owner (Option B) is disqualified by that very
failure mode; the hybrid (C) pays B's full complexity to recover a benefit that
barely matters here. (Reviewed with Gemini, which also recommended direct-send.)

The remote `/send` path, when `getRemoteOwesReply(slug)` is set (§2.3):

1. `sendMessage(chatId, text, reply_to=originatingMessageId)` via the local
   Telegram helper + the local send-queue. `chatId` + `originatingMessageId` came
   in on the `inbound` envelope (message_ids are per-chat global, so quote-replying
   the owner's original message_id works from any host on the same bot token).
2. **Side-effect 1 — reaction swap.** Fire-and-forget `setMessageReaction` on the
   original inbound (👀→🫡). Reactions are non-exclusive like `sendMessage`, so the
   swap works from the remote host; failure never blocks the reply.
3. **Side-effect 2 — reply-tracker sync.** Fire-and-forget one-way notice to the
   *current* bot owner: "I sent message M for slug S" → owner records it in its
   `messageId→slug` LRU so a future quote-reply to M still routes. If this fails,
   the worst case is one follow-up quote-reply needing a `/slug` prefix — no
   round-trip dependency, so resilience is intact.
4. `clearRemoteOwesReply(slug)`.

Both side-effects are pure additive hardening of the two functional gaps direct-
send otherwise has (reaction divergence; reply-tracker landing on the wrong host).
The reply itself never depends on them.

### 2.5 Files touched (Phase 2)

- `lib/federation-envelope.js` — add `inbound` kind + validation (incl. `chatId`,
  `originatingMessageId`).
- `lib/federation-daemon.js` — `onInbound` handler; `forwardInbound(...)` export;
  the A⁺ return-leg helpers (reply-tracker-sync notice to the owner).
- `lib/registry.js` — `markRemoteOwesReply`/`getRemoteOwesReply`/`clear` (+ the
  mutual-exclusion with `markOwesReply`); teach `/send` to run the A⁺ direct-send
  when the remote marker is set.
- `lib/federation-server.js` — route the new `inbound` kind to `onInbound`; accept
  the reply-tracker-sync notice.
- `bin/belfry.js` — call `forwardInbound` as the fallback when local `deliver`==0
  and a live remote owner exists.

### 2.6 Tests (Phase 2)

- envelope: build/parse `inbound` round-trips (incl. chatId/messageId); rejects
  missing correlationId.
- registry: remote-owes-reply marker set/get/expire; setting it clears a local
  marker and vice-versa; `/send` runs the direct-send branch when marked.
- 2-host loopback in `test/federation-daemon.test.js`: host-J owner forwards an
  `inbound` for a slug registered on host-E; host-E session receives it as a
  belfry (non-agent) channel item; its `reply` direct-sends (assert on host-E's
  captured `sendMessage` + the reaction swap + the tracker-sync notice to J). Plus
  the owner-dead case: J is down at reply time, the reply still escapes from E.

---

## Deployment changes

- **Jinn (`j`):** `BELFRY_HOST_PRIORITY=1`. Unchanged otherwise — always owner when
  up.
- **Erebus (`e`):** drop `BELFRY_FED_ONLY=1`; add `BELFRY_HOST_PRIORITY=2` and its
  own `BELFRY_TOKEN`/`BELFRY_CHAT_ID` (already retrievable from its
  secrets-manager). Runs the poller gated → silent standby while Jinn is up,
  claims the bot when Jinn dies, serves its local sessions, and (Phase 2) forwards
  to / from other live hosts. Brain + watcher run idle on a standby (only the bot
  owner receives inbound, so only the owner's brain fires — no double-processing).
- **`BELFRY_FED_ONLY` stays** for genuinely sessionless mesh nodes (e.g. the NAS
  webhook-bridge host) that must never contend for the bot.
- Update `CLAUDE.md` env table + `docs/federation.example.jsonc`.

---

## Review log (Gemini, 2026-06-15)

Reviewed against the live source. Adopted: **confirmed-reachability liveness**
(§1.2 — fixes the Daedalus-egress-dead failover hole), **Phase 1 before Phase 2**
(sessions are spread across hosts), a **precise `markRemoteOwesReply` spec**
(§2.3), and the **return-leg = A⁺ direct-send** decision (§2.4, Gemini concurred).
Deferred: a separate fast owner heartbeat → **GitHub #42**.

**Build refinement (during Phase 1 impl).** Gemini's `ownerConfirmedAt` (last
*successful* poll) was changed to **`reachableAt`** (last poll that reached
Telegram — `ok` **or** `409`). `ok`-only would deadlock handback: a restarting
primary only ever gets `409` while the standby holds the bot, so it would never
look "confirming" and the standby would never yield. A `409` proves reachability
and is the handback signal; only true network errors (the Daedalus case) let
`reachableAt` go stale. See §1.2.

## Open questions (non-blocking)

1. **Cross-chat rate limiting.** *(Resolved by the A⁺ return-leg.)* >1 host can
   send to Telegram directly; occasional 429s are accepted and self-heal via the
   send-queue's `retry_after` retry. No cross-host send coordination in v1.
2. **Attachments over the mesh (v1).** Forward text only and note dropped
   image/voice? Or base64 small attachments in the `inbound` envelope? Leaning
   text-only for v1 — low stakes, decide at Phase 2.
3. **Split-brain.** If a partition lets two hosts each reach Telegram but not each
   other, both think they're un-preempted and poll. The 409 mutex still prevents
   double-ownership (one wins getUpdates), so the cost is a brief standby retry
   loop on the loser, not double-delivery. Believed an acceptable bound — confirm
   we don't want a stronger coordinator.
