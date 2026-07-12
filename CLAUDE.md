# belfry

> Also follow /workspace/CLAUDE.md for global workspace conventions.

Telegram-to-terminal MUX rigging for remote driving of multiple Claude Code projects. Outbound: watches `/tmp/claude-dashboard/<slug>.json` files (a shared local-machine convention — see `docs/CONVENTION.md`) and pings a Telegram bot when subscribed slugs change state. Inbound: replies on Telegram are fed into the matching active session via per-session MCP plugins emitting `notifications/claude/channel`, and the model can call the `reply` MCP tool (or the daemon's auto-reply) to send back to Telegram.

## Working in this repo

1. `npm test` runs the full suite under `node --test`. Keep it green; new modules need tests alongside them.
2. Pure ESM, Node ≥ 20. Only runtime dep is `chokidar`. **Do not add SDKs** — Telegram uses native `fetch` in `lib/telegram.js`, MCP server will use a hand-rolled JSON-RPC handler. The whole project is intentionally readable end-to-end in one sitting; new dependencies need a real reason.
3. No secrets on disk inside the repo. Bot token + chat ID arrive via env (`BELFRY_TOKEN`, `BELFRY_CHAT_ID`) — the launcher pulls from whatever secret store the user runs.
4. Single-user, single-platform (Telegram), single-host (loopback MCP). Don't generalize to "any chat platform" or "remote MCP" — those are explicit non-goals.

## What it is and isn't

It is:

1. A long-running Node daemon that bridges Claude Code state to Telegram and back.
2. Per-slug opt-in via `~/.claude/belfry.jsonc` — silent by default, you whitelist what you want pinged.
3. Telegram-only. Bot API via raw HTTP. No SDK, no multi-platform abstraction.
4. The fan-out complement to Anthropic's official `claude --channels plugin:telegram` (which handles single-session bidirectional). Belfry covers the multi-terminal case the official plugin doesn't.

It isn't:

1. A general-purpose webhook router — Telegram is the only target.
2. A retry / circuit-breaker framework — per-slug throttle covers the spam case; transient API failures are logged and dropped.
3. A daemon you run on a remote host — registry binds to loopback only; assume the same machine as Claude Code.
4. A multiplexer or keystroke-injection shim. Inbound replies enter a session through the per-session `belfry-mcp` plugin emitting `notifications/claude/channel` — same path `plugin:telegram` uses, just with a central daemon owning the bot and routing across sessions.

## Architecture

```
                  Telegram (one bot, one chat)
                            ↕
                  belfry-daemon
                  ↑           ↓
       outbound watcher   HTTP loopback registry
                            ↓
        ┌───────────────────┼───────────────────┐
        ↓                   ↓                   ↓
    session A           session B           session C
   [belfry-mcp]        [belfry-mcp]        [belfry-mcp]
```

Two processes:
1. **belfry-daemon** (`bin/belfry.js`) — long-running, owns the Telegram bot. Outbound watcher → composer → sendMessage. Inbound poller → Registry → fan out to registered plugins.
2. **belfry-mcp** (`bin/belfry-mcp.js`) — one per Claude Code session that wants to receive replies. stdio MCP server connected to its parent claude. On startup registers with the daemon over loopback HTTP. Long-polls for routed messages; emits `notifications/claude/channel` (the same mechanism `plugin:telegram` uses) to inject text into the session as user input.

## Source layout

```
bin/belfry.js              — daemon entry point + daemon loop
bin/belfry-mcp.js          — per-session MCP plugin (registers, recv-loop, inject, reply tool); kept as a fallback foothold + the source of the broker's per-connection logic
bin/belfry-broker.js       — shared MCP broker: ONE process serving every session's channel role (per-connection sessions over a unix socket), replacing N per-session belfry-mcp.js Node spokes. Relays connect via a handshake; reconnect-safe (stable session_id → daemon preserves the queue across a broker bounce)
bin/belfry-relay.c / .py   — thin per-session stdio↔broker relay (the foothold Claude spawns). C compiles to a ~1MB binary (live default via belfry-mcp.json); python (~8MB) is the fallback. Both: handshake, byte-transparent pipe, auto-reconnect on broker drop
bin/belfry-hook.js         — Claude Code hook that writes the /tmp/claude-dashboard/ convention
bin/belfry-install-hook.js — adds belfry-hook to .claude/settings.json with writer detection
bin/belfry-broadcast.js    — local CLI: fan one message out to every session (POST /broadcast)
lib/watcher.js             — chokidar watcher on /tmp/claude-dashboard/*.json
lib/composer.js            — 3-line mobile-friendly message builder
lib/telegram.js            — Bot API HTTP helper (sendMessage)
lib/throttle.js            — per-slug rate limiting + coalesce
lib/config.js              — load + validate ~/.claude/belfry.jsonc
lib/subscriptions-store.js — live, persisted watch overrides (#40): mutate config.subscriptions in place + ~/.claude/belfry-subscriptions.json
lib/watch-handler.js       — /watch control panel: tap-toggle keyboard + /watch /unwatch /watching commands
lib/reply-tracker.js       — outbound message_id → slug LRU
lib/router.js              — incoming Telegram update → (slug, text, messageId)
lib/poller.js              — Telegram getUpdates long-poll loop
lib/registry.js            — HTTP register/unregister/recv/send/broadcast + pending-reply tracking
lib/broadcast-tracker.js   — in-flight /all completion tracking (all-replied or timeout → summary)
lib/send-queue.js          — serial outbound pacer: rate-limits every Telegram write, honours 429 retry_after
lib/agent-relay-guard.js   — flood/loop guard for agent-to-agent (send_to) relays: per-source token bucket + echo dedup
lib/slug.js                — slug derivation per docs/CONVENTION.md
lib/voice.js               — inbound Telegram voice-note transcription (Whisper via Groq/OpenAI)
docs/CONVENTION.md         — shared local-machine convention spec
docs/install-mcp.md        — how to add belfry-mcp to a project
test/                      — node --test
```

## Bidirectional design

**Mechanism.** belfry-mcp emits MCP `notifications/claude/channel` to inject Telegram text into its parent claude session as user input. This is the same channel notification path the bundled `plugin:telegram` uses for one-session bidirectional — belfry generalizes it to N sessions sharing one bot, with the daemon owning the routing.

1. **Per-session plugin (`bin/belfry-mcp.js`).** Loaded via `.mcp.json` in projects that want bidirectional. On `initialize` it declares `claude/channel` capability; on `notifications/initialized` it POSTs `/register` to the daemon and starts long-polling `/recv?instance_id=…`. When the long-poll resolves with text, the plugin emits `notifications/claude/channel` and Claude Code injects it into the session.
2. **Central registry (`lib/registry.js`).** Loopback HTTP on `127.0.0.1:<port>` (default `49876`, env override `BELFRY_MCP_PORT`). Picked from the IANA dynamic range to avoid collision with other local-loopback MCP servers (e.g. fusion360-mcp, which hardcodes `9876`). In-memory state: `instance_id → { slug, queue, waiter }` and a `slug → Set<instance_id>` index. `deliver(slug, text)` fans out to every registered instance for that slug; absent registration → drop with a log line.
3. **Routing inbound Telegram → slug.**
   1. Primary: Telegram quote-reply. Every outbound belfry message records its `message_id → slug`; replying to one binds the message to that slug.
   2. Fallback: `/<slug-name> message body` for cold sends with no message to quote.
   3. Unrouteable messages (no quote, no recognized prefix) → log + ignore. Don't guess.
   4. **Routing-status reaction (#32).** The daemon reacts to the inbound message with one emoji the moment routing resolves, as a pre-reply ack: 👀 delivered to a live session, 🤷 slug known but no live session registered (the message went nowhere), 🤔 unmatched (no deterministic route). When the session then answers, `sendOutbound` swaps the originating message's 👀 → 🫡 ("replied") — driven by the registry's owes-reply marker, which is set only for delivered inbounds, so 🤷/🤔 messages never receive a ✅. Fire-and-forget — a failed reaction never blocks delivery. Reserved commands (`/status`, `/nick`, …) aren't reacted; they already produce text. Policy + env config in `lib/reactions.js`; the `setMessageReaction` call lives in `lib/telegram.js`; the inbound react is wired in `lib/poller.js`'s router dispatch, the ✅ swap in `bin/belfry.js`'s `sendOutbound`. A reaction carries no text, so it signals the routing *outcome*, not the destination slug (that rides on the `<slug>:` reply header).
      **Brain-route upgrade (#34).** 🤔 is the *deterministic* router's outcome — "I couldn't place this." But an unmatched message is then handed to the brain (`onUnmatched` → `agent-handler` → `lib/brain-handlers.js`), which may classify it and `deliver` to a real slug. When it does, the `deliver` handler upgrades the originating reaction to reflect the *full* pipeline: 👀 if a live session got it, 🤷 if the slug resolved but nothing was registered — so 🤔 only persists when the brain also declines. The upgrade rides an injected `reactRouting(messageId, outcome)` callback (wired in `bin/belfry.js`, mirroring the poller's `reactToRouting`; null when reactions are off), and the 👀→🫡 reply-swap then fires normally because `registry.deliver` set the owes-reply marker on the originating message.

**Inbound files (#41).** A Telegram photo or document routed to a session travels with it. The poller extracts `{ kind, fileId, name? }` (`extractAttachment`) and best-effort downloads it locally; photos deliver as `image_path` on the channel notification (rendered natively by the harness), documents as a `[attached file "…" saved to <path> — Read it from there]` line appended to the text at the `registry.deliver` chokepoint (no spoke/broker involvement). **Cross-host, the attachment ships as its Telegram `file_id`, not bytes**: the owner's local path is meaningless on another host, so the `inbound` envelope carries `attachment: { fileId, kind, name? }` and the receiving daemon re-downloads with its own bot token (file access, like sendMessage, is not owner-exclusive) into its own attachment dir. A failed download degrades to text-only delivery, never blocks; cred-less mesh nodes log and drop the attachment. The fileId is carried even when the owner-side download fails, so a fed forward still works. Size cap is `downloadFile`'s default 4MB (phone screenshots fit; pathological payloads don't), raisable via `BELFRY_ATTACHMENT_MAX_BYTES` up to Telegram's 20MB getFile ceiling.

**Session ↔ slug binding.** belfry-mcp derives its own slug at startup via `lib/slug.js` per the shared convention (`CLAUDE_SESSION_SLUG` → `CLAUDELIKE_BAR_NAME` → `~/.claude/claude-session-slugs.json` → `~/.claude/claudelike-bar-paths.json` → cwd basename) and reports it on register. The daemon never has to guess which session a slug refers to.

**Outbound from session.** Two paths the model can use:
1. Explicit `reply` MCP tool from `belfry-mcp` → POST `/send` on the registry → daemon calls `sendMessage` and quote-replies the originating Telegram message (or the slug's most recent outbound message if no inbound is pending). **Provenance rule (#33):** the `reply` tool pushes to the sender's phone and is valid *only* on a turn whose inbound was a belfry `<channel source="belfry">` message. Terminal-typed input carries no such tag — answering it via `reply` pushes terminal-origin output to Telegram as noise. The terminal is the canonical full transcript: whenever the model replies to Telegram it must also render the full text as terminal output, so the terminal never carries less than what went to the phone. This contract lives in the MCP server `instructions` + the `reply` tool description in `bin/belfry-mcp.js`.
2. Auto-reply: when a Telegram message routes in, the daemon marks the slug as "owes a reply." On the next status flip to `ready` for that slug with a fresh `last_response`, the daemon sends `last_response` quote-replied to the originating message and clears the marker. Auto-reply is independent of subscriptions and throttle — it serves the conversational thread, not the event-ping channel.

**Why this works for active and idle sessions.** The MCP transport is alive for the entire lifetime of the session — active, mid-tool-call, idle waiting for input, all the same. There is no "session is between turns, the inbox can't drain" case (the v1 Stop-hook problem) and no "session has no terminal, spawn a parallel one" case (the v1 spawn problem). The plugin is *in* the session; the channel notification is the same path the user's keyboard would go through.

**Broadcast (#30).** `/all <message>` (Telegram, slash required) and `belfry-broadcast "<message>"` (local CLI, `--only`/`--except` filters) fan one message out to *every* registered session via `registry.broadcast()`. What each session receives is **text it interprets, not a slash command** — channel injection wraps content in a `<channel>` tag so Claude Code's slash parser never runs it (`/all /compress` injects the literal text "/compress"). The queue item carries `broadcast:true`, surfaced as `broadcast="true"` on the channel tag so the model knows it's a fan-out and replies succinctly. A session opts out with `BELFRY_BROADCAST=false` (reported as `accepts_broadcast:false` at register; the registry skips it). The daemon's `onBroadcast` orchestrator (in `bin/belfry.js`, shared by the poller and the `/broadcast` route) anchors threading on a single message — the user's `/all` for Telegram, a placeholder confirmation for CLI — `markOwesReply`s every reached slug to it (so all replies thread under it and the 👀 swaps to 🫡), seeds `lib/broadcast-tracker.js`, and posts a `📡 broadcast to N session(s)` confirmation. The tracker collects each reply (tapped in `sendOutbound`) and fires a `📋 Broadcast complete (N/N)` roll-up when every session answers or `BELFRY_BROADCAST_TIMEOUT_MS` (default 2m) elapses. The `target_slugs`/`exclude_slugs` filter shape is forward-compatible with #29's per-host filtering.
   **Broadcast policy (2026-07-08): agents may not broadcast — except Wintermute.** The local `POST /broadcast` route is closed by default (`BELFRY_BROADCAST_LOCAL` reopens it for the human's CLI); an anchorless broadcast that reaches zero sessions never touches Telegram (a misaddressed headless script once produced 13 "no sessions registered" phone messages in 20 minutes). Mesh agents broadcast via `POST /fed/broadcast` (new `broadcast` envelope kind: `from`, `text`, optional `targetSlugs`/`excludeSlugs`), gated by the per-host `broadcastHosts` allowlist — fleet-wide set to `w`, so Wintermute is the only broadcasting agent. `/all` from the human is unaffected.

**Agent-to-agent messaging (#36, Tier 0).** Sessions can message each other, not just the human. The spoke exposes a `send_to(slug, text)` MCP tool → `POST /send-to { instance_id, to_slug, text }` → `registry.relayAgentMessage(fromSlug, toSlug, text)`. The sender's slug is resolved from its `instance_id` (never trusted from the body) so a session can't spoof another's identity. The relay reuses `_pushToInstance` but, unlike `deliver`, **does not** `markOwesReply` — a peer message owes Telegram nothing, so it never trips auto-reply or a routing-reaction swap. The queue item carries `origin: 'agent'` + `from: <slug>`, surfaced by the spoke as `origin="agent" from="…"` on the channel tag; the MCP `instructions` + `reply`/`send_to` tool descriptions instruct the model to answer a peer with `send_to(from)` and **never** the Telegram `reply` tool (which would push a peer message to the human's phone, violating the #33 provenance rule). Loop/flood protection is model-independent: `lib/agent-relay-guard.js` is a per-source token bucket (default burst 5, refill ~1/5s) plus an echo-dedup (identical from→to text dropped within 10s) — wired into the daemon's `Registry` as `relayGuard`; a tripped guard returns `429 { reason }` so the calling model backs off. This is the local-fleet agent mesh; an A2A facade / n8n bridge (Tier 2) stays out-of-process by design. Because the spoke protocol is model-agnostic (stdio JSON-RPC + HTTP register, nothing Claude-specific), a non-Claude CLI speaking the same spoke can register a slug and join the mesh — the multi-model path.

**Batch relay (#50): `send_many`.** One text to many peers in one call — `send_many(slugs[], text)` → `POST /send-many { instance_id, to_slugs[1..32], text }`. A same-text fan-out is ONE deliberate act, so the whole batch is charged ONE relay-guard token (`AgentRelayGuard.checkBatch`) instead of one per recipient — the per-recipient charge is what forced the 2026-07-11 crash-recovery orchestrator to hand-throttle 18 sessions. Per-recipient echo-dedup is preserved both directions (a batch records each (from→to, text) pair; prior singles mark batch entries `duplicate`). Each recipient routes exactly like a `/send-to` target — federation router first for `<letter>/<slug>`, then local — with a `skipGuard` option threaded through `relayRemote` so remote hops don't double-charge. The response is per-recipient truth: `{ to, ok, delivered, remote?, host?, reason? }` — an ambiguous or unreachable target fails its own entry, never the batch; no-live-session is `ok:true, delivered:0` as ever. Loop protection intact: reflection loops are single-recipient shapes, and a runaway batcher is still bounded by the refill rate and the 32-recipient cap. Tap: one `send_many` batch event plus the usual per-recipient events.

**Agent→human push: the `telegram` bridge address.** An agent that wants to reach the human's phone *deliberately* sends to the reserved bridge slug — `send_to("telegram")` same-host, `send_to("<letter>/telegram")` cross-host (slug configurable via `federation.telegramBridgeSlug`). The message posts to the chat via `sendOutbound`, headered with the sender's slug and reply-anchored, so a quote-reply routes back to that agent over the mesh. Cross-host this is #44's `telegramBridge` in `federation-daemon`'s `onMessage`; the same-host case is `registry.humanTarget` (wired via `setHumanTarget` only on a creds-bearing daemon), checked in `relayAgentMessage` after the flood guard — pushes to the phone deserve the guard most. This is the *sender-controlled* path: the agent decides what the human sees (e.g. Wintermute's proactive notifications). It does not weaken #33/#36 — `reply` remains the only way to answer a human's belfry-tagged turn, and ordinary peer messages still never touch Telegram.

**Mesh mirror (#39, scoped).** The *receiver-controlled* complement: per-agent opt-in to surface a2a traffic on Telegram via a `mesh` block in belfry.jsonc (`telegram` default mode + `telegramOverrides` per slug, `none`/`full`; see `docs/belfry.jsonc.example`). A relay whose source **or** destination matches a `full` entry is mirrored to Telegram via `sendOutbound` — headered with the source slug, `→ <dest>` on the first line — and the mirror's reply anchor points at the source, so quote-replying it messages that agent back. Bare keys match any host (`wintermute` catches `w/wintermute`); qualified keys pin one host. The hook is `registry.setAgentRelayObserver` firing inside `relayAgentMessage` — receiver-side only (federation-outgoing routes before it), so a fleet-wide deploy never double-mirrors; guard-blocked relays don't fire, `delivered:0` drops do (flagged "not delivered"). Default (`none` / no block) keeps the #36 invariant: mesh chatter stays off the phone. The `summary` mode from #39 is not implemented. Prefer the bridge address above for an agent that should choose its own signal; the mirror is surveillance of an agent that doesn't.

## Subscription config (`~/.claude/belfry.jsonc`)

See `docs/belfry.jsonc.example` for the canonical form. Phase 1+ will extend the schema with an inbound block (per-slug enable for replies, per-slug Telegram routing aliases). Keep additions backward-compatible — existing configs must continue to work as outbound-only.

`VALID_EVENTS` in `lib/config.js` is `{ready, error, waiting}` — a deliberately small subset of the statuses the convention can carry, to keep ping volume low. `waiting` corresponds to Claude Code's `Notification` event (permission prompts, idle waits) — produced by `bin/belfry-hook.js`. Other statuses the hook produces (`working`, `idle`, `offline`) are intentionally excluded from `VALID_EVENTS`: they fire on every tool call / session boundary and would drown the ping channel.

## Message format

Three-line composer optimized for mobile lock-screen previews. See `lib/composer.js`. No markdown tables, no nested lists, no ASCII art — the user should triage at a glance.

When inbound lands, outbound messages need a footer indicating the message is replyable (e.g. "↩ Reply to this message to continue this session"). Tight on character budget; keep additions surgical.

## The shared `/tmp/claude-dashboard/` convention

belfry reads and writes a small local-machine convention: `/tmp/claude-dashboard/<slug>.json` plus the slug-derivation rules. The full spec is in `docs/CONVENTION.md`. Neither belfry nor any other tool owns the convention — it is a filesystem shape that any local tool can choose to participate in. [claudelike-bar](https://github.com/harteWired/claudelike-bar) also reads and writes it, so a user can run either, both, or neither.

When belfry's hook (`bin/belfry-hook.js`) is installed in a project, it writes the JSON on every Stop / Notification / etc. event. `belfry-install-hook` adds the entry to `.claude/settings.json` and skips installation if it detects an existing writer of the convention (currently `claudelike-bar` and `belfry-hook`). Two writers writing the same shape on every event is wasted compute, so coordination happens once at install time, not at runtime.

Slug derivation order (see `lib/slug.js` and `docs/CONVENTION.md`): `CLAUDE_SESSION_SLUG` env → `CLAUDELIKE_BAR_NAME` env (legacy) → `~/.claude/claude-session-slugs.json` (**ancestor-walked**) → `~/.claude/claudelike-bar-paths.json` (legacy, ancestor-walked) → no match → STRICT skip / LEGACY `basename(cwd)`. The legacy paths exist for backward compatibility with users who installed claudelike-bar earlier; new writers should use the neutral paths. `lib/slug.js` exposes two entry points: `resolveSlug` (Status-File Contract v1 — ancestor-walk + STRICT, returns `{slug, matched, source}` with `slug:null` when STRICT declines) used by `belfry-hook` so unregistered subdirs mint no junk file, and the legacy `deriveSlug` (STRICT-off, always returns a string) used by `belfry-mcp`, which must always resolve a slug for the session it's attached to. STRICT (default-on) is the junk-slug fix (#40); `CLAUDELIKE_BAR_STRICT=0` restores the basename fallback. The status dir resolves `CLAUDELIKE_STATUS_DIR` → `CLAUDE_DASHBOARD_DIR` (deprecated alias) → POSIX literal `/tmp/claude-dashboard`, kept in lock-step between `bin/belfry-hook.js` and `lib/watcher.js`. The hook read-merge-writes the status file so it preserves foreign fields (e.g. `context_percent` from the claudelike-bar statusline).

`last_response` was historically a sticking point — claudelike-bar v0.17.0 didn't populate it, which left the composer's "Claude: …" line and the auto-reply path inert. With `belfry-hook` vendored, belfry can populate `last_response` itself by tailing the transcript, so the auto-reply path works without depending on a particular CLB version.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Default forum topic ID; per-slug `topic` in belfry.jsonc takes precedence |
| `BELFRY_MCP_PORT` | no | Override default MCP port (default `49876`, in the IANA dynamic range) |
| `BELFRY_RESUME_LAUNCHER` | no | Optional script for `/resume <slug> <uuid>` to exec as a detached subprocess. Without it, `/resume` emits a copyable command. |
| `BELFRY_STATE_DIR` | no | Override the state directory (default `$XDG_STATE_HOME/belfry` or `~/.local/state/belfry`). |
| `BELFRY_TRANSCRIBE_KEY` | no | API key for inbound voice-note transcription. Without it, voice notes are acknowledged once with a "voice support is off" reply and dropped. |
| `BELFRY_TRANSCRIBE_PROVIDER` | no | `groq` (default) or `openai`. Both speak Whisper's `audio/transcriptions` shape — provider is just an endpoint + default model swap. |
| `BELFRY_ATTACHMENT_MAX_BYTES` | no | Max inbound Telegram attachment (photo/document) size `downloadFile` will fetch. Accepts plain bytes or a unit suffix (`8mb`, `512k`, `1.5m`). Default `4MB` (any phone screenshot fits; larger files degrade to text-only). Clamped to Telegram's 20MB getFile ceiling — a higher value can't be honoured. Baked at daemon launch; a change needs a supervisor restart. |
| `BELFRY_REACT` | no | Routing-status emoji reactions (#32), on by default. Set to a falsy value (`0`/`off`/`false`/`no`) to disable the whole feature. |
| `BELFRY_REACT_DELIVERED` / `BELFRY_REACT_DROPPED` / `BELFRY_REACT_UNMATCHED` / `BELFRY_REACT_REPLIED` | no | Override the per-outcome emoji (defaults 👀 / 🤷 / 🤔 / 🫡). Set one to an empty string to disable just that outcome. `REPLIED` is the 🫡 that the inbound's 👀 swaps to once the session answers. Must be from Telegram's free reaction set (~70 emoji) — note that set has **no green check** (✅/✔️ both 400 with REACTION_INVALID), which is why the replied default is a salute, not a checkmark. |
| `BELFRY_BROADCAST` | no | Per-session broadcast opt-out (#30), read by `belfry-mcp`. Set to a falsy value (`0`/`off`/`false`/`no`) to make this session decline `/all` fan-outs (reported as `accepts_broadcast:false` at register). Default: accept. |
| `BELFRY_BROADCAST_TIMEOUT_MS` | no | How long the daemon waits for all sessions to reply to a `/all` before posting the roll-up with the non-responders listed. Default `120000` (2 min). |
| `BELFRY_BROADCAST_LOCAL` | no | Reopens the local `POST /broadcast` route (the `belfry-broadcast` CLI). **Default: closed** — broadcast is a restricted capability (2026-07-08 policy): any local process holding the loopback registry token could otherwise fan text into every session and generate Telegram traffic (a headless script did exactly that). The human's Telegram `/all` is unaffected (chat-ID gated). |
| `BELFRY_FED_BROADCAST_HOSTS` | no | Which mesh host letters may trigger a fan-out on THIS host via `POST /fed/broadcast` (comma/space-separated; or `federation.broadcastHosts` in the jsonc). Default empty — nobody. Fleet policy: `w` (Wintermute) only. Auth is two layers: the shared `BELFRY_FED_TOKEN` bearer (transport — only daemons hold it) plus this allowlist (policy). The receiving daemon runs its normal onBroadcast orchestrator with `source: fed:<host>/<slug>`, so confirmations say who broadcast. |
| `BELFRY_SEND_INTERVAL_MS` | no | Base minimum gap between outbound Telegram writes, enforced by `lib/send-queue.js` (#35). Default `1100` (safe for Telegram's ~1 msg/s per-chat limit). All sends — replies, pings, reactions, broadcast confirmations/roll-ups — funnel through one serial queue, so a `/all` fan-out no longer floods the chat into a 429. On a 429 the queue waits the server's `retry_after` and retries the same message (nothing dropped), and raises an adaptive floor to that interval (≈3s for groups/supergroups) for a cooldown window before relaxing back to the base. Raise this if you still see 429s; the queue auto-tunes regardless. |
| `BELFRY_HOST_LETTER` | no | Enables federation (#29): this daemon's single-`[a-z0-9]` host prefix for cross-machine `send_to` addressing (`<letter>/<slug>`). Unset → federation off and the daemon is single-host as before. Can also come from the `federation.hostLetter` field of belfry.jsonc. The fleet uses `j`/`e`/`s` (Jinn / Erebus / Severin). |
| `BELFRY_HOST_NAME` | no | Display name for this host in federation logs (default: the letter). Or `federation.hostName`. |
| `BELFRY_HOST_PRIORITY` | no | Ranked Telegram-owner priority (#38): a non-negative integer where **lower = higher priority** (`1` = primary). When set on ≥2 federated hosts, the highest-priority host that can actually *reach* Telegram owns the bot; lower-priority hosts run their poller but stand by, take over within ~30–90s if the owner stops reaching Telegram (process dead **or** egress dead — the gate keys on a gossiped `reachableAt`, not mere mesh-liveness), and hand back when the primary recovers. A peer's rank comes from this host's own config (4th field of `BELFRY_FED_PEERS` `letter,name,addr,priority`, or `federation.peers[].priority`). Unset on all hosts → the prior unranked 409 election. A ranked standby is a normal Telegram host (own `BELFRY_TOKEN`/`CHAT_ID`), **not** `BELFRY_FED_ONLY` — that flag stays for sessionless mesh nodes that must never contend for the bot. |
| `BELFRY_FED_TOKEN` | no | **Required to actually enable federation** — the shared bearer every daemon presents on `/fed/*`. Without it, a configured host letter is refused (the daemon will not start an unauthenticated mesh listener). Secret → env only, never the jsonc file. |
| `BELFRY_FED_PEERS` | no | Compact peer list overriding the jsonc `federation.peers`: `;`-separated, fields `,`-separated — `e,Erebus,http://erebus:49878;s,Severin,http://severin:49878` (name optional). `addr` is each peer's `/fed/*` URL. |
| `BELFRY_FED_PORT` | no | Local `/fed/*` listener port (default `49878` — a separate, token-gated server from the loopback registry on `49876`). |
| `BELFRY_FED_BIND` | no | Local `/fed/*` bind address. Default `127.0.0.1`; set to the Tailscale interface (or `0.0.0.0`) so peers can connect. The listener is fail-closed (mandatory token) regardless of bind. |
| `BELFRY_FED_ONLY` | no | Federation-only mode (#29): run the loopback registry + `/fed/*` mesh but **skip the Telegram poller, the outbound dashboard watcher, and the brain**. Set this on a peer host that has no Telegram role (e.g. a worker box) so it joins the a2a mesh without competing for the bot — Telegram allows one `getUpdates` owner per token, and a sessionless host winning the floating election would drop the human's replies. The Telegram host (the one that actually owns sessions + the bot) leaves this unset. **In this mode `BELFRY_TOKEN`/`BELFRY_CHAT_ID` are optional** — a fed-only node with no bot config boots as a pure multi-agent mesh node (registry + `/fed`, no Telegram). With no federation config either, it's just a local registry mesh (same-host `send_to` between sessions). |
| `BELFRY_BRIDGES` | no | Webhook bridge map (#29 Phase C): `slug=url;slug2=url2`. A bridge slug is a headless agent reached over HTTP (e.g. the NAS life-planner at `life-planner=http://localhost:3200/api/inbox`), not an interactive spoke. A mesh message for a bridge slug is POSTed to the webhook as an A2A envelope (with a `correlationId`); the agent replies asynchronously via `POST /bridge/reply { correlationId, text }` on its local daemon, which routes the reply back to the original sender over the mesh. Can also come from the belfry.jsonc `bridges` block (env wins). |
| `WINTERMUTE_TAP_URL` | no | Wintermute message-flow tap (#49): when set, belfry POSTs a METADATA-ONLY flow event (slugs/hosts/counts/char-lengths — never message text; the Privacy invariant extends to this egress) to this URL on every registry `deliver`/`broadcast`/`relayAgentMessage`, every outbound Telegram send, federation a2a relays, and one aggregated event per gossip round. Fire-and-forget with a 3s timeout — a down Wintermute costs the hot path nothing. Rolled to every node so cross-host sends that never touch `w` are still visible. |
| `WINTERMUTE_TAP_TOKEN` | no | Bearer token for the tap POSTs (the Conductor's `WINTERMUTE_TAP_TOKEN`). |

The conversational agent + summarizer run inside a long-running `claude --print --input-format=stream-json` subprocess (the "brain"; see `lib/brain.js`) that uses the user's Claude.ai subscription via OAuth — no `ANTHROPIC_API_KEY` needed. Without claude on PATH or without subscription credentials, the brain simply doesn't start; deterministic routes still work and language-layer routes return "language layer is down".

## Privacy

1. No prompt or response text is logged to stderr — only event metadata (slug, status, timestamps).
2. Bot token + chat ID are passed as env vars only — no on-disk config inside the project.
3. Inbound: only messages from `BELFRY_CHAT_ID` are accepted. Telegram replies from any other chat are dropped silently. Don't introduce a whitelist of additional chat IDs without a real reason — single-user is the design.
4. Voice notes only leave the host when `BELFRY_TRANSCRIBE_KEY` is set — the daemon downloads the audio to the attachment dir and POSTs it to the configured Whisper provider (Groq by default). Without the key, voice notes are dropped without any network call past Telegram. Treat the key as opt-in for an additional egress destination, not as a quality-of-life toggle.

## Setup

See `README.md` for the bot token + chat ID quick start. This file is for design constraints and conventions; setup steps live in the README so they show on the GitHub repo page.
