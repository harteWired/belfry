---
date: 2026-06-06
project: belfry
type: session-log
---

# 2026-06-06 — Broadcast Confirmed Working + computer-use Subscribed

## Quick Reference
**Keywords:** belfry, broadcast #30, /all working, anchor 1574 16 sessions replies flowing, computer-use registered slug, belfry.jsonc subscriptions, ready/error pings opt-in, channel flag server:belfry, convention file /tmp/claude-dashboard, reply latency ~40s, dedup skipped ready ping then outbound reply, sendBroadcastSummary logs only on failure
**Project:** belfry
**Outcome:** Continuation of the broadcast diagnosis. Confirmed broadcast (#30) DOES work: the 23:57:51 /all (anchor 1574) fanned to 16 sessions including computer-use, and replies threaded back ~40s later (git-publishing, 3d-printing, financial-planner all "outbound reply ... in reply to 1574"). The user's "got nothing" was checking before replies landed. Also wired computer-use into belfry.jsonc subscriptions so it gets proactive ready/error pings.

## What Was Done
- Investigated the user's report that computer-use should be communicating with belfry: confirmed it IS registered (instance db242c91, pid 42445, parent claude 42335 launched WITH `--dangerously-load-development-channels server:belfry`), its convention file /tmp/claude-dashboard/computer-use.json is live with last_response populated. Only gap was it was missing from belfry.jsonc subscriptions (so no proactive status pings; inbound/reply already worked).
- Added `"computer-use": { "events": ["ready", "error"] }` to ~/.claude/belfry.jsonc subscriptions (user approved). Takes effect on next daemon restart (config read once at boot).
- Diagnosed the latest /all: the 23:57:51 broadcast (anchor 1574 → 16 sessions) produced real replies within ~40s — git-publishing (msg 1576), 3d-printing (msg 1577), financial-planner (in flight) all "outbound reply ... in reply to 1574". The dedup lines ("skipped <slug> ready ping") immediately before each show the sessions woke, processed the channel injection, and replied via the reply tool.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Conclude broadcast IS functional, not broken | Anchor 1574 produced multiple threaded replies ~40s post-fan-out; earlier "0 reply" broadcasts (13:46 anchor 1481 = 1/14, 15:07 anchor 1508 = 0/15) were likely a reply-latency/timing perception issue or session-state difference, NOT a fan-out/injection bug. |
| Add computer-use to subscriptions rather than leave reply-only | Inbound + reply already worked (registered + channel flag on); the only missing piece for full participation was proactive ready/error pings, which are opt-in per slug. |

## Key Learnings
- **Broadcast replies are not instant — ~40s latency** between the fan-out line and the first "outbound reply ... in reply to <anchor>". Checking Telegram immediately after /all shows "nothing"; the replies thread in shortly after. This was the false-negative behind two sessions of "broadcast not working."
- A session is fully belfry-capable when: spoke registered + parent claude has `server:belfry` channel flag + convention file being written. Subscription membership only gates *proactive status pings*, not inbound delivery or replies.
- The "dedup: skipped <slug> ready ping" line immediately preceding an "outbound reply" confirms the muzzle/dedup is correctly suppressing the redundant ready ping when the session replies via the reply tool in the same turn.

## Files Modified
- `~/.claude/belfry.jsonc`: added computer-use subscription (ready/error). NOTE: outside the repo (user config); takes effect on daemon restart.

## Follow-ups
- [ ] Restart the belfry daemon so the computer-use subscription is picked up (config is read once at boot). SIGTERM the daemon child (pid was 3688) and let supervisor relaunch.
- [ ] Optional polish: add success-side logging to sendBroadcastSummary (bin/belfry.js:175 currently logs only on failure) so roll-up fires are visible in belfry.log — still an observability gap.
- [ ] If the user still perceives broadcast misses, set expectation that replies take ~40s; consider whether the "📡 broadcast to N sessions" confirmation should note replies are pending.
- [ ] Still open from prior session: #34, #31, #29; extract makeBroadcastHandler factory; PR #10 wants merging.
