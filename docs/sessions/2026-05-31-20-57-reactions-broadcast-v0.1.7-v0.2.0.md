---
date: 2026-05-31
project: belfry
type: session-log
reconstructed: true
---

# 2026-05-31 — Routing-Status Reactions (#32/#33) + Broadcast (#30) — v0.1.7 → v0.2.0

> **Reconstructed from git history, not a live transcript.** The session that
> produced these three commits ended without `/compress`, so this log is
> rebuilt from the commit messages (2026-05-31 20:57–23:29 PT) during the
> next `/resume`. Details below are faithful to the commits; the blow-by-blow
> reasoning of the live session is gone.

## Quick Reference
**Keywords:** belfry, issue #32 routing-status reactions, 👀 delivered / 🤷 dropped / 🤔 unmatched, issue #33 reply-only-on-belfry-turns, 👀→🫡 replied swap, issue #30 broadcast /all belfry-broadcast, lib/reactions.js, setMessageReaction Bot API, BELFRY_REACT off-switch, REACTION_INVALID no-green-check 🫡 salute, lib/broadcast-tracker.js completion roll-up, lib/broadcast-summary.js denominator=expected-fanout, accepts_broadcast opt-out, channel injection NOT slash execution, 4-agent review 0 critical, filed #34, v0.1.7 v0.1.8 v0.2.0
**Project:** belfry
**Outcome:** Shipped three releases in one sitting. **v0.1.7** — routing-status emoji reactions (#32, upgraded from the issue's plain-👀 spec to a routing-*outcome* map: 👀 delivered / 🤷 slug-known-no-session / 🤔 unmatched), plus the #33 fix (reply tool valid only on belfry-tagged turns, rewrote belfry-mcp instructions + reply description). **v0.1.8** — 👀→🫡 swap when the session answers, so an inbound shows its full lifecycle (received → answered); default 🫡 not ✅ because Telegram's standard bot-reaction set has no green check (✅/✔️ both 400 REACTION_INVALID, caught live). **v0.2.0** — broadcast: `/all <msg>` (Telegram) + `belfry-broadcast` (local CLI) fan one message to every registered session, with a completion roll-up (`📋 Broadcast complete N/N`) threaded under a single anchor. Each release passed a 4-agent review (bug/security/perf/arch) + judge with 0 critical. Filed **#34** (🤔 persists when the brain routes an unmatched message — should upgrade 🤔→👀), surfaced by the reaction work.

## What Was Done

### v0.1.7 — routing-status reactions (#32) + reply-only-on-belfry-turns (#33)
- **#32:** React to each inbound the moment routing resolves, as a pre-reply ack landing before the model's text. Outcome map (not the issue's plain 👀): 👀 ≥1 live session, 🤷 slug known but nothing registered, 🤔 no deterministic route. A reaction carries no text → signals the *outcome*, not the destination slug (that rides on the `<slug>:` reply header).
  - `lib/reactions.js` (new) — policy + config: `BELFRY_REACT` master off-switch; `BELFRY_REACT_DELIVERED/DROPPED/UNMATCHED` per-state overrides (empty string disables one state). On by default.
  - `lib/telegram.js` — `setMessageReaction` (raw Bot API; empty array clears).
  - `lib/poller.js` — `reactToRouting` fired at the deliver + unmatched dispatch sites. Fire-and-forget; a failed reaction never blocks delivery.
- **#33:** The reply tool was pushing terminal-origin answers to Telegram once a belfry thread was open (terminal input carries no `<channel>` tag → absence became load-bearing). Fix chosen = the "stronger MCP instruction" option: rewrote belfry-mcp server `instructions` + `reply` tool description — reply only on a belfry-tagged turn; terminal is the canonical full transcript, never carry less than what went to the phone.
- Review (4-agent + judge): 0 critical. Both warnings landed — deliver-throw now still surfaces 🤷 (try/catch, fanout stays 0) instead of going silent; documented the photo-download ack-latency trade-off and the in-class reaction exception. Kept fanout-from-deliver over a hasSlug pre-check (hasSlug can't see in-deliver idle-GC eviction).
- Tests: +reactions, +telegram(setMessageReaction), +9 poller reaction cases incl. deliver-throw regression. Suite green (395).

### v0.1.8 — 👀→🫡 swap on reply (#32 follow-on)
- `sendOutbound` swaps the inbound's 👀 to 🫡 once the session answers → full lifecycle 👀 received → 🫡 answered. Driven by the registry's owes-reply marker (set only for delivered inbounds) → 🤷/🤔 never get the swap.
- `lib/reactions.js` — new `replied` state + `BELFRY_REACT_REPLIED`.
- `bin/belfry.js` — swap in sendOutbound (fire-and-forget, after the send); `reactEmoji` resolution hoisted above sendOutbound.
- Default 🫡, **not** a checkmark: Telegram's standard bot set has no green check (✅/✔️ → 400 REACTION_INVALID, caught live; failure was graceful — reply still sent, 👀 stayed). Fixed the v0.1.7 comment that wrongly listed ✅ as valid.
- Filed **#34** for the related bug the work surfaced.

### v0.2.0 — broadcast (#30)
- `/all <msg>` (Telegram, slash required) + `belfry-broadcast "<msg>"` (local CLI, `--only`/`--except`) fan to every registered session. Sessions receive **text they interpret, not a slash command** (channel injection wraps in `<channel>`, so `/all /compress` sends literal text). Queue item carries `broadcast:true` → `broadcast="true"` on the tag → belfry-mcp instructions tell each session to reply succinctly.
- Completion roll-up: threads every reply under one anchor (the `/all` message; a placeholder for CLI), tracks the in-flight broadcast, posts `📋 Broadcast complete (N/N)` when all answer or `BELFRY_BROADCAST_TIMEOUT_MS` (default 2m) elapses, listing non-responders. Composes with reactions (👀 fan-out, 🫡 on answer).
  - `lib/registry.js` — `broadcast()` + `_pushToInstance` (factored from `deliver()`) + `accepts_broadcast` at register + `POST /broadcast` (same auth/Host/CSRF gate as `/send`) + `onBroadcast` hook.
  - `lib/broadcast-tracker.js` — completion/timeout state machine (injectable timers, keyed on anchor message_id).
  - `lib/broadcast-summary.js` — pure roll-up builder (denominator = expected fan-out, not response count).
  - `lib/router.js` — `/all` branch (slash-required, quote-reply excluded, `all` reserved). `lib/poller.js` — broadcast dispatch + 👀/🤷 react.
  - `bin/belfry.js` — `onBroadcast` orchestrator + reply-tap in sendOutbound. `bin/belfry-broadcast.js` — local CLI. `bin/belfry-mcp.js` — `BELFRY_BROADCAST` opt-out + succinct instruction.
- Opt-out is spoke-side (`BELFRY_BROADCAST=false` → `accepts_broadcast:false`). `target_slugs`/`exclude_slugs` shape forward-compatible with #29 federation. No new deps.
- 4-agent review + fixes: 0 critical. Landed summary-denominator fix (untargeted thread-replies no longer inflate N/N), pre-clip before whitespace-collapse, `BELFRY_BROADCAST_TIMEOUT_MS=0` guard + startup log.

## Key Learnings
- **Telegram standard bots have no green-check reaction.** ✅/✔️ both 400 with `REACTION_INVALID`. The "done" marker is 🫡 (salute). Free set is ~70 emoji (👀 ✍️ 🤔 🫡 🤷 all in scope).
- **A reaction is outcome, not destination.** It carries no text, so it can only signal the routing result; the target slug rides on the `<slug>:` reply header.
- **`fanout` from `deliver()` beats a `hasSlug` pre-check** for the delivered/dropped decision — only the real fan-out count sees in-deliver idle-GC eviction.

## Follow-ups
- **#34** (filed this session) — 🤔 persists when the brain routes an unmatched message to a real slug; should upgrade 🤔→👀. *(Fixed in the next session — see 2026-06-06.)*
- The owes-marker swap invariant has a latent edge: an explicit spoke-supplied `reply_to_message_id` would bypass it. belfry-mcp never sends one today.
