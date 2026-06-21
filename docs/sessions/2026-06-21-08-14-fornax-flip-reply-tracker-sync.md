---
date: 2026-06-21
project: belfry
type: session-log
---

# 2026-06-21 — Fornax flip: reply-tracker-sync built, deployed, bot owner moved to the Pi

## Quick Reference
**Keywords:** belfry, #38, federation, reply-tracker-sync, replymap envelope, Fornax flip, bot-owner priority, BELFRY_HOST_PRIORITY, forwardInbound, quote-reply, gossip anchors, cold-start contention #43, remote-ops, fleet deploy, Jinn Erebus Fornax
**Project:** belfry
**Outcome:** Built the reply-tracker-sync (the last Fornax-flip prerequisite), deployed it fleet-wide, then moved the live Telegram bot owner from Jinn (p1) to the always-on Fornax Pi (p1) with Jinn→p2 / Erebus→p3. Both the cross-host forward path and the quote-reply-to-remote-session path verified live with Matt end-to-end.

## What Was Done
- **Built the reply-tracker-sync** — new `replymap` federation envelope kind. Every host gossips its `message_id→slug` reply-tracker anchors to peers; peers record them host-qualified (`<host>/<slug>`). This is the *resolution* half that lets a remote/sessionless bot owner resolve a quote-reply to a session living on another host; #38 Phase 2's `forwardInbound` is the *delivery* half.
- **Caught + fixed a real gap before flipping:** d7dbd7a wired `syncReplyMap` only into `sendOutbound` + full-expand, missing the **status-ping path** (`ready`/`error`/`waiting`) and the `/status`/rollup digests — exactly the messages users quote-reply. Centralized all anchor recording through one `recordReplyAnchor(messageId, slug)` chokepoint so a new send path can't silently skip the sync (18e271b).
- **Deployed fleet-wide** via remote-ops: Fornax (systemd `belfry.service`), Erebus (NSSM `belfry`, registry key `nuc`), Jinn (local supervisor). All on `18e271b`.
- **Proved the data plane live** before flipping: POSTed a synthetic `replymap` Jinn→Fornax (`200 {recorded:true}`) and confirmed Fornax persisted `j/belfry`. Then confirmed real anchors accumulating (`j/computer-use`, `j/belfry`) from live ping + reply traffic.
- **Executed the flip:** edited priority/peers on all three hosts (Fornax 9→1, Jinn 1→2, Erebus 2→3 + peer fields), restarted Fornax→Jinn→Erebus. Fornax acquired the bot; Jinn + Erebus stood by.
- **Live-verified with Matt** (he co-piloted from his phone): `/belfry flip test 1` forwarded Fornax→Jinn and the reply threaded back (forward path ✓); quote-reply "flip test 2" resolved on Fornax via the synced `j/belfry` anchor and forwarded back (reply-tracker-sync ✓).
- Hygiene: committed Jinn launcher demotion to the workspace repo (durability on rebuild); fixed Fornax's systemd unit description; closed task #16.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Broadcast anchors to ALL peers, not just the current owner | Robust to failover — whoever becomes owner already holds the anchors; no owner-tracking needed |
| Store remote anchors host-qualified (`<host>/<slug>`) in the same ReplyTracker | A qualified lookup result flows straight through the existing `FED_SLUG_RE` → `forwardInbound` path; no router changes, no collision with local bare-slug anchors |
| Centralize record+sync in one `recordReplyAnchor` chokepoint | The ping-path miss proved per-call-site wiring is bug-prone; one chokepoint makes "record without sync" structurally impossible |
| Verify the data plane on the Jinn-owner topology BEFORE flipping | The sync is a functional no-op while Jinn owns the bot, so the only pre-flip signal is the anchor file appearing on Fornax — which surfaced the ping-path bug |
| Fornax (Pi) as p1 primary owner | It's the always-on node (16h+ uptime); Jinn is a dev box more likely to be down — Matt's original concern that drove the flip |

## Solutions & Fixes
- **Status-ping anchors never synced** (the catch): pings/digests recorded via separate senders that bypassed `syncReplyMap`. Fixed by routing every record through `recordReplyAnchor`. Found by verifying Fornax held zero synced anchors despite Jinn pinging.
- **Jinn env-restart needs a SUPERVISOR restart, not a child restart:** the supervisor (detached, PPID 1) bakes in the env from launch time, so a child-kill respawns with the OLD priority. Fix: `kill -TERM` the supervisor (clean cascade to child via its TERM trap) + re-run `belfry-launch.sh` (idempotent; exits 0 if a live supervisor exists, so the kill must precede it).
- **Erebus env lives in `C:\Users\aesth\belfry-run.ps1`** (NSSM runs `powershell -File` that script), NOT in NSSM `AppEnvironmentExtra` — which read empty and sent me looking.

## Key Learnings
- **The reply-tracker is per-host and sits UPSTREAM of Phase 2.** Phase 2 forwards an inbound once a slug is known; the sync is what lets the owner *know the slug* for a quote-reply to a remote session's ping. Without it, moving bot ownership off the session hosts silently breaks every quote-reply.
- **#43 cold-start contention is real and visible:** the 3-host restart cascade caused ~2 min of ownership flapping (a freshly-restarted lower-priority host polls before its gossip view populates, transiently steals the bot, then backs off). It self-healed to the correct priority order every time, but it argues for the #42 fast-heartbeat / #43 startup-contention follow-ups.
- **Verify-before-flip paid for itself** — the pre-flip data-plane check is what surfaced the status-ping bug; flipping on d7dbd7a would have left quote-replies-to-pings (the primary interaction) broken under the new owner.

## Files Modified
- `lib/federation-envelope.js`: new `replymap` kind (build/parse/validate, `messageId`+`slug` fields)
- `lib/federation-server.js` / `lib/federation-client.js`: `/fed/replymap` route + client path
- `lib/federation-daemon.js`: `onReplyMap` (receiver, records qualified) + `syncReplyMap` (source, guarded fan-out) + `recordReplyMap` injection
- `bin/belfry.js`: `recordReplyAnchor` chokepoint; all 5 anchor sites routed through it; `recordReplyMap` wired to the registry
- `test/federation-envelope.test.js` / `test/federation-daemon.test.js`: replymap build/parse/guards + end-to-end sync→ReplyTracker resolve
- `docs/plan-38-fleet-telegram.md`: status line updated to reality
- `/workspace/shared/belfry-launch.sh` (workspace repo): Jinn priority 1→2, peers f=1/e=3
- Fleet config (on-box): Fornax `/etc/belfry/belfry.env` (p1), Erebus `belfry-run.ps1` (p3), Fornax systemd unit description

## Follow-ups
- [ ] #43 cold-start contention / #42 fast heartbeat — the restart-cascade flapping makes these worth doing (a freshly-started host shouldn't poll before its gossip view populates)
- [ ] Fornax's own `belfry.jsonc` whitelist (its local `fornax-master` session pings) — minor, owned by computer-use; not required for inbound routing, which is verified working
- [ ] Erebus brain throws `spawn claude ENOENT` (pre-existing PATH issue) — language layer down there; deterministic routing/federation unaffected
- [ ] Deferred Phase 2 maintainability refactors (OwesReplyState encapsulation, deliverFederated extraction, ownerMap memoize)
