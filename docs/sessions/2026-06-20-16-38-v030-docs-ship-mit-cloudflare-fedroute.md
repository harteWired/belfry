---
date: 2026-06-20
project: belfry
type: session-log
---

# 2026-06-20 — v0.3.0 docs ship (README + Cloudflare hero), MIT license, federation-aware routing fix

## Quick Reference
**Keywords:** belfry, README v0.3.0 rewrite, fleet-forward hero page, web-design-pipeline collaboration, Fornax designated-lead diagram, 4-machine fleet, Jinn/Erebus/Severin/Fornax, MIT license, LICENSE file, Cloudflare lab.mattharte.com/belfry, github.io Pages takedown, wrangler deploy, federation-aware routing, resolveFederated, bare remote slug routing, /erebus-master, gossip ownership map, resolveAddress, router.js, poller.js, federation-daemon.js, #44, #31 launch-request contract, fed-proxy pin, jinnnet static IP 172.28.0.10, send_to peer coordination, captain orchestration, provenance rule, git-publishing standards, privacy scan
**Project:** belfry
**Outcome:** Shipped belfry v0.3.0's public face — rewrote the README fleet-forward, redesigned the hero page (4-machine fleet diagram via the web-design agent), open-sourced under MIT, and migrated hosting from GitHub Pages to Cloudflare (lab.mattharte.com/belfry). Then fixed a real routing bug Matt hit: a federated session's bare name (erebus-master) wouldn't route because the inbound router wasn't federation-aware. Orchestrated three peer agents (claudelike-bar, web-design-pipeline, computer-use, pc-tech-support) throughout.

