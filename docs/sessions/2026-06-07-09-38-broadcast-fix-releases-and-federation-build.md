---
date: 2026-06-07
project: belfry
type: session-log
---

# 2026-06-07 — Broadcast Root-Cause + v0.2.2/v0.2.3 Releases + Federation Build (paused)

## Quick Reference
**Keywords:** belfry, broadcast bug #37, meta.broadcast boolean ZodError drops channel notification, v0.2.2 v0.2.3 releases, #35 send-queue rate-limit 429 retry_after, #36 agent-to-agent send_to relay-guard, #29 federation decentralized mesh, floating Telegram owner 409 election, Tailscale, A2A envelope, host letters j-Jin e-Erebus n-NAS d-Daedalus-reserved, federation transport FederationClient FederationServer fail-closed, correlation-tracker Tier 1, feature/agent-mesh branch consolidation, idle-wake misdiagnosis, ON HOLD for Tailscale infra
**Project:** belfry
**Outcome:** Found and fixed the real "/all broadcast never works" bug (meta.broadcast was a boolean → fails the channel-notification Record<string,string> schema → whole notification silently dropped; broken since #30) and released it as v0.2.2. Released #35 rate-limiting as v0.2.3. Built the full agent-to-agent + federation stack (send_to, correlation, federation core + mesh transport), consolidated into branch feature/agent-mesh, and PAUSED before daemon wiring while the user builds out Tailscale infra (Belfry will deploy as part of that package).

## What Was Done
- Resumed mid-broadcast-troubleshooting. Initially mis-diagnosed the broadcast failure as reply-latency, then as "idle sessions don't wake on injection" (filed #37 for that, then corrected). User pushed back ("those sessions were warm"). Empirical test (registered throwaway instances; directed /send-to and /broadcast both delivered fine at /recv) proved the daemon was fine and the bug was downstream + broadcast-specific.
- ROOT CAUSE found in the per-session MCP debug logs: every broadcast threw `ZodError: params.meta.broadcast — expected string, received boolean`. The spoke set `meta.broadcast = true` (boolean); channel-notification `meta` is typed `Record<string,string>`, so the non-string value failed the MCP params schema and the ENTIRE notification was dropped silently. Directed messages worked (all-string meta). Broadcast had NEVER worked since #30 shipped (v0.2.0).
- Fixed: `params.meta.broadcast = 'true'` (string) + regression test asserting every channel-notification meta value is a string. User-validated on a restarted session. Released **v0.2.2** (clean cherry-pick onto main, tag, GitHub release). Repurposed/corrected #37 to the real cause; deleted the wrong idle-wake memory.
- Shipped **v0.2.3** = #35 outbound send-queue rate limiting (serial pacer for all Telegram writes, honors 429 retry_after with adaptive floor) — split cleanly off the feature branch (interim release per the user's strategy).
- Earlier in the session: built #36 Tier 0 agent-to-agent send_to (spoke tool → /send-to → registry.relayAgentMessage, provenance origin=agent/from, token-bucket+echo-dedup relay guard); 4-agent code review (0 critical, 4 warnings, applied the worthwhile ones); researched the agent-interop landscape (A2A/MCP/ACP under Linux Foundation; n8n).
- Designed federation #29 (decentralized, no single hub): two planes — a2a data plane = full P2P mesh; Telegram control plane = floating owner via Telegram's one-getUpdates-per-token (409) constraint as a free election mutex. Tailscale transport, gossip discovery, bare-or-`<letter>/<slug>` addressing, A2A-shaped envelope, config-driven identity (nothing host-specific committed). Wrote it into #29.
- Built the federation/a2a code (all unit-tested on Jin): federation-config, federation-address, federation-peers (gossip table), federation-owner (election state machine), federation-envelope (A2A message format), correlation-tracker (#36 Tier 1), and the mesh transport: federation-client (FederationClient.send) + federation-server (fail-closed FederationServer for /fed/announce|message|reply).
- Consolidated the branch sprawl into ONE integration branch **feature/agent-mesh** (off the line with #35+#36+broadcast-fix, + cherry-picked federation/correlation). 110+ tests green; +17 transport tests.
- PAUSED before the daemon wiring: user is building computer-use Tailscale infrastructure and will push Belfry as part of that package.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| meta.broadcast = string 'true' (not boolean) | channel-notification meta is Record<string,string>; a non-string value fails the MCP schema and drops the WHOLE notification. Confirmed by ZodError in the MCP debug log at every broadcast timestamp. |
| Release strategy: v0.3.0 = a2a feature-complete + cross-machine validated; interim v0.2.x until then | User wants all the agent-to-agent stuff cohesive in v0.3.0; ship done/independent pieces (broadcast fix, #35) as interim patch releases meanwhile. |
| Decentralized federation, NO single hub | User requirement: lose any node, the rest keep working. a2a = P2P mesh (no SPOF); Telegram = floating owner that auto-fails-over via the 409 mutex. |
| Separate fail-closed /fed/* listener (not the loopback registry) | The registry trusts any local process; exposing it to the network is unsafe. Federation gets its own server, mandatory bearer token (throws without one), explicit bind. |
| Nothing host-specific committed | User mandate; same posture as BELFRY_TOKEN. Host letter/name/peers/token all from config; repo + #29 stay generic. Real mapping (j/e/n/d) in private memory only. |
| Consolidate to feature/agent-mesh by basing on the branch that already had #35+#36+broadcast-fix, then cherry-pick federation/correlation new-file commits | Zero conflicts (federation/correlation are all new files); the eventual merge to main reconciles the equivalent #35/broadcast-fix patches cleanly. |

## Key Learnings
- **A passing broadcast roll-up (⏱ N/N) does NOT prove sessions received it.** The completion tracker fires on timeout regardless; the owes-reply marker makes unrelated replies thread under the broadcast anchor, so it LOOKED like sessions replied. Always verify session-side traces (new session logs / dashboard last_response) or the MCP debug log.
- **channel-notification `meta` values MUST be strings** (keys: identifiers only). A boolean drops the whole notification via schema validation. belfry's other meta (slug/ts/origin/from) were already strings.
- **The MCP debug log (`~/.cache/claude-cli-nodejs/<proj>/mcp-logs-belfry/*.jsonl`) is the first place to check** when a channel injection "doesn't reach" a session — it logs ZodErrors/connection errors. Should have checked it before theorizing.
- Idle-wake was a RED HERRING — directed messages reach idle sessions fine, so injection does wake them; the CLAUDE.md "transport is alive… idle… no can't-drain case" claim STANDS.
- Telegram's one-getUpdates-per-token (409 Conflict) is a free leader-election mutex — no coordinator needed for a floating Telegram owner.

## Files Modified
- `bin/belfry-mcp.js`: meta.broadcast → string 'true' (the fix). Earlier this session also: send_to tool + provenance (#36).
- `lib/send-queue.js` + `lib/telegram.js` + `lib/poller.js` + `bin/belfry.js`: #35 send-queue rate limiting (released v0.2.3).
- `lib/agent-relay-guard.js`, `lib/registry.js`: #36 send_to relay + guard.
- `lib/federation-{config,address,peers,owner,envelope,client,server}.js` + `lib/correlation-tracker.js`: federation/a2a stack (new).
- Tests alongside each. `main` → v0.2.2 then v0.2.3. New branch `feature/agent-mesh`.

## Follow-ups
- [ ] ⏸ ON HOLD: resume federation build only when the user says the Tailscale infra is ready (Belfry deploys as part of the computer-use Tailscale package).
- [ ] NEXT STEP on resume (on feature/agent-mesh): daemon wiring — start /fed/* listener if host-letter+token set; wire onAnnounce→PeerRegistry, onMessage→local deliver (+provenance, +guard, +correlation), onReply→correlation route.
- [ ] Then: gossip announce loop; send_to cross-host forwarding (resolve → local or FederationClient.send); life-planner bidirectional bridge (cross-repo: /api/inbox + reply callback); Windows launcher for Erebus.
- [ ] Then: deploy j/e/n on Tailscale, test j↔e send_to + the NAS life-planner bridge → tag v0.3.0.
- [ ] Cleanup: delete superseded branches (feat/federation-core, feat/agent-correlation, feat/send-queue-and-agent-messaging, fix/broadcast-meta, fix/broadcast-meta-string) once feature/agent-mesh is confirmed as the line.
- [ ] Doc: note in CLAUDE.md/README that channel meta values must be strings.
- [ ] Open issues: #36 (a2a), #29 (federation) stay open until v0.3.0; #34/#31/#28 untouched.
