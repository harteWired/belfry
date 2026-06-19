---
date: 2026-06-08
project: belfry
type: session-log
---

# 2026-06-08 — Federation Phase A→B: j↔e live over Tailscale, fed-only mode, Phase C bridge core

## Quick Reference
**Keywords:** belfry, federation #29, Phase A daemon wiring, BELFRY_FED_ONLY, j↔e cross-machine validated, Tailscale, Erebus NUC deploy, Daedalus socat forwarder port 38078, WinNAT reserved port, secrets-manager provisioned on Erebus age key, slug-listing bug chokidar 4 awaitWriteFinish seedCache, Telegram owner thrash outage, floating-owner election incomplete no inbound-forwarding, Phase C webhook bridge lib/bridge.js, /bridge/reply correlation, GitHub #38 owner hierarchy #39 gossip visibility, NSSM service .\aesth, feature/agent-mesh, NAS life-planner bridge deferred
**Project:** belfry
**Outcome:** Took federation from "Phase A built" to "j↔e validated live cross-machine over Tailscale." Wired Phase A into the daemon (commit 337962f), deployed belfry to Erebus, solved the Jinn-inbound problem with a Daedalus socat forwarder (no container rebuild), provisioned secrets-manager on Erebus, and proved bidirectional mesh. Fixed a slug-listing bug. Diagnosed + fixed a Telegram outage caused by Erebus competing for the bot (shipped BELFRY_FED_ONLY). Filed 2 GitHub feature requests. Built + tested the Phase C webhook-bridge core. NAS bridge deployment deferred (awaiting Matt's go — touches prod life-planner).

## What Was Done
- **Phase A daemon wiring (337962f, pushed):** new `lib/federation-daemon.js` `wireFederation()` factory (PeerRegistry + CorrelationTracker + FederationClient + fail-closed FederationServer, /fed/announce|message|reply handlers, relayRemote send_to router, gossip loop). `bin/belfry.js` boots it when BELFRY_HOST_LETTER+BELFRY_FED_TOKEN set; passes TelegramOwner to the poller (409→standby). `lib/registry.js` setFederationRouter + relaxed to_slug regex (allows `<letter>/`). `lib/config.js` surfaces the `federation` block. New `test/federation-daemon.test.js` 2-daemon loopback integration. All gated so a fed-disabled daemon is unchanged.
- **Solved Jinn-inbound networking:** discovered the Jinn container has NO tailscale (plain Docker bridge 172.17.0.2 behind Daedalus's Tailscale; outbound to tailnet works via Docker→host NAT, verified). Inbound solved with a **socat sidecar on Daedalus** (`docker run -d --restart unless-stopped --name belfry-fed-proxy -p 38078:49878 alpine/socat TCP-LISTEN:49878,fork,reuseaddr TCP:172.17.0.2:49878`) + a Daedalus Windows Firewall inbound allow for TCP 38078 scoped to 100.64.0.0/10. NO container rebuild (init-firewall.sh already accepts the Docker host net). Port 49878 was WinNAT-reserved on Daedalus → host-publish moved to 38078 (Belfry stays 49878 internally). Verified via a hairpin test before deploying.
- **Erebus deploy:** pushed feature/agent-mesh; cloned belfry to C:\Users\aesth\belfry; **provisioned secrets-manager + age key on Erebus** (Matt chose full self-serve over a locked-launcher embed — Erebus can now decrypt the whole vault) via scp of the tooling tarball + age key over an SSH_ASKPASS channel (no secrets in chat); installed age+sops via winget; wrote C:\Users\aesth\belfry-run.ps1 launcher (pulls secrets at runtime, host e). Belfry RUNS on Windows (no path crashes; /tmp→Windows temp; brain ENOENT is graceful).
- **Validated j↔e end-to-end over Tailscale:** j→e send_to forwards + arrives on Erebus (provenance intact); e→j authenticated /fed announce via the Daedalus forwarder → 200 {ok:true}; gossip discovery + bare-slug auto-routing both work. computer-use (the Erebus owner agent) registered the permanent NSSM `belfry` service running as `.\aesth` (NOT LocalSystem — else secrets.js can't find the age key).
- **Slug-listing bug fixed (5e23812):** Matt reported querying available slugs missed sessions (live: list_sessions returned 3 of 57). Root cause: chokidar 4's awaitWriteFinish suppresses initial 'add' events for static files, so the watcher's lastSeen cache only held post-startup changes. Fix: `watcher.seedCache()` reads the dir at startup (no onUpdate); `list_sessions`/`getSession` now union registry.knownSlugs() (reachable, junk-free) with the cache + a `reachable` flag. New test/watcher.test.js + brain-handlers cases.
- **Telegram outage diagnosed + fixed:** running belfry on Jinn AND Erebus made both poll the same bot; the floating-owner election thrashed and Erebus (sessionless) owned the bot ~46 min → Matt's replies dropped. Root design gap: only a2a send_to forwarding was built, NOT inbound-Telegram forwarding, so a non-session host must not own the bot. Stopped the Erebus service (Set-Service Manual) → Jinn reclaimed the bot, Telegram restored.
- **BELFRY_FED_ONLY shipped (da6cf08, pushed):** federation-only mode skips the poller/watcher/brain — a mesh peer that never touches the bot. Redeployed Erebus with it (launcher BELFRY_FED_ONLY=1, service re-enabled auto-start); Jinn holds the bot with zero flapping, j↔e federation works.
- **Filed GitHub #38** (priority owner hierarchy + inbound-Telegram forwarding) and **#39** (configurable gossip visibility: terminal full / Telegram none / +haiku-summary) — log-only, not built, per Matt.
- **Phase C webhook-bridge core shipped (0ad96fb, pushed):** `lib/bridge.js` (parseBridges from BELFRY_BRIDGES env or jsonc `bridges` block + postToWebhook); federation-daemon delivers a mesh message for a bridge slug to its webhook (A2A envelope + minted correlationId), bridgeReply(correlationId,text) routes the agent's async reply back over the mesh; registry POST /bridge/reply endpoint; test/bridge.test.js + a loopback round-trip in federation-daemon.test.js.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Host letters j / e / s (Jinn/Erebus/Severin) | First letter of the real fleet machine names (dispatch fleet), supersedes old j/e/n |
| socat sidecar on Daedalus, not a devcontainer rebuild | Inbound to the Jinn container without killing all sessions; init-firewall.sh already allows the Docker host net |
| Provision full secrets-manager + age key on Erebus | Matt's choice over a locked-launcher embed; accepts Erebus can decrypt the whole vault (fleet-trusted node) |
| BELFRY_FED_ONLY to stop Erebus polling Telegram | The floating-owner election is incomplete (no inbound-forwarding); a sessionless host owning the bot drops the human's replies |
| Build Phase C bridge core, defer NAS deployment | Core is reusable + testable now (de-risks the deploy); the container redeploy touches prod life-planner and needs Matt's explicit go |
| NSSM service runs as .\aesth, not LocalSystem | LocalSystem's USERPROFILE→systemprofile, so secrets.js can't find C:\Users\aesth\.age\key.txt |

## Key Learnings
- chokidar 4 `awaitWriteFinish` suppresses initial 'add' events for pre-existing static files — a watch cache built only from events is silently incomplete; seed from disk at startup.
- The floating Telegram-owner election only elects; without inbound-Telegram forwarding a non-session owner can't route the human's replies → inbound silently breaks. A peer host must run BELFRY_FED_ONLY until inbound-forwarding exists (filed #38).
- Docker Desktop on Windows NATs container→tailnet outbound through the host's Tailscale (Jinn reaches 100.x directly with no in-container tailscale).
- WinNAT reserves high ports (49878 was reserved) → "access permissions" bind error; move the host-published port (38078), keep the app port internal.
- a2a relays (registry send_to) are independent of the Telegram poller — they kept working throughout the outage.

## Files Modified
- `lib/federation-daemon.js` (new, Phase A) + bridge delivery/bridgeReply (Phase C)
- `lib/bridge.js` (new, Phase C)
- `bin/belfry.js`: federation wiring, BELFRY_FED_ONLY guards (poller/brain/watcher), bridges wiring
- `lib/registry.js`: setFederationRouter + relaxed to_slug regex; setBridgeReplyHandler + POST /bridge/reply
- `lib/poller.js`: TelegramOwner 409→standby election
- `lib/config.js`: surface `federation` + `bridges` blocks
- `lib/watcher.js`: seedCache() at startup (slug-listing fix)
- `lib/brain-handlers.js`: list_sessions/getSession registry-union + reachable flag
- `bin/belfry-brain-mcp.js`: list_sessions tool description
- `docs/federation.example.jsonc`, `CLAUDE.md`: fed env vars + BELFRY_FED_ONLY + BELFRY_BRIDGES
- new tests: federation-daemon, watcher, bridge; +brain-handlers cases
- `/workspace/shared/belfry-launch.sh` (outside repo): Jinn federation env (host j, peer e=100.127.39.115:49878)
- Erebus (C:\Users\aesth): belfry clone, belfry-run.ps1 launcher (BELFRY_FED_ONLY=1), secrets-manager + age key
- secrets-manager: new ns `belfry-fed` key `token` (shared mesh bearer)

## Follow-ups
- [ ] NAS bridge DEPLOYMENT (awaiting Matt's go — touches prod life-planner): small life-planner change (store sender from /api/inbox envelope; on response POST localhost:49876/bridge/reply with correlationId + registry token), fed-only belfry daemon on Severin (host s, tailnet 100.116.157.75), life-planner container redeploy, e2e test.
- [ ] computer-use to register the dispatch worker's belfry-mcp spoke (→ e/worker) for delivered:1.
- [ ] Phase D: tag v0.3.0, merge feature/agent-mesh → main, delete superseded branches.
- [ ] GitHub #38 (owner hierarchy + inbound-Telegram forwarding) + #39 (gossip visibility) — backlog.
- [ ] Optional: restart Erebus service to pick up the brain-PATH launcher fix (brain dormant on Erebus anyway).

## Key commits (branch feature/agent-mesh, all pushed)
- 337962f feat(federation): daemon wiring for cross-machine agent mesh (Phase A)
- 5e23812 fix(brain): list_sessions missed idle sessions — seed status cache + registry source
- da6cf08 feat(federation): BELFRY_FED_ONLY mode — mesh peer without Telegram polling
- 0ad96fb feat(federation): webhook-bridge core for headless agent targets (Phase C)
