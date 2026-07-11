---
date: 2026-07-10
project: belfry
type: session-log
---

# 2026-07-10 — Inbound files (3 stacked bugs), wintermute-only broadcast gate, agent→human bridge, v0.5.0

## Quick Reference
**Keywords:** belfry, inbound files, #41, photo attachment, file_id federation forward, caption-less photo, empty text envelope, spoke recv guard, delivery-target attachment drop, mesh mirror #39, telegram bridge slug, send_to telegram, agent to human push, broadcast gate, wintermute-only, /fed/broadcast, broadcastHosts, BELFRY_BROADCAST_LOCAL, plex-manager driver spam, anime_regrab_driver, matchBroadcast, self-qualified send_to, localSlug, v0.5.0 release, issue triage, erebus belfry-run.ps1 corruption
**Project:** belfry
**Outcome:** Session spanning 2026-07-05→07-10. Shipped the agent→human Telegram bridge (send_to "telegram", same-host completion of #44) and the #39 mesh mirror (built then policy-reverted to off per Matt: "Wintermute should manage what hits telegram"). Enforced Matt's "no agent other than wintermute may broadcast" fleet-wide (local /broadcast closed by default + new allowlisted /fed/broadcast) after tracing "no sessions registered" phone spam to plex-manager's headless anime driver on Erebus. Fixed inbound images end-to-end — three stacked bugs, live-verified with Matt's photo visible to the model — and shipped inbound documents (#41 closed). Cut v0.5.0, closed 8 issues total.

## What Was Done
- **Agent→human bridge (f8a3a97):** Matt "was getting nothing from wintermute itself to telegram." The cross-host path existed since #44 (telegramBridge slug); closed the same-host gap — `registry.humanTarget` (wired via `setHumanTarget` on creds-bearing daemons) routes a local `send_to("telegram")` to the chat, headered with the sender, reply-anchored. Documented in both spokes' send_to descriptions. Wintermute's Conductor adopted it (WINTERMUTE_NOTIFY_ADDRESS=f/telegram, verified live).
- **Mesh mirror (#39 Telegram half, 7bd9d97):** `mesh` jsonc block (`telegram` default + per-slug `telegramOverrides`, matched either endpoint, bare keys catch host-qualified) mirroring a2a relays via a receiver-side `registry.setAgentRelayObserver` hook. Built for "make wintermute's messages hit telegram", then Matt clarified he wanted sender-controlled signal, not surveillance — mirror config reverted to OFF (feature stays, default none).
- **Broadcast spam traced + killed:** "📡 broadcast — no sessions registered" phone spam = plex-manager's headless `anime_regrab_driver.py` on Erebus POSTing local /broadcast with target_slugs:["computer-use"] (a Jinn slug; /broadcast is host-local → 0 matches → confirmation to phone per event). plex-manager self-patched (file-based events). Belfry hardening 9c216f5: anchorless 0-recipient broadcast (new `registry.matchBroadcast` precount) sends nothing to Telegram.
- **Wintermute-only broadcast policy (f120239), Matt verbatim "No agent other than wintermute should be able to broadcast":** local POST /broadcast closed by default (BELFRY_BROADCAST_LOCAL reopens per host); new POST /fed/broadcast ('broadcast' envelope kind) gated by fed bearer + per-host broadcastHosts allowlist (BELFRY_FED_BROADCAST_HOSTS, fleet=w only). Human /all untouched. Deployed j/f/e; both gates live-verified (fed refusal + local 403). Conductor handed the call shape (no executor wired yet on w — post-buildout per Matt).
- **Inbound files (#41) — three stacked bugs fixed, each hidden behind the last:**
  1. 211183a — delivery-target dropped ALL attachments for federated targets ("text-only over the bridge"); with sessionless Fornax owning the bot, EVERY inbound is federated. Fix: attachments cross the mesh as Telegram `file_id`; receiving host re-downloads with its own token (file access not owner-exclusive) into its own attachment dir. fileId carried even when owner-side download fails.
  2. bce42bb — inbound envelope rejected empty text; a caption-less photo (routes with empty text via quote-reply) failed to build the forward. Empty text now legal with an attachment.
  3. f48c228 — broker/spoke recv guard required text.length>0, silently discarding photo-only deliveries one hop from the session with the file already on disk. Now injects with "[photo attached]" placeholder (harness silently drops empty-text notifications, #37 lesson).
  Plus inbound documents: same fileId flow, surfaced as "[attached file … saved to <path>]" appended at the registry.deliver chokepoint (zero spoke changes). Live-verified: Matt's photo visible to the model in-session.
- **Fix 5455d32:** self-qualified send_to ("j/wintermute" on host j) resolved local then failed the bare-slug lookup → silent drop (06-19 review warning, bit live). Router local fallthrough now returns localSlug.
- **v0.5.0 released** + 8 issues closed with implementation-pointing comments: #41, #34, #35, #36, #37, #38, #44, #48. Left open deliberately: #49, #47, #42, #43, #39 (terminal knob + summary mode), #28/#29/#31.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Attachments cross the mesh as file_id, not bytes | Owner's local path is meaningless on another host; envelope stays tiny (80KB body cap); receiving host's own bot token can download (not owner-exclusive) |
| Documents surface as text-appended path at registry.deliver | Channel injection has no document param the harness renders; one chokepoint covers poller-local, fed-inbound and local-self redeliver with zero spoke/broker changes |
| "[photo attached]" placeholder instead of empty-text injection | #37 taught that the harness drops malformed/empty notifications silently — never emit empty text |
| Broadcast authz = fed bearer (transport) + per-host broadcastHosts allowlist (policy) | Only daemons hold the fed token; allowlist decides which mesh identity may fan out. Local /broadcast default-closed kills the loopback-token hole |
| Mirror is receiver-controlled, bridge is sender-controlled; Matt chose sender-controlled for Wintermute | "Wintermute should manage what hits telegram" — mirror stays available but off |
| Fleet deploy without per-host confirmation | Matt's policy directives ("no agent other than wintermute…", "make sure…") taken as the go-ahead; owner-restart blips self-heal per #38 |

## Key Learnings
- **A sessionless bot owner makes EVERY inbound federated** — same-host-only features silently die at the flip. Grep for "text-only" style local/fed asymmetries when something "stops working" after topology changes.
- **Layered pipelines hide bugs in series:** three fixes each moved the photo one hop; only live retries by the user exposed the next layer. The logs told the truth each time (Fornax journal + Jinn log + attachment dir).
- **NEVER use PowerShell `-replace` with interpolated patterns via remote-ops** — a mangled pattern exploded Erebus's belfry-run.ps1 to 138KB (caught pre-restart, restored from .bak-peerw, re-patched with literal [IO.File] .Replace, new backup .bak-w-broadcast).
- The daemon supervisor bakes env at launch — env changes need a SUPERVISOR restart (kill -TERM supervisor + re-run belfry-launch.sh), not a child kill.
- test/belfry-mcp.test.js had a stale assertion (reply required:['text']) failing since outbound files shipped — full-suite hangs also recur; run per-file.

## Solutions & Fixes
- Wintermute→Telegram: send_to("f/telegram") from host w (existing #44 path, just undocumented) + same-host humanTarget for completeness.
- Broadcast spam: driver patched at source (plex-manager), 0-recipient suppression + default-deny local /broadcast in belfry.
- Erebus belfry-run.ps1 corruption: restored from .bak-peerw + literal string patch; fresh .bak-w-broadcast saved.
- Caption-less photo: envelope + spoke-guard fixes (see What Was Done).

## Files Modified
- `lib/config.js`: mesh block parse + meshTelegramMode (#39)
- `lib/registry.js`: setAgentRelayObserver + humanTarget + matchBroadcast + local-broadcast 403 gate + document text-append + localSlug send-to fallthrough
- `bin/belfry.js`: mirror wiring, humanTarget wiring, fed onFedBroadcast + downloadAttachment injection, BELFRY_BROADCAST_LOCAL gate, 0-recipient suppression
- `lib/federation-envelope.js`: 'broadcast' kind; inbound attachment field; empty-text-with-attachment allowance
- `lib/federation-config.js`: broadcastHosts allowlist
- `lib/federation-server.js`: /fed/broadcast route
- `lib/federation-daemon.js`: onBroadcastEnv allowlist gate; forwardInbound attachment; onInbound download; localSlug
- `lib/delivery-target.js`: fed attachment forward (was: drop)
- `lib/poller.js`: extractAttachment (photos + documents, fileId always carried), sanitizeFileName
- `bin/belfry-broker.js` + `bin/belfry-mcp.js`: recv guard fix + placeholder; send_to description (telegram bridge)
- `test/*`: ~35 new tests across config/registry/envelope/fed-config/fed-daemon/delivery-target/poller/belfry-mcp
- `CLAUDE.md`: bridge, mirror, broadcast policy, inbound files, env table
- `docs/belfry.jsonc.example`: mesh block
- Fleet: /workspace/shared/belfry-launch.sh (j), /etc/belfry/belfry.env (f), belfry-run.ps1 (e) — BELFRY_FED_BROADCAST_HOSTS=w
- Commits: 7bd9d97, f8a3a97, 5455d32, 9c216f5, f120239, 211183a, bce42bb, f48c228, 7494383 (v0.5.0) — all pushed; release published

## Follow-ups
- [ ] #47 remote watch (only Tier-1 discovery shipped), #42/#43 federation follow-ups, #39 terminal knob + summary mode
- [ ] >4MB attachment cap + voice-note file forwarding (noted on closed #41)
- [ ] Wintermute Conductor: /fed/broadcast executor is queued post-buildout (operator-driven until then)
- [ ] Untracked session log 2026-06-21-20-55 contains Tailscale IPs — needs a privacy scrub before committing (public repo)
- [ ] Mystery: Jinn daemon bounced on its own mid-edit on 07-05 (~23:34Z) — never chased