## What Was Done
- **README v0.3.0 rewrite** (delegated to a git-publishing-skilled agent, reviewed for accuracy): reframed from "single-host Telegram relay" to "self-healing multi-machine fleet"; added all federation capabilities (#29 mesh, #38 failover, #36 send_to, #44 federated DM, #40 watch + status-file contract, #35 send-queue); marked #31 /spawn as roadmap-not-shipped; restructured to git-publishing §2 reader-priority order; Mermaid fleet diagram. Caught + fixed an internal contradiction (the agent wrote "open source" while License said UNLICENSED).
- **Hero page redesign** (handoff spec to the live web-design-pipeline agent; I own capability facts, it owns design): reframed fleet-forward, inheriting the parent lab page's blue (--color-sky). Three rounds: (1) initial 3-machine build; (2) corrected a CRITICAL owner/priority SWAP (draft had Erebus as p1-owner; reality is Jinn p1, Erebus p2, Severin p3) + a stale ANTHROPIC_API_KEY trust card (belfry uses Claude.ai OAuth, no API key); (3) Matt art-directed a richer 4-machine diagram — each host shows architectural purpose + example agents, with Fornax (Raspberry Pi, Pi-hole+Unbound / ADS-B SDR / scheduler) added as the "designated lead, coming online" (cold), framed by ROLE not hard p-numbers. Re-verified accuracy each round.
- **MIT license** (Matt's call): added LICENSE (MIT, © 2026 Matt Harte), flipped package.json UNLICENSED→MIT, rewrote README License section to a plain statement (Matt: don't editorialize the licensing rationale on the git page). Committed 303efef.
- **Cloudflare hosting migration**: web-design deployed the hero to lab.mattharte.com/belfry (CF Worker/Pages, docs/belfry/ + wrangler deploy) — verified 200; then promoted index.draft.html→index.html (repo source of record), repointed README live-page link to the CF URL, committed (eede298), and disabled github.io Pages LAST (verified 404, no gap). Synced a later one-liner copy edit ("massive expansion", d119cc1). Privacy-scanned both artifacts before each push.
- **Advised on MIT vs alternatives** (Matt asked "is MIT best?"): yes for a permissive hobby tool — explained the as-is/no-liability fit for the bot-token threat surface, and when you'd pick Apache 2.0 (patents/contributors) or GPL (copyleft) instead. No change.
- **Federation-aware routing fix (064728d)** — the session's real bug. Matt: replying to erebus-master by its bare name doesn't route. Diagnosed: the inbound router resolves a name 3 ways (local slug / nickname / qualified <letter>/<slug>) but NEVER consults the gossiped federation ownership map — so the bare real name "erebus-master" fell through to unmatched; only the nick "erebus" or qualified "e/erebus-master" worked. Fix: added a resolveFederated step (last, after local+nick) that resolves a bare slug via the gossip owner map; unique peer owner → routes as <letter>/<slug>. Broadened PREFIX_RE to also accept a directly-typed /<letter>/<slug>. Exposed federation.resolveAddress from wireFederation; wired it through the Poller. +7 router tests (70/70 green). Committed+pushed; NOT yet live (needs daemon restart — held).
- **Fed-proxy pin design** (with the pc-tech-support peer): peer fixed a 10-min watchdog console-flash on Daedalus (hidden-VBS shim). Design Q: better shape than polling-watchdog that re-points a socat forwarder at Jinn's drifting Docker IP? My call (I own belfry federation): pin Jinn to a static Docker IP (jinnnet/172.28.0.10) — the watchdog only polls because Jinn's on the dynamic default bridge; pin it and the forwarder target never moves. Peer found the pin was already committed (bfb3a9f) but had a latent brick (no jinnnet network → rebuild fails) and fixed it self-provisioning. Gave 3 federation confirms all green (firewall on 38078 proven by working live mesh; zero mesh churn since Jinn targets Erebus directly; 172.28/24 disjoint from tailnet). Flagged: the pin rebuild ALSO deploys the routing fix (064728d) for free.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| README via git-publishing-skilled agent; hero via web-design agent; I orchestrate + own facts | git-publishing owns README standards, web-design owns visual design (Matt's directive). I supply belfry capability content to both + review for accuracy. Clean division of labor. |
| Hero inherits the parent lab page's blue (--color-sky) | Matt's directive; the hero should visually rhyme with the lab tile a visitor clicked. Dropped belfry's standalone ember/sage accents. |
| Print "~30–90s" failover, NOT "under a minute" | The live kill test measured ~90s; "under a minute" would be a false claim on a public page. Accuracy over punch (subhead later softened to "in about one minute" per Matt, precise range kept in the caption). |
| Frame the fleet diagram by ROLE, not hard p1–p4 numbers | Fornax-as-p1 cutover is pending (Pi not flashed); printing fixed ranks would be wrong. "Current owner / standby / designated lead coming online" is honest now and showcases the reachability gate (highest-priority REACHABLE host owns the bot → Jinn holds it while Fornax is cold). |
| Cloudflare deploy FIRST, github.io takedown LAST | No broken-link window. Verified CF 200 before disabling Pages. |
| Plain README License section (no rationale) | Matt: explaining "our logic for MIT" at the bottom of the git page is weird. A license section states the license, not argues for it. |
| resolveFederated as a NEW router step (last), local-wins | Local slug must win over a same-named remote (hasSlug checked first); the gossip resolve only fires when nothing local/nick matches. Ambiguous (2+ hosts own it) → unmatched so the user qualifies, never a silent guess. No-op when federation off. |
| Pin Jinn's Docker IP (not tailscale-in-container, not event-driven hook) | The watchdog only polls because of dynamic-bridge IP drift. Pinning kills the need to re-point entirely (pin > react-faster). Tailscale-in-container is more rebuild-fragile (no persistent identity) and removes no real SPOF (Daedalus is Jinn's host anyway). |
| Held the routing-fix daemon restart | Matt was mid-conversation on Telegram; a restart drops the reply path ~30–90s. Better: let it ride the pending pin rebuild (one blip deploys both). |

## Key Learnings
- **The inbound router was never federation-aware.** registry.deliver (human→session) is local-only; only send_to (#36) and explicit <letter>/<slug> (#44) crossed hosts. So a bare remote slug had no resolution path — the nickname was load-bearing, not convenience. The gossip owner map belfry already maintains just wasn't wired into the deterministic router.
- **Inbound forwarding (#38 Phase 2) is still unbuilt, and it shapes priority strategy.** Because the bot owner can only deliver to its OWN local sessions (+ qualified targets), Jinn MUST be p1 while most sessions live on Jinn — a more-reliable owner that can't reach your sessions is useless. This flips once Phase 2 forwarding exists: then the most-reliable always-on box (Fornax) should lead. So "build Phase 2, then promote Fornax to p1" is one cutover, not two.
- **A devcontainer REBUILD restarts the belfry daemon** (not just a session) → Telegram fails over to Erebus for the window. That's #38 working as designed, but it means any rebuild is a brief full-Jinn federation blip — and conveniently deploys whatever's committed to the working tree.
- **git merge -X theirs is NOT "make tree == theirs"** (re-confirmed from the v0.3.0 merge earlier this arc): non-conflicting additions from "ours" survive. Always diff after.
- **Jinn has no tailnet identity in-container** (no tailscaled running now); the publish-preview tailscaled is ephemeral. So federation reachability genuinely depends on the Daedalus forwarder; a static Docker IP is the robust declarative fix.

## Solutions & Fixes
- **Bare remote slug doesn't route** (Matt's bug): router wasn't federation-aware → added resolveFederated (gossip-map resolve) + broadened PREFIX_RE for direct qualified form. All 3 forms (bare / qualified / nick) now route identically. 064728d, +7 tests.
- **Hero owner/priority swap** (round 2): draft showed Erebus as p1-owner; corrected to Jinn p1 / Erebus p2 / Severin p3 everywhere (SVG, labels, caption, aria, arch row).
- **Stale trust card**: hero claimed ANTHROPIC_API_KEY summarizer egress; replaced with the correct Claude.ai-OAuth (no API key) "brain is opt-in egress" card.
- **README internal contradiction**: "open source" vs License "UNLICENSED" — fixed (then mooted by the MIT switch).
- **Latent devcontainer brick** (peer-found, peer-fixed): pin committed without a jinnnet network → rebuild would fail; self-provisioning ensure-jinnnet via initializeCommand added.

## Files Modified
- `README.md`: full v0.3.0 rewrite (fleet-forward, all federation capabilities, Mermaid 4-host diagram synced to hero, MIT License section, CF live-page link).
- `index.html`: replaced with the fleet-forward hero (promoted from index.draft.html); later one-liner copy sync.
- `LICENSE`: NEW — MIT, © 2026 Matt Harte.
- `package.json`: license UNLICENSED→MIT.
- `lib/router.js`: resolveFederated step + broadened PREFIX_RE + signature/docstring.
- `lib/poller.js`: thread resolveFederated through to route().
- `lib/federation-daemon.js`: expose resolveAddress (gossip-map resolve) from wireFederation.
- `bin/belfry.js`: wire resolveFederated into the Poller (federation.resolveAddress).
- `test/router.test.js`: +7 federation-routing tests (70 total).
- Git: 303efef (MIT), eede298 (README+hero v0.3.0/CF), d119cc1 (hero copy sync), af370f5 (trim License rationale), 064728d (federation-aware routing). All pushed to main.
- Cloudflare: hero live at lab.mattharte.com/belfry (web-design-pipeline repo docs/belfry/). github.io Pages disabled.

## Follow-ups
- [ ] **Deploy the routing fix (064728d)** — needs a daemon restart; best ridden on the pending fed-proxy pin rebuild (one blip = both). Then verify live: type /erebus-master from Telegram + a send_to round-trip.
- [ ] **Fed-proxy pin cutover** (gated on Matt, peer hands him steps): ensure-jinnnet on Daedalus → rebuild devcontainer → Jinn at 172.28.0.10 → watchdog repoints → I verify e↔j relay GREEN → THEN relax watchdog PT10M→PT1H. Don't relax cadence before the live verify.
- [ ] **#31 /spawn**: Launch-Request Contract v1 is design-locked (claudelike-bar drafted, both approved) but NOT built. Build when Matt greenlights: belfry /spawn writer + belfry-spawn CLI; CLB opt-in watcher.
- [ ] **#38 Phase 2 (cross-host inbound forwarding)** + the **Fornax→p1 cutover** — pair them (forwarding makes bot-location irrelevant, then promote the always-on Pi to lead). computer-use keeps machines.json/erebus-master in sync when Fornax is flashed.
- [ ] **#42 fast heartbeat / #43 cold-start contention** — open federation backlog.
