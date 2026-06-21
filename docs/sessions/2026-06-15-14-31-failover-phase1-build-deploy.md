---
date: 2026-06-15
project: belfry
type: session-log
---

# 2026-06-15 — #38 Phase 1: priority failover BUILT, tested, deployed + live kill test

## Quick Reference
**Keywords:** belfry, federation #38 Phase 1, priority-ranked Telegram ownership, reachability-gated failover, reachableAt, ok-or-409, handback deadlock fix, isPreempted, TelegramOwner preempt(), OWNER_CONFIRM_TTL_MS, BELFRY_HOST_PRIORITY, 4-field peer env, poller gate, smoke test, live kill test, Jinn priority 1, Erebus priority 2 standby, remote-ops nuc=Erebus, NSSM service, belfry-run.ps1, FED_ONLY dropped, ~90s failover, ~64s handback, cold-start contention, GitHub #42 #43, feature/agent-mesh, commits 86edd28 db157e9
**Project:** belfry
**Outcome:** Built, unit-tested (144/144), committed (no release), and DEPLOYED #38 Phase 1 live to the real fleet (Jinn priority 1 / Erebus priority 2 standby). A live kill test proved the full cycle: kill Jinn → Erebus took the bot in ~90s → restart Jinn → handback in ~64s. The weekend-outage failure mode (sole poller dies, nothing takes over) is now fixed in production.

## What Was Done
- **Built Phase 1** (priority-ranked Telegram ownership with failover/handback): config parses self+peer priority (BELFRY_HOST_PRIORITY, 4-field compact peer env, jsonc); TelegramOwner gains reachableAt + preempt(); announce carries reachableAt; PeerRegistry stores it; federation-daemon exposes isPreempted() + OWNER_CONFIRM_TTL_MS; poller gates getUpdates before each poll; bin/belfry.js builds the owner before wireFederation and passes isPreempted to the Poller. Backward compatible (no priority → pure 409 election, unchanged).
- **Tests: 144/144 green** across owner/envelope/peers/config + a new federation-priority-gate.test.js truth table (incl. Daedalus stale-reachable + handback) + poller gate + end-to-end reachableAt gossip propagation. Updated 2 existing config tests for the new `priority` field.
- **Smoke test** (scripts/smoke-failover.mjs): in-process two-daemon harness (real Registry+wireFederation gossip+TelegramOwner+Poller+gate, only Telegram mocked via a shared 409 lease). All 3 phases passed: converge, egress-dead failover, handback.
- **Committed (no release) + pushed feature/agent-mesh**: 86edd28 (feature), db157e9 (smoke harness).
- **Deployed Jinn** (this host): added BELFRY_HOST_PRIORITY=1 + peer priority 2 to /workspace/shared/belfry-launch.sh; restarted the SUPERVISOR (not just child — env vars only refresh on supervisor relaunch) via kill -TERM <supervisor pid> then re-run belfry-launch.sh. Verified "telegram-owner election active (priority 1)".
- **Deployed Erebus** (remote Windows NUC, via remote-ops `nuc` host = confirmed hostname Erebus): git pull Phase 1 while STILL FED_ONLY (safe), restart, verify; THEN rewrote C:\Users\aesth\belfry-run.ps1 (backup .bak saved) — dropped FED_ONLY, added HOST_PRIORITY=2, added ,1 to the Jinn peer (4-field) so Erebus knows Jinn outranks it. Restarted NSSM service. Verified "telegram-owner election active (priority 2)" + poller active.
- **Live kill test PASSED**: killed Jinn 21:25:21 → Erebus acquired the bot 21:26:51 (~90s) → restarted Jinn 21:27:44 → Jinn reclaimed 21:28:48 (~64s handback) → Erebus back to standby. Bot stayed alive on Erebus during the outage window.
- **Filed GitHub #43** (cold-start contention follow-up). #42 (fast heartbeat) filed earlier this session-arc.
- Earlier in this session-arc (same day): wrote + Gemini-reviewed + finalized the #38 plan; this session is the BUILD+DEPLOY half.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| reachableAt = last poll that REACHED Telegram (ok OR 409), not ok-only | ok-only deadlocks handback: a restarting primary only gets 409 while the standby holds the bot, so it could never look "reachable" and the standby would never yield. A 409 proves reachability and IS the handback signal; only genuine network errors (Daedalus egress-dead) let it go stale. |
| preempt() does NOT advance reachableAt | The priority gate's stand-down is a local decision with no Telegram round-trip; advancing reachableAt there would falsely advertise reachability for a standby that isn't actually polling. |
| Restart Jinn SUPERVISOR (not just kill the child) | The supervisor holds the env; killing only the child relaunches with the supervisor's OLD env (no HOST_PRIORITY). Must kill -TERM the supervisor pid and re-run belfry-launch.sh. |
| Erebus: pull new code BEFORE dropping FED_ONLY | Safety-critical ordering — old-code Erebus polling ungated would thrash with Jinn and repeat the 46-min outage. FED_ONLY stays on until the gate code is present. |
| Add ,1 (Jinn priority) to Erebus's BELFRY_FED_PEERS | Without the peer priority, Erebus's isPreempted can't tell Jinn is higher → it wouldn't yield → thrash. Essential. |
| Accept ~90s failover for v1 | It's the reachableAt/peer-TTL (OWNER_CONFIRM_TTL_MS 90s). #42 (fast heartbeat) tightens to ~10-30s later. |
| Commit but don't tag/release | User directive; push the feature branch (needed for Erebus to pull) is NOT a release. |

