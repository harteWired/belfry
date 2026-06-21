# Runbook: Move the Telegram bot owner to another host

**Status:** validated live 2026-06-21 (bot owner moved Jinn → Fornax) · applies to belfry ≥ the reply-tracker-sync (`18e271b`)

One Telegram bot, one `getUpdates` poller, many hosts. Federation (#38) lets the
poller live on *any* host while sessions live on *all* of them. This runbook is
how you move the owner — say, from a dev box that sleeps to an always-on Pi —
without dropping a single inbound reply.

It reads as a procedure with the 2026-06-21 Jinn → Fornax flip as the worked
example. Do the steps in order. The dangerous shortcut — "just change the
priority number" — is exactly the one that breaks quote-replies, so start here.

## Why this is not a one-line change

Telegram allows exactly one `getUpdates` owner per bot token. The priority gate
(`BELFRY_HOST_PRIORITY`, lower = higher) decides who that is: the lowest-numbered
host that can actually reach Telegram owns the bot; everyone else stands by and
takes over on failure. So moving ownership *looks* like editing one number.

It isn't, because of where a reply gets routed. When the human quote-replies a
message, the update lands on **whoever owns the bot** — and that host resolves
the reply against its **local** `msgId → slug` reply-tracker. Each host only
records anchors for messages *it* sent. So the moment the owner is a host that
didn't send the ping (a different box, or a sessionless node), the lookup misses
and the reply dies as 🤔 — even though the target session is alive on a peer.

Two pieces close that gap, and **both must be deployed on every host before you
flip**:

1. **Cross-host inbound forwarding (#38 Phase 2).** The owner resolves the target
   slug to the host that owns it (via gossip), forwards the human message over
   `/fed/inbound`, and that host delivers it with human provenance + direct-sends
   the reply back. This is the *delivery* half.
2. **Reply-tracker-sync (the `replymap` envelope).** Every host gossips its
   `msgId → slug` anchors to peers, which store them host-qualified
   (`<host>/<slug>`). Now the owner's lookup resolves a quote-reply to a peer's
   session and the qualified address flows straight into the forward path above.
   This is the *resolution* half.

If you flip with only Phase 2, cold sends (`/api hi`) work but quote-replies —
the common case — still break. If you flip with neither, every reply to a
non-owner session breaks. **Deploy first, flip second.**

## The fleet and where each host's config lives

Belfry is launched differently on each OS, and the priority/peers config lives in
a different place on each. Know all three before you touch anything — editing the
wrong one is a silent no-op.

| Host | OS | Launch | Priority/peers config |
|---|---|---|---|
| Jinn | Linux (devcontainer) | supervised loop in `belfry-launch.sh` (detached, PID in `.belfry/belfry.pid`) | `/workspace/shared/belfry-launch.sh` (`BELFRY_HOST_PRIORITY`, `BELFRY_FED_PEERS`) |
| Erebus | Windows | NSSM service `belfry` → `powershell -File belfry-run.ps1` | `belfry-run.ps1` (`$env:BELFRY_HOST_PRIORITY`, `$env:BELFRY_FED_PEERS`) |
| Fornax | Linux (Raspberry Pi) | systemd `belfry.service` | `EnvironmentFile=/etc/belfry/belfry.env` |

`BELFRY_FED_PEERS` is `;`-separated, each peer `letter,name,addr,priority`. The
**4th field is that peer's priority as seen from this host** — and every host
needs a consistent view, or the gate disagrees about who outranks whom. When you
change priorities, you edit *both* the host's own `BELFRY_HOST_PRIORITY` *and*
the matching priority field in every other host's peer list.

> Gotcha: on Erebus the env is set inside `belfry-run.ps1`, **not** in NSSM's
> `AppEnvironmentExtra` (which reads empty). Find the launch wrapper before you
> assume the service env is where you edit.

## Procedure

### 1. Deploy the code to every host

Pull the branch with both prerequisites onto each host and restart its daemon.
Same idea, different restart verb per OS:

- **systemd (Fornax):** `git pull --ff-only` then `sudo systemctl restart belfry.service`
- **NSSM (Erebus):** `git pull --ff-only` then `nssm restart belfry`
- **supervisor (Jinn):** see §3 — a code-only change can restart the child, but
  an env change needs a supervisor restart.

Confirm each comes back on the right commit and rejoins the mesh (the daemon logs
`federation: host "<name>" (<letter>) up … N peer(s)`).

### 2. Prove the sync data plane BEFORE flipping

This is the step that earns its keep. While the *current* owner still hosts its
own sessions, the sync is a functional no-op — so the only pre-flip signal that
it works is anchors appearing on the *future* owner. Check it, because a silent
gap here is a guaranteed outage after the flip.

The future owner's reply-tracker (`$STATE/reply-tracker.json`) should accumulate
host-qualified entries (`<host>/<slug>`) as peers ping and reply. If it stays
empty while peers are clearly sending pings, the sync isn't firing — stop and fix
it before you flip.

> This check is exactly what caught the real bug in this migration: the sync was
> wired into the reply path but **not** the status-ping path (`ready`/`waiting`)
> — the messages people most often quote-reply. The fix centralized every anchor
> record through one `recordReplyAnchor()` chokepoint so no send path can skip
> the gossip. Don't trust unit tests alone here; watch the file on real hardware.

A zero-noise way to prove the live path end to end: POST a synthetic `replymap`
envelope from the current host to the future owner's `/fed/replymap` (using the
shared fed token, read from the running daemon's env — never printed), then
confirm the owner persisted it qualified. A `200 {"recorded":true}` plus the file
entry means network + token + route + handler + persistence all work.

### 3. Edit priorities and restart, in order

Edit all three configs to the target priorities (lower = higher; `1` = primary).
Then restart **future-owner first, current-owner second, the rest last** — this
order hands the bot over cleanly:

1. **Restart the future owner.** It comes up as `1`, polls, gets a 409 because the
   old owner still holds the lock, and stands by *retrying* (it believes it's
   top-priority, so it never gives up — it just waits out the lock).
2. **Restart the old owner.** On restart it releases the bot, sees the new p1 is
   reachable via gossip, and stands down via the priority gate. The future
   owner's next poll succeeds → **it acquires the bot.**
3. **Restart the remaining standbys** to align their config. They're not the
   owner, so this doesn't disturb anything.

> Gotcha — supervisor vs child restart (Jinn). The supervised launcher bakes the
> env in at *launch* time, so killing just the node child respawns it with the
> **old** priority. For an env change you must restart the **supervisor**: kill
> the supervisor PID (its TERM trap cascades cleanly to the child), then re-run
> `belfry-launch.sh`. The launcher is idempotent and exits 0 if a live supervisor
> exists, so the kill must come first. (A code-only deploy can child-restart.)

### 4. Confirm ownership is stable

Ownership transitions log only on change (`acquired the bot — now owner` /
`another daemon owns the bot — standing by`). The new owner should show
`acquired` with **no later `standing by`** for a few minutes. Both the owner
*and* a standby showing `standing by` with no acquirer is a mutual-standby gap —
i.e. a live outage — investigate immediately.

> Gotcha — cold-start contention (#43). During a multi-host restart cascade, a
> freshly-restarted lower-priority host starts with an empty gossip view, polls
> before it learns the higher-priority hosts are reachable, and *transiently
> steals* the bot — causing ownership to flap for a minute or two. It self-heals
> to the correct order as gossip populates, but don't mistake the flapping for a
> failure, and don't run the live verify mid-flap. Wait for a stable `acquired`.
> (Fast heartbeat #42 / startup-contention #43 are the proper fixes.)

### 5. Live-verify with a human at the phone

Two tests, in order — the second is the one that matters:

1. **Forward path.** Send `/<slug> <text>` to a session on a non-owner host. It
   should land in that session and the reply should thread back to the chat.
2. **Reply-tracker-sync.** *Quote-reply* that reply. The owner has to resolve the
   quoted message to a peer's session via a synced anchor and forward it back. If
   this threads through, the migration is complete. If it 🤔s, the sync didn't
   reach the owner — roll back and debug.

## Rollback

The flip is just config + restarts, so rollback is the same in reverse: restore
the previous priorities on all three hosts and restart. The old owner reclaims
the bot within one failover window (~90s under the default gossip cadence). Keep
a backup of each env file before editing (`cp … .pre-flip-bak`) so the revert is
a copy, not a re-edit. Nothing about the data plane needs reverting — the
prerequisites are inert until a remote host owns the bot.

## Worked example — Jinn → Fornax, 2026-06-21

Goal: move the bot owner off Jinn (a devcontainer that sleeps) onto Fornax (an
always-on Pi). Target order: **Fornax 1, Jinn 2, Erebus 3.**

1. Built the reply-tracker-sync (`replymap` envelope + `recordReplyAnchor`
   chokepoint), `npm test` green, pushed.
2. Deployed `18e271b` to all three hosts; each rejoined the mesh.
3. Pre-flip data-plane check found Fornax holding **zero** synced anchors despite
   Jinn pinging → traced to the status-ping path skipping the sync → fixed and
   redeployed. Re-checked: a synthetic `replymap` POST returned
   `200 {"recorded":true}` and Fornax persisted `j/belfry`. Real anchors
   (`j/computer-use`, `j/belfry`) then accumulated from live traffic.
4. Edited priorities on all three (Fornax `9→1`, Jinn `1→2`, Erebus `2→3`, plus
   every peer-priority field), restarted Fornax → Jinn → Erebus.
5. ~2 minutes of cold-start flapping (#43), then Fornax acquired the bot and held
   it. Jinn and Erebus settled into standby.
6. Live verify: `/belfry` forwarded Fornax → Jinn and the reply threaded back;
   the quote-reply resolved on Fornax via the synced `j/belfry` anchor and
   forwarded back. Both green.

Total moving parts that bit us: the status-ping sync gap (caught pre-flip), the
supervisor-vs-child restart, Erebus's env hiding in `belfry-run.ps1`, and the
cold-start flapping. None were the priority numbers themselves.
