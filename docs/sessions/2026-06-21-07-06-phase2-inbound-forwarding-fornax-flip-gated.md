---
date: 2026-06-21
project: belfry
type: session-log
---

# 2026-06-21 — #38 Phase 2 cross-host inbound forwarding built; Fornax bot-owner flip gated on a 3rd prereq

## Quick Reference
**Keywords:** belfry, #38 Phase 2, cross-host inbound forwarding, sessionless owner, Fornax migration, bot-owner flip, reply-tracker-sync, inbound envelope kind, forwardInbound, onInbound, markRemoteOwesReply, A+ return-leg, direct-send, sendMessage non-exclusive, deliveryTarget human-vs-agent, 4-agent /review, session-wedge bug, /all! fire-and-forget broadcast, reply-queue FIFO, #48 ping-cap clip, #47 Tier 1 remote-watch, federation-aware routing, quote-reply per-host tracker, fornax-master keeper, f-peer reachability, p9 standby, computer-use coordination, captain orchestration
**Project:** belfry
**Outcome:** Shipped 5 fixes live (routing/watch/ping-cap/broadcast/reply-queue), then built + reviewed + hardened + deployed the full #38 Phase 2 cross-host inbound-forwarding epic fleet-wide. Staged Fornax as the always-on lead candidate, but caught (by verifying before flipping) that moving the bot owner to a sessionless host needs a 3rd prerequisite — the reply-tracker-sync — so the flip is cleanly gated/held for a fresh focused effort. Nothing broken, nothing wasted.

