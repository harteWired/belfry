---
date: 2026-06-15
project: belfry
type: session-log
---

# 2026-06-15 — #38 plan: fleet-wide Telegram failover + inbound forwarding

## Quick Reference
**Keywords:** belfry, federation #38, priority-ranked Telegram ownership, failover, handback, ownership-confirmed liveness, ownerConfirmedAt, Daedalus SPOF, Jinn behind NAT, BELFRY_FED_ONLY, Erebus priority-2 standby, inbound forwarding, deliver vs send_to, registry.deliver local-only, markRemoteOwesReply, return-leg A+ direct-send, sendMessage non-exclusive, getUpdates 409 mutex, gossip heartbeat, PeerRegistry, Gemini review, GitHub #42 fast heartbeat, feature/agent-mesh, plan-38-fleet-telegram.md
**Project:** belfry
**Outcome:** Diagnosed why no host took over Telegram when Jinn/Daedalus crashed (peers run BELFRY_FED_ONLY, poller disabled — by design, since failover without inbound-forwarding drops replies). Wrote, Gemini-reviewed, and finalized a full implementation plan for #38: Phase 1 priority-ranked bot ownership with failover/handback, Phase 2 cross-host inbound forwarding. All design decisions locked; ready to build Phase 1. No code written yet.

## What Was Done
- **Diagnosed the weekend outage.** Daedalus crashed → killed the Jinn container (the bot owner). Erebus/Severin did NOT take over because they run `BELFRY_FED_ONLY=1`, which disables the Telegram poller entirely — so they're not even candidates in the 409 owner-election. This is by design (da6cf08): a sessionless host owning the bot would drop the human's replies (no inbound-forwarding yet, filed #38). Confirmed against `lib/poller.js:218` and `bin/belfry.js:104` + the Jinn launcher in `/workspace/shared/belfry-launch.sh`.
- **Corrected an earlier SPOF overstatement.** Erebus is independent infra (own Tailscale, own internet) — it CAN reach Telegram and Severin without Daedalus/Jinn. Only the Erebus→Jinn link goes through Daedalus (Jinn is the NAT-trapped node), which is irrelevant when Jinn is the thing that died. So nothing infrastructural stopped Erebus from taking over — only the FED_ONLY flag.
- **Established the real gap.** Verified `registry.deliver(slug,text)` (`registry.js:266`) is local-only — it never consults `federationRouter` (only the `/send-to` agent path does, `registry.js:815`). So human(Telegram)→session does NOT cross hosts even today with Jinn healthy; only session→session (`send_to`) does. Reaching "any machine via the single Telegram feed" REQUIRES inbound forwarding (Phase 2), independent of failover.
- **Wrote the plan** to `docs/plan-38-fleet-telegram.md` (Phase 1 priority election + Phase 2 inbound forwarding), then sent it to Gemini (`gemini_analyze`, pro) with the live source files for an adversarial distributed-systems review.
- **Folded in Gemini's review + user decisions; finalized the plan** (reordered Phase-1-first, fixed stale cross-refs, locked every design decision).
- **Filed GitHub #42** (enhancement): fast owner-liveness heartbeat decoupled from slug-gossip, deferred from #38's first cut.
- **Sent a status update to Telegram** (msg 2196) answering an inbound "where are we at?".

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Build Phase 1 (failover) BEFORE Phase 2 (forwarding) | Sessions are spread across hosts, so a survivor that owns the bot has real local sessions to drive immediately; the SPOF is the burning problem. (Gemini flagged the original Phase-2-first ordering as backwards.) |
| Liveness = "confirmed bot ownership", NOT mesh-aliveness | THE key Gemini catch. Old design: standby yields to any higher-priority peer alive on the mesh. Breaks the exact outage case — Jinn up + gossiping but Telegram egress through Daedalus dead → standby yields forever, bot stays dead. Fix: heartbeat carries `ownerConfirmedAt` (last successful getUpdates); standby yields only to a higher peer that's alive AND freshly confirming ownership; a node that can't poll self-demotes. |
| Return-leg = A+ direct-send (not forward-to-owner, not hybrid) | #38's defining requirement is surviving owner death mid-conversation; only direct-send is robust to it. sendMessage is non-exclusive, so the remote host sends its own reply. Plus two fire-and-forget side-effects: react swap 👀→🫡, and a messageId→slug sync to the current owner. Centralized rate-limiting (the only thing forward-to-owner buys) is the weakest concern in a single-user low-volume chat (429s self-heal via retry_after). Gemini concurred. |
| Erebus becomes a priority-2 Telegram standby | Drops BELFRY_FED_ONLY, gets its own token (already in its secrets-manager), runs the poller gated → silent standby while Jinn up, claims bot when Jinn dies. FED_ONLY stays for truly sessionless mesh nodes (NAS bridge). |
| `markRemoteOwesReply` as a SEPARATE map, mutually exclusive with local `markOwesReply` | Gemini flagged the race. A slug owes a reply to exactly one place per turn; `/send` consults remote-first; same TTL + lazy eviction. |
| Fast owner heartbeat deferred → #42 | Ownership-confirmed logic is correct on the existing 30s/90s gossip cadence (failover ~30–90s); #42 only tightens latency to ~10–30s. Not needed for the first cut. |

## Key Learnings
- **Mesh-aliveness is NOT a sound proxy for Telegram-reachability.** A node can be healthy on the gossip mesh yet unable to poll the bot (egress path dead). Ownership decisions must gate on a *confirmed successful poll* signal, and a node that can't poll must yield its own claim — otherwise a healthy standby waits behind a dead-but-breathing primary forever.
- **Belfry's `deliver` (human path) and `send_to` (agent path) have always had asymmetric cross-host reach.** `send_to` forwards via `federationRouter`; `deliver` is local-only. The validated "j↔e works" was session→session only — it never proved human→remote-session.
- **`sendMessage`/`setMessageReaction` are non-exclusive Bot API calls** — any host holding the token can send/react. Only `getUpdates` is exclusive (the 409 mutex). This is what makes A+ direct-send viable from a non-owner host.
- The 409 mutex makes split-brain safe (one host wins getUpdates; the loser just retries) — no double-delivery, so no stronger coordinator needed.

## Files Modified
- `docs/plan-38-fleet-telegram.md`: NEW — full #38 implementation plan (Phase 1 priority election, Phase 2 inbound forwarding, deployment, tests, Gemini review log, open questions). Finalized, Phase-1-first order.
- `docs/sessions/.resume-log`: resume breadcrumb appended (start of session).
- GitHub: created issue #42 (fast owner-liveness heartbeat, enhancement). No code changes this session.

## Follow-ups
- [ ] BUILD Phase 1 (next): priority config (`BELFRY_HOST_PRIORITY` + peer priority) → `isPreempted()` gate (live + higher-priority + fresh `ownerConfirmedAt`) → `ownerConfirmedAt` plumbing (poller writes on `ok`, announce carries it, PeerRegistry stores it) → poller standby-without-poll branch + self-demote on N errors → `bin/belfry.js` un-gate FED_ONLY for priority+token hosts → tests (isPreempted incl. the stale-ownership Daedalus case; 2-host loopback failover/handback). Self-contained PR.
- [ ] Then Phase 2: `inbound` envelope kind, owner-side `forwardInbound`, remote `onInbound`→`deliver`, `markRemoteOwesReply` + mutual exclusion, A+ return-leg in `/send`.
- [ ] Deployment: flip Erebus off FED_ONLY → priority-2 Telegram standby with own token; set Jinn priority 1.
- [ ] GitHub #42 (fast heartbeat) — backlog, after #38 first cut.
- [ ] Commit `docs/plan-38-fleet-telegram.md` to feature/agent-mesh when ready (currently uncommitted).
- [ ] STILL UNLOGGED from prior work: the #40 watch/unwatch + Status-File Contract commits never got a session log.