## Key Learnings
- **The handback deadlock is the subtle trap in priority failover.** Gating yield on "confirmed ownership (successful poll)" wedges, because the rightful owner can't get a successful poll while the usurper holds the exclusive getUpdates. Gate on "reached Telegram (ok OR 409)" instead.
- **Cold-start contention (filed #43):** a freshly-restarted lower-priority node polls before it has heard gossip (isPreempted false with no peer data), so it can transiently steal the bot for ~1 gossip interval. Observed live as a ~47s flap on Erebus restart; self-heals via the gate. Fix: a ranked standby should defer its first poll until it's heard one gossip round.
- **remote-ops `nuc` host == Erebus** (hostname confirmed). Windows NUC, NSSM `belfry` service as .\aesth, launcher C:\Users\aesth\belfry-run.ps1, log C:\Users\aesth\belfry\belfry-svc.log. Erebus reaches Jinn via the Daedalus socat forwarder http://100.95.89.113:38078; Jinn reaches Erebus at 100.127.39.115:49878.
- **Restarting the Jinn daemon kills the reply path** (belfry-mcp spoke is registered with the Jinn registry); during the failover window the model can't use the reply tool — narrate in the terminal until handback re-registers the spoke.
- Live timings matched the design: ~90s failover (TTL), ~64s handback (gossip + standby interval).

## Solutions & Fixes
- pgrep -f 'belfry/bin/belfry.js' matches the model's OWN shell commands (the path is in argv) → false "still alive". Use `ps -eo pid,cmd | grep -E 'node .*belfry/bin/belfry\.js'` to check the real daemon.
- Erebus launcher rewritten via a single-quoted PowerShell here-string (@'...'@) to avoid $env: interpolation + quoting fragility over SSH; .bak backup kept for rollback.

## Files Modified
- `lib/federation-owner.js`, `lib/federation-envelope.js`, `lib/federation-peers.js`, `lib/federation-config.js`, `lib/federation-daemon.js`, `lib/poller.js`, `bin/belfry.js`: Phase 1 code (committed 86edd28).
- `test/federation-owner|envelope|peers|config|daemon.test.js` + new `test/federation-priority-gate.test.js` + `test/poller.test.js`: +44 tests (committed 86edd28).
- `scripts/smoke-failover.mjs`: NEW failover smoke harness (committed db157e9).
- `docs/plan-38-fleet-telegram.md`: synced to reachableAt + marked DEPLOYED LIVE.
- `docs/federation.example.jsonc`, `CLAUDE.md`: documented BELFRY_HOST_PRIORITY.
- `/workspace/shared/belfry-launch.sh` (Jinn launcher, outside repo): BELFRY_HOST_PRIORITY=1 + peer priority 2.
- Erebus C:\Users\aesth\belfry-run.ps1 (remote, outside repo): dropped FED_ONLY, HOST_PRIORITY=2, peer Jinn priority 1.
- GitHub: created #43 (cold-start contention). #42 (fast heartbeat) created earlier.

## Follow-ups
- [ ] Phase 2: cross-host inbound forwarding (so a survivor reaches ALL sessions, not just its own + deterministic routing). Plan §2 in docs/plan-38-fleet-telegram.md. The kill test exposed the gap: while Erebus owned the bot, messages for Jinn-sessions would drop (no forwarding) and Erebus's brain is down (claude ENOENT).
- [ ] GitHub #43: ranked standby should defer first poll until it's heard gossip (kills the ~47s cold-start flap).
- [ ] GitHub #42: fast owner heartbeat (~90s failover → ~10-30s).
- [ ] Phase D eventually: tag v0.3.0, merge feature/agent-mesh → main, delete superseded branches.
- [ ] Consider committing the Jinn launcher change if /workspace/shared is version-controlled.

## End of content.