## What Was Done
- **Deployed the federation-aware routing fix (064728d)** + Tier 1 remote-watch (bd06656) + #48 ping-cap (dc59624) via a daemon restart; verified /erebus-master routes live.
- **#48 reply-clip investigation:** traced the outbound path — the REPLY path sends whole (UTF-8 clean: fetch byte-Content-Length, Buffer.concat utf8, plain-text send); the only sub-4096 clip was the composer's 2500-char ready-PING cap. Raised DEFAULT_RESPONSE_CAP 2500→3200, lowered DEFAULT_PROMPT_CAP 1500→600 (response renders first/protected; keep sum <4096 so fitToTelegramCap never byte-slices mid-HTML-entity). computer-use confirmed it was the ping path. Deployed.
- **/all! fire-and-forget broadcast (8bf0923):** /all marks every session owes-reply + seeds the tracker → N auto-replies flood the chat into a 429 on /all compress. /all! skips markOwesReply + tracker → 1 confirmation, no flood. (Diagnosis: compress itself sends nothing; the daemon's per-session auto-reply is the flood.)
- **Reply-queue fix (666f691):** pendingReply was a SINGLE slot per slug that markOwesReply OVERWROTE → concurrent messages to one session (e.g. computer-use) dropped earlier replies. Made it a per-slug FIFO queue (push/peek-oldest/pop-oldest). Designed + explained the chunk-vs-consolidate nuance to Matt (turn-boundary draining) but shipped the minimal-risk push+pop-front version; documented chunk/consolidation edges as cosmetic follow-ups.
- **#38 PHASE 2 — the epic** (5 incremental safe commits, each additive/dormant until activated):
  1. a600f9e — 'inbound' envelope kind (human msg forwarded owner→owning-host; carries chatId+originatingMessageId+correlationId).
  2. a5af091 — markRemoteOwesReply/get/clear (separate single-value map, mutually exclusive with the local FIFO queue).
  3. 4a95851 — /send A+ return-leg routing to a late-bound onRemoteReply when the remote marker is set.
  4. 0c6f437 — onInbound (remote: deliver via HUMAN path + set remote marker) + forwardInbound (owner: resolve owning peer, mint correlation, send inbound envelope) + /fed/inbound route (server + client).
  5. piece-5 — activate: deliveryTarget forwards a human inbound (has chatId+msgId) via forwardInbound instead of relayRemote (agent); onRemoteReply wired to sendOutbound (same bot/chat → quote-reply + pack + reaction swap reused).
- **4-agent /review + judge** on the Phase 2 diff: 0 critical, 4 warnings, 1 suggestion. FIXED the real one (b0f0b80): a failed return-leg left the remote marker set → 1h session wedge (now clearRemoteOwesReply in the catch); guarded setRemoteReplyHandler on botToken+chatId (fed-only no-creds node); chatId-match guard. Deferred 3 maintainability refactors (OwesReplyState encapsulation, deliverFederated extraction, ownerMap memoize). 255 tests green.
- **Deployed Phase 2 fleet-wide:** pushed b0f0b80; restarted Jinn (graceful — peers without /fed/inbound 404 → agent-relay fallback); computer-use git-pulled + restarted Erebus (p2) + Fornax (p9). onInbound now on j/e/f.
- **Fornax migration staging** (computer-use did the host legwork): Fornax (Pi 4B, Debian arm64, Tailscale 100.87.212.71) stood up as a belfry node via systemd+node, secrets in a root-600 env file (belfry.js reads process.env directly — no secrets-manager needed on Fornax), at BELFRY_HOST_PRIORITY=9 (passive). Added f as a p9 reachability peer to Jinn (supervisor-restart) + Erebus so the new fornax-master keeper (f/fornax-master, claude installed) is addressable now.
- **CAUGHT THE FLIP BLOCKER:** verifying before flipping found that a sessionless owner breaks quote-reply for every Jinn session — see Key Learnings. HELD the flip; computer-use stood down; Fornax stays a clean p9 standby.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Build Phase 2 as 5 incremental, additive/dormant commits | Each (envelope, marker, return-leg routing, handlers) is inert until the bin/belfry.js activation, so the live mesh is unchanged if I stop partway; piece 5 only changes messages that previously took the agent path. |
| Human inbound forwards via forwardInbound (human path), cold/agent send via relayRemote | A human Telegram msg to a remote session must arrive as belfry-provenance HUMAN input (reply tool valid), not origin=agent (which makes the session treat Matt as a peer). Gated on having a Telegram context (chatId+originatingMessageId). |
| A+ return-leg = remote direct-sends (sendMessage non-exclusive) | #38's defining requirement is surviving owner-death mid-conversation; direct-send is robust to it. Only getUpdates is exclusive to the owner; any host with the token can sendMessage. Reused sendOutbound (same bot/chat) for free quote-reply + pack + reaction swap. |
| Ran /review before deploying Phase 2 | Live-mesh code; the review caught a real 1h session-wedge bug a test sweep missed. Validated the caution. |
| HELD the Fornax flip despite Matt saying "push through" | NEW material fact: the flip needs a 3rd prereq (reply-tracker-sync) Phase 2 doesn't provide — flipping would silently degrade Matt's primary workflow (quote-reply). Surfacing new info that changes the calculus is the right call even against a prior "go". |
| Deferred reply-tracker-sync as "hardening" during the build | Per plan-38 it's "additive hardening" with a /slug fallback — TRUE for same-host. But for a SESSIONLESS owner it's load-bearing (quote-reply resolution), which only the pre-flip verify surfaced. |
| /all! skips owes-reply+tracker, not a compress-skill tweak | The flood is the daemon's per-session AUTO-reply (marker-driven), independent of the model. A compress "don't reply" tweak does nothing; the fix is belfry-side fire-and-forget. |

## Key Learnings
- **A sessionless bot owner breaks quote-reply for other hosts' sessions — and the break is UPSTREAM of Phase 2.** Quote-reply resolves via the LOCAL reply-tracker (router.js:220 replyTracker.lookup); pings are NOT owner-gated (each host pings its own sessions, recording msgId→slug on ITS tracker); there's no cross-host tracker sync. So after a Fornax flip: Jinn pings→records on Jinn→Matt quote-replies→lands on Fornax (owner)→Fornax's tracker lacks it→fails at the router, before forwardInbound ever runs. The flip needs the reply-tracker-sync (each pinging host forwards msgId→slug to the current owner). This is the 3rd prerequisite careful staging surfaced (migration→Phase 2→tracker-sync) — strong evidence the sessionless-lead flip is a multi-step epic, not a tail-of-session push.
- **The outbound ping path is NOT owner-gated** (bin/belfry.js watcher.start, no isPreempted check) — each host independently pings its own local sessions via non-exclusive sendMessage regardless of who owns the bot. Good (pings survive a sessionless-owner flip) AND the root of the quote-reply gap (ping host ≠ owner → tracker split).
- **belfry.js reads process.env directly** (`process.env.BELFRY_TOKEN` etc.) — only the launcher wrapper shells out to secrets-manager. So a remote host can run belfry with a plain systemd EnvironmentFile; no secrets-manager needed there.
- **Env-var changes need a SUPERVISOR restart** (kill the supervisor + re-run belfry-launch.sh), not just a child-restart — the supervisor holds the env. Code changes need only a child-restart (working tree).
- **Phase 2 degrades gracefully during a rolling deploy:** a Phase-2 owner forwarding to a peer without /fed/inbound gets a 404 → forwardInbound returns forwarded:false → deliveryTarget falls back to the agent relay. No hard break mid-deploy.
- **The chatId-injection vector is NOT exploitable** (security review): the return-leg uses the LOCAL chatId; env.chatId rides the marker but is never used as a send target.

## Solutions & Fixes
- **#48 ping clip:** composer response cap 2500→3200, prompt 1500→600, sum kept <4096 (response-first ordering protects it; avoids mid-HTML-entity byte-slice). dc59624.
- **/all 429 flood:** /all! fire-and-forget variant skips markOwesReply+tracker → no N auto-replies. 8bf0923.
- **Concurrent-message reply drops:** pendingReply slot→FIFO queue. 666f691.
- **Phase 2 1h session-wedge:** clearRemoteOwesReply on a failed return-leg (was only cleared on success). b0f0b80.

## Files Modified
- lib/federation-envelope.js, lib/federation-server.js, lib/federation-client.js: 'inbound' kind + /fed/inbound route.
- lib/federation-daemon.js: forwardInbound (owner) + onInbound (remote) + export.
- lib/registry.js: markRemoteOwesReply/get/clear + mutual exclusion; /send A+ return-leg routing; pendingReply slot→FIFO queue; setRemoteReplyHandler.
- lib/delivery-target.js: human-inbound (forwardInbound) vs agent-relay branch + chatId param.
- bin/belfry.js: wire chatId + setRemoteReplyHandler (creds-gated, chatId-guarded); /all! quiet flag; getSlugs remote discovery (#47 T1).
- lib/router.js, lib/poller.js: /all! parsing + quiet thread-through.
- lib/config.js: ping caps 3200/600 (#48).
- lib/composer.js: #48 regression test.
- /workspace/shared/belfry-launch.sh (outside repo): added f,Fornax,...,9 reachability peer.
- Tests: +federation-envelope, registry, federation-daemon, delivery-target, router, poller, composer, watch-handler. 255 green.
- Git: 064728d, bd06656, dc59624 (earlier-deployed), 8bf0923, 666f691, a600f9e, a5af091, 4a95851, 0c6f437, piece-5, b0f0b80. All on origin/main.

## Follow-ups
- [ ] **THE FORNAX FLIP (4 finite steps, fresh focused session):** (1) build the reply-tracker-sync (each pinging host forwards msgId→slug to the current owner so quote-replies resolve there) — the LAST prereq; (2) deploy fleet-wide; (3) LIVE-verify with Matt (he messages a remote session + quote-replies, confirm human delivery + threaded reply); (4) flip Fornax→p1, demote Jinn→2/Erebus→3 + update peers, election hands Fornax the bot, leave j/e as ranked standbys. computer-use has the host side prepped (Fornax p9 + claude + keeper); hand it the belfry.jsonc whitelist at flip time.
- [ ] **#47 Tier 2** (remote ready/error pings) — still useful; an alternative to the tracker-sync for the quote-reply problem (owner pings for remote sessions → records the owner's tracker). Decide tracker-sync vs Tier 2 (or both) when building the flip.
- [ ] **Phase 2 maintainability refactors** (deferred from /review): encapsulate the two owes-reply markers behind one OwesReplyState (single write enforces the mutual-exclusion invariant); extract deliverFederated() from the deliveryTarget; memoize ownerMap short-TTL.
- [ ] **Reply-queue chunk/consolidation polish** (deferred): turn-boundary draining for perfect chunk-threading + consolidation acks (current minimal version fixes the drop; threading edges are cosmetic).
- [ ] **Fed-proxy IP pin** (Matt's devcontainer cutover) + #42 fast heartbeat / #43 cold-start — open backlog.
