---
date: 2026-06-21
project: belfry
type: session-log
---

# 2026-06-21 — Rebuild recovery → Tailscale, MCP broker + thin relays, reconnect, outgoing files

## Quick Reference
**Keywords:** belfry, devcontainer rebuild, tailscale recovery, jinn-helper, reverse-ssh tunnel, federation inbound, Fornax owner, Erebus, belfry-mcp self-ping, attenuated replies, MCP broker, belfry-broker.js, belfry-relay.c, belfry-relay.py, thin relay, C relay 1MB, auto-reconnect, queue preservation, SPOF, outbound files, sendDocument, sendPhoto, reply files param, claudelike-bar, daemon-restart pgrep trap, commit push, GitHub
**Project:** belfry
**Outcome:** Recovered belfry after a Jinn devcontainer rebuild wiped its Tailscale (federation inbound was dead), then shipped three features: a durable reverse-SSH tunnel via the always-on jinn-helper (federation no longer depends on the container's flaky userspace tailscale), an MCP broker that collapses ~30 per-session ~75MB Node spokes into 1 broker + ~1MB C relays (~2.25GB→~105MB) with auto-reconnect that preserves the message queue across a broker bounce, and outbound files (reply tool can send photos/documents). All committed + pushed.

## What Was Done
- **Diagnosed the inbound outage:** a Jinn devcontainer rebuild wiped `/home/node` → the container's Tailscale binary + node state gone, nothing restarted it. Container egresses to the tailnet via the Docker host NAT (so Jinn→Fornax a2a still worked) but is no longer a reachable tailnet *node*, so Fornax→Jinn was dead — killing reachability gossip (Jinn flapped into stealing bot ownership) AND the /fed/inbound forward (replies never reached the terminal).
- **Restored Tailscale:** reinstalled the binary (v1.98.4), rejoined; the wiped state meant a new node, so reclaimed the `jinn` name (Matt deleted the stale node in the admin console). New tailnet IP assigned (redacted).
- **Found the real federation ingress:** Fornax/Erebus reached "Jinn" via an ad-hoc Daedalus forwarder on :38078 (stale post-rebuild), NOT the container's tailscale. The container's userspace tailscale inbound is unreliable for everyone but Fornax.
- **Built a durable replacement — reverse-SSH tunnel** (`/workspace/shared/belfry-jinn-tunnel.sh`): container dials OUT to the always-on jinn-helper (kernel-tailscale WSL box, stable tailnet IP (redacted)), publishing belfry's /fed port at jinn-helper:49879 via `ssh -R` (needs GatewayPorts clientspecified on jinn-helper's sshd). Repointed Fornax + Erebus peers there; both verified reachable (HTTP 405). Self-healing keepalive; auto-starts via belfry-launch.sh.
- **Fixed "attenuated replies":** the `belfry` slug was subscribed to its own status pings → it self-pinged every turn with (composer-truncated) terminal output; copying two consecutive truncated pings looked garbled. Unsubscribed `belfry` (override file + jsonc). My actual reply-tool messages were always clean.
- **Shipped the MCP broker:** `bin/belfry-broker.js` (one process, per-connection sessions over a unix socket, faithful refactor of belfry-mcp.js's channel-role logic) + `bin/belfry-relay.py` (~8MB) / `bin/belfry-relay.c` (~1MB compiled). Channels are stdio-only so each session needs *a* stdio server — but it can be a transparent relay to one broker. Supervised (`belfry-broker-launch.sh`); shared belfry-mcp.json flipped to the C relay; launcher recompiles the C binary if missing.
- **Auto-reconnect (closes the broker-SPOF):** relay holds a stable session_id, reconnects + re-handshakes (reconnect=true) on a broker drop; the daemon's re-register path preserves the queue. Hammer-tested: killed broker mid-session, delivered a message while DOWN, restarted → the queued message landed after reconnect. Zero loss.
- **Outbound files:** `lib/telegram.js` sendDocument (multipart, no SDK; sendPhoto for images, sendDocument otherwise), `files` param on the reply tool threaded through /send → sendOutbound (text optional; ≤50MB, ≤10 files; best-effort per file). Validated live end-to-end (photo + document landed in Telegram).
- **Verified claudelike-bar** opens terminals via the shared belfry-mcp.json → auto-adopts the C relay/broker; no change needed.
- **Committed + pushed:** belfry dabcfc4 (broker/relays) + 53b8252 (files); ClaudeContainer 9866d57 (tunnel/launcher/config).

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Reverse-SSH tunnel via jinn-helper instead of fixing the Daedalus forwarder | jinn-helper is always-on with kernel tailscale + a stable IP; the container's userspace tailscale inbound is unreliable and IP-churns every rebuild. Self-owned, every piece controllable. |
| MCP broker + thin relays, not one shared HTTP server | Channel injection is stdio-only (verified), so a shared HTTP server can't push into a specific session. The broker is the "one mcp" shape adapted to that constraint: 1 brain + N featherweight stdio footholds. |
| C relay (~1MB) as the live foothold, python (~8MB) as fallback | 30 sessions → ~105MB (C) vs ~315MB (python) vs ~2.25GB (Node). belfry-mcp.json can point at either; launcher compiles C from source if missing. |
| Accept the broker SPOF, mitigate with supervision + relay reconnect | A broker crash drops relay sessions, but supervision restarts it fast and the stable-session_id reconnect preserves the daemon queue → zero loss, no session restart. |
| Outbound files send as separate threaded messages (text then each file) | Reuses the robust packed-text path; avoids Telegram's 1024-char caption complexity. Best-effort per file so one bad path doesn't abort the reply. |
| Unsubscribe `belfry` from its own status pings | You don't need ready-pings for the terminal you're actively driving from Telegram; that self-ping stream was the "garbled/attenuated" noise. |

## Key Learnings
- **The container's userspace Tailscale inbound is unreliable** — only Fornax could negotiate a path to it; jinn-helper (same host) and Erebus could not. The durable fix routes inbound through jinn-helper's *kernel* tailscale, not the container's.
- **The daemon's /register preserves the queue on a same-instance_id re-register** (built for spoke-crash recovery) — that's what makes the relay reconnect lossless across a broker bounce.
- **`pgrep -f 'belfry.js'` / `pkill -f` matches the SUPERVISOR and even the invoking shell** — hit this 3× today (killed the supervisor → full outage; pkill killed the test shell → exit 144). The safe selector is `pgrep -xf 'node /workspace/projects/belfry/bin/belfry.js'` (exact full-cmdline match).
- **A 1×1 PNG fails Telegram sendPhoto (IMAGE_PROCESS_FAILED)** — real images work; test with a real/generated image.
- **Inline multi-`$()` in a shell echo/env-assignment kept returning empty** (secrets, IPs) — run each fetch standalone or read from /proc/<pid>/environ.

## Solutions & Fixes
- Federation inbound dead → reverse-SSH tunnel via jinn-helper (peers → <jinn-helper-tailnet-IP>:49879 → container:49878). Verified 405 from Fornax + Erebus.
- Bot-ownership flapping (Jinn stealing the bot) → root cause was the dead Fornax→Jinn gossip path; fixed by the tunnel.
- "Attenuated" replies → `belfry` unsubscribed from self-pings (reply-tool messages were never the problem).
- Broker = SPOF → supervised + relay auto-reconnect with queue preservation.
- Accidentally killed the daemon supervisor (~60s outage) → recovered via belfry-launch.sh; hardened the memory with the exact-PID selector.

## Files Modified
- `bin/belfry-broker.js`: NEW — shared MCP broker (per-connection sessions, reconnect via stable session_id + ownership guard).
- `bin/belfry-relay.c` / `bin/belfry-relay.py`: NEW — thin stdio↔broker relays (C ~1MB live default, python ~8MB fallback); handshake, byte-transparent pipe, auto-reconnect.
- `lib/telegram.js`: NEW sendDocument (multipart photo/document) + tests.
- `bin/belfry.js`: sendOutbound takes `files`; sendDocument queue wrapper; remote return-leg threads files.
- `lib/registry.js`: /send accepts text and/or files.
- `bin/belfry-mcp.js`: reply tool `files` param (fallback foothold).
- `test/telegram.test.js`, `test/registry.test.js`: sendDocument + /send-files tests (registry 42 / telegram 8 green).
- `CLAUDE.md`: source-layout updated for broker + relays.
- `/workspace/shared/`: belfry-jinn-tunnel.sh (new), belfry-broker-launch.sh (new), belfry-launch.sh (tunnel + broker + C-compile wiring), belfry-mcp.json (flipped to C relay).
- `~/.claude/belfry.jsonc` + belfry-subscriptions.json: `belfry` unsubscribed from pings.
- Fleet (on-box, via remote-ops): Fornax /etc/belfry/belfry.env + Erebus belfry-run.ps1 `j` peer → <jinn-helper-tailnet-IP>:49879; jinn-helper sshd GatewayPorts.
- Commits: belfry dabcfc4, 53b8252; ClaudeContainer 9866d57 — all pushed.

## Follow-ups
- [ ] Broker unit tests (only integration-tested so far).
- [ ] #43 cold-start contention / #42 fast heartbeat (pre-existing federation follow-ups; the rebuild flapping is more evidence).
- [ ] Tunnel reconnect/buffering polish; the broker's per-connection buffer has no max line size (trusted-local).
- [ ] publish-preview's jinn.ts.net still needs a manual container-tailscale restore after a rebuild (federation no longer does).
