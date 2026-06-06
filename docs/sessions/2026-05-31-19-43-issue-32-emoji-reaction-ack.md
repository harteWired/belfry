---
date: 2026-05-31
project: belfry
type: session-log
---

# 2026-05-31 — Issue #32: Emoji-Reaction Inbound Ack (incremental)

## Quick Reference
**Keywords:** belfry, issue #32, setMessageReaction Telegram Bot API, 👀 emoji ack, BELFRY_REACT_EMOJI env var, fire-and-forget reaction, registry.deliver hook site, free-tier bot emoji set, leave-vs-replace-vs-clear on reply, broadcast and spawn/kill compose naturally, ~30 LOC v0.1.x point release, lib/telegram.js setMessageReaction helper
**Project:** belfry
**Outcome:** Filed issue #32 — emoji reaction (default 👀) on the inbound Telegram message at the moment `registry.deliver()` is called, as the cheapest possible "received, working on it" ack before the model's reply lands. Configurable via `BELFRY_REACT_EMOJI`, fire-and-forget so reaction failure can't block delivery, scoped to actual `deliver` actions only (skips `unmatched`, reserved commands, dropped updates). ~30 LOC additive change in `lib/telegram.js` + `bin/belfry.js`, small enough to ship as a v0.1.x point release without waiting for v0.2.0.

## What Was Done
- User requested an emoji-reaction-as-ack feature on Telegram inbound. Confirmed `lib/telegram.js` has no existing reaction helper via grep — clean additive surface, no refactor required.
- Filed **issue #32 — "Emoji reaction on inbound as 'received, working on it' ack before reply lands"** (https://github.com/harteWired/belfry/issues/32).
- Designed the wire site: call `setMessageReaction` immediately after `registry.deliver()` succeeds for a `deliver` action in `bin/belfry.js`'s router-action dispatch — no await on the daemon's hot path. Same one-line wiring will compose at the broadcast (#30) and `/spawn` / `/kill` (#31) dispatch sites when those land.
- Defined the exclusion set explicitly: `unmatched` actions (no session to ack), reserved commands `/status` `/help` `/nick` `/unnick` `/nicks` `/resume` `/full` (already produce text replies), and dropped updates (wrong chat_id, empty text without quote/topic) all stay unreacted.
- Listed Telegram's free-tier reaction emoji set in the issue body so future implementers don't have to look it up — 👀, ✍️, 🤔 are all on it.
- Surfaced the "what happens when the reply lands" decision tree: leave 👀 in place (recommended for v1, simplest, lowest API volume), replace with ✅ on `sendOutbound` (follow-up — requires threading the originating message_id, already available via `markOwesReply`/`replyTracker`), or clear the reaction entirely (cleanest visually, loses the trace).
- Decided NOT to react when `registry.deliver()` returns 0 (no registered instance for the slug) — the user's mental model of "received, working" implies a session is on it; reacting when nobody's listening would be misleading. Silence stays the signal for the drop case.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Default to 👀 specifically | On Telegram's free-tier reaction list (no premium required), reads intuitively as "eyes on it / received," and avoids the false-positive risk of ✅ which the user would reasonably interpret as "done." |
| `BELFRY_REACT_EMOJI` env var with empty-string-disables semantics | Single knob: change the default, or turn the feature off entirely without code change. Avoids a `belfry.jsonc` schema bump for what's essentially personal taste. |
| Fire-and-forget; failures log and continue | Reactions are decorative — a failed `setMessageReaction` (e.g., Telegram rate-limit, invalid emoji on a non-premium bot, network blip) must never block message delivery. Wrapped in try/catch, logged, daemon moves on. |
| Only react on `deliver` and (future) `broadcast` actions | `unmatched` would falsely imply belfry understood when it didn't. Reserved commands already produce text acks within milliseconds — emoji on top is noise. Dropped updates are silent by contract. Reacting only where there's a real session-bound delivery preserves the signal's meaning. |
| v1 = leave the 👀 in place after reply | Adding a "switch to ✅ on reply" pass is additive and possible later; shipping v1 without it eliminates one extra Telegram API call per reply and avoids threading the originating message_id through paths that don't already need it. The reply text is itself the "done" signal; the 👀 becomes the visible trace of "this was the message I worked on." |
| Don't react when `registry.deliver()` returns 0 instances | A 👀 on a message that went nowhere would mislead. The drop is already logged daemon-side; the user noticing "no reply, no reaction" is the right cue to investigate (likely an unregistered slug, same diagnosis we walked through earlier today). |
| Ship as v0.1.x point release, not bundled into v0.2.0 | ~30 LOC additive change, two files, no interaction with throttle/muzzle/dedup, no new endpoints. Risk-isolated from #29/#30/#31. Composing it forward when those land is one extra `setMessageReaction` call at each new dispatch site — trivial. |

## Solutions & Fixes
- **Diagnostic confirmation that the surface is clean.** Grepped `lib/telegram.js` for any existing reaction or `setMessageReaction` references — none. This is a pure addition, no refactor to coordinate with in-flight work on #29/#30/#31.

## Key Learnings
- **Telegram standard-bot reactions are limited to a fixed free emoji set, not arbitrary.** Premium emoji require Telegram Premium on the sender side, which is out of scope for a bot. The set is large enough (~70 emoji) to cover any reasonable ack semantic — 👀, ✍️, 🤔 for "working," ✅ for "done," 👍 for "got it" — but documenting the constraint in the issue body matters so the implementer doesn't waste time trying 🛠 or 🧠 and getting a Bad Request.
- **The router-action dispatch in `bin/belfry.js` is the right composition point for "ack-on-route" features.** Every action — `deliver`, `broadcast` (future), `spawn`/`kill` (future), reserved commands, `unmatched` — funnels through the same switch. Wiring an ack at the right cases inside that switch (and explicitly NOT wiring it at others) is a small surface change but encodes a meaningful semantic distinction: "belfry both understood AND has a session on it." Worth treating that switch as the canonical ack-hook site for future features in the same family.
- **Composing four open feature issues across one hot path.** #29 (federation), #30 (broadcast), #31 (spawn/kill), and #32 (reaction ack) all touch the same router-action dispatch. Filing them as design-conversation issues (vs. picking one and merging it) keeps the surface visible — when the user is ready to implement, the composition order is obvious: reactions first (smallest, isolated), then broadcast (additive endpoint), then spawn/kill (additive endpoint with similar shape), then federation last (changes the meaning of slug keys). Four issues, three of them shippable independently, federation as the architecture pivot.

## Files Modified
- None — issue-only session.

The substantive output is one GitHub issue:
- https://github.com/harteWired/belfry/issues/32 — Emoji reaction on inbound as ack

## Follow-ups
- [ ] **Implement #32** when the user is ready — smallest of the four open belfry feature issues. v0.1.x point release shape, ~30 LOC + a test.
- [ ] **Optional v2 of #32:** switch the reaction to ✅ (or clear it) when `sendOutbound` fires for the same originating message_id. Wiring already exists via `replyTracker`/`markOwesReply`; ship if the "is it done?" question turns out to come up in practice.
- [ ] **Carried open from prior session (12:53 compress):** Decide cybersecurity/pdf-publisher/banff subscription additions; document the bidirectional-vs-auto-status-ping distinction; verify v0.1.5 time-window muzzle holding; verify `belfry-doctor` watchdog cron `ded04b2b` still firing; PR #10 merge timing; daemon→Telegram heartbeat; `test/doctor.test.js`; brain `reply` bypassing `sendOutbound`; hook-writer reconciliation; HTML format on remaining reply paths; OversizeCache 50-entry ceiling.
