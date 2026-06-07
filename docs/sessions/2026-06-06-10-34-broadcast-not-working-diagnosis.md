---
date: 2026-06-06
project: belfry
type: session-log
---

# 2026-06-06 — Broadcast Not Working — Crash-Recovery Diagnosis

## Quick Reference
**Keywords:** belfry, broadcast #30, /all not working, broadcast-tracker roll-up never fires, sendBroadcastSummary logs only on failure, registry.broadcast fan-out, notifications/claude/channel injection, broadcast="true" succinct-reply instruction, near-zero reply rate, anchor 1481 1/14, anchor 1508 0/15, crash mid-troubleshoot no compress, belfry.log /workspace/.belfry, spoke pid 86790 parent claude 12250, live-test pending
**Project:** belfry
**Outcome:** Resumed after a crash that lost the broadcast-troubleshooting context. Reconstructed state from belfry.log + code: fan-out works, but today's two broadcasts got near-zero replies (13:46→1/14, 15:07→0/15) and NO completion roll-up has ever appeared in the log. Narrowed to two open questions; set up a definitive live test (this session's own spoke is registered, so the next /all should inject directly into it). Diagnosis incomplete — awaiting the user's next test broadcast when the session was compressed.

## What Was Done
- Recovered post-crash state: working tree clean, v0.2.0 broadcast shipped/committed, daemon (pid 3688) + supervisor + brain + ~15 session spokes all running. No code lost — crash only cost the troubleshooting context.
- Read belfry.log (/workspace/.belfry/belfry.log): two broadcasts today both fanned out cleanly at the daemon level — 13:46 → 14 sessions (anchor 1481), 15:07 → 15 sessions (anchor 1508).
- Found only ONE session ever replied to a broadcast (health-dash, msg 1484, to the 13:46 anchor); the 15:07 broadcast got zero replies. No "Broadcast complete"/roll-up line has EVER appeared in the log.
- Traced the code path: bin/belfry.js onBroadcast (lines 305-353), the sendOutbound reply tap (line 259-261 → broadcastTracker.record), lib/broadcast-tracker.js (120s timer, _complete → onComplete), lib/broadcast-summary.js (buildBroadcastSummary — handles 0-reply timeout fine).
- Confirmed the injection path is architecturally sound: bin/belfry-mcp.js recvLoop → injectChannelMessage emits notifications/claude/channel with broadcast=true; all sessions run with the required `server:belfry` channel flag.
- Identified this session's own spoke: belfry-mcp pid 86790, parent claude pid 12250 — registered as `belfry`, so a /all should land on this session directly. Snapshotted log at line 2737 / 15:11 UTC for a clean diff against the next broadcast.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Treat the near-zero reply rate as the primary smell, not the daemon fan-out | Fan-out logs the aggregate line correctly both times; the failure is downstream (sessions not engaging or roll-up not surfacing). |
| Use this session's own registered spoke as the definitive live test | If the next /all injects a `<channel broadcast="true">` into THIS session, injection works end-to-end and the bug is sessions choosing not to reply; if it doesn't arrive, fan-out queues aren't draining to the models. Splits the problem cleanly in one shot. |
| Don't over-read code before the live test | sendBroadcastSummary + buildBroadcastSummary are clean; further static reading can't resolve "did the roll-up post to Telegram?" — only the user's Telegram view or a live broadcast can. |

## Key Learnings
- **sendBroadcastSummary logs ONLY on failure** (bin/belfry.js:175 `.catch` logs "broadcast summary failed"); a successful roll-up writes nothing to belfry.log. So the absence of a roll-up line does NOT prove the roll-up didn't fire — it could have posted to Telegram silently. This is a real observability gap worth closing (log roll-up success too).
- The 15:07 roll-up was due at ~15:09:42 (anchor +120s default BELFRY_BROADCAST_TIMEOUT_MS); at 15:11 the log ended exactly at the broadcast line (2737) with no failure line either way — genuinely ambiguous from logs alone.
- broadcastTracker.start IS reached for the telegram path (anchorId = user's /all message id, count>0), so the timer should arm. Timer is unref'd but the daemon's HTTP server + poller keep the loop alive, so unref alone shouldn't suppress it.
- The MCP `broadcast="true"` instruction tells sessions to "skip routine acknowledgements" — a plausible explanation for low replies if sessions read it too aggressively (suspected, not confirmed).

## Files Modified
- None (diagnosis-only session; no code changed). Only docs/sessions/.resume-log breadcrumb touched by /resume.

## Follow-ups
- [ ] LIVE TEST (next action): user is sending a test broadcast — confirm whether THIS session receives the `<channel source="belfry" broadcast="true">` injection. Receive = injection works, bug is reply-engagement; no-receive = fan-out queue not draining.
- [ ] Confirm with user whether a `⏱ Broadcast 0/15` / `📋 Broadcast complete` roll-up actually appeared on Telegram for the 15:07 broadcast.
- [ ] Add success-side logging to sendBroadcastSummary (close the observability gap so roll-up fires are visible in belfry.log).
- [ ] If injection works but sessions stay silent: revisit the broadcast="true" "skip routine acknowledgements" instruction in bin/belfry-mcp.js — it may suppress test-broadcast replies too aggressively.
- [ ] Snapshot reference for diffing: belfry.log was at line 2737, 15:11 UTC, before the pending test broadcast.
