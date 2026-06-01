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
bin/belfry-mcp.js          — per-session MCP plugin (registers, recv-loop, inject, reply tool)
bin/belfry-hook.js         — Claude Code hook that writes the /tmp/claude-dashboard/ convention
bin/belfry-install-hook.js — adds belfry-hook to .claude/settings.json with writer detection
lib/watcher.js             — chokidar watcher on /tmp/claude-dashboard/*.json
lib/composer.js            — 3-line mobile-friendly message builder
lib/telegram.js            — Bot API HTTP helper (sendMessage)
lib/throttle.js            — per-slug rate limiting + coalesce
lib/config.js              — load + validate ~/.claude/belfry.jsonc
lib/reply-tracker.js       — outbound message_id → slug LRU
lib/router.js              — incoming Telegram update → (slug, text, messageId)
lib/poller.js              — Telegram getUpdates long-poll loop
lib/registry.js            — HTTP register/unregister/recv/send + pending-reply tracking
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
   4. **Routing-status reaction (#32).** The daemon reacts to the inbound message with one emoji the moment routing resolves, as a pre-reply ack: 👀 delivered to a live session, 🤷 slug known but no live session registered (the message went nowhere), 🤔 unmatched (no deterministic route). Fire-and-forget — a failed reaction never blocks delivery. Reserved commands (`/status`, `/nick`, …) aren't reacted; they already produce text. Policy + env config in `lib/reactions.js`; the `setMessageReaction` call lives in `lib/telegram.js`; wiring is in `lib/poller.js`'s router dispatch. A reaction carries no text, so it signals the routing *outcome*, not the destination slug (that rides on the `<slug>:` reply header).

**Session ↔ slug binding.** belfry-mcp derives its own slug at startup via `lib/slug.js` per the shared convention (`CLAUDE_SESSION_SLUG` → `CLAUDELIKE_BAR_NAME` → `~/.claude/claude-session-slugs.json` → `~/.claude/claudelike-bar-paths.json` → cwd basename) and reports it on register. The daemon never has to guess which session a slug refers to.

**Outbound from session.** Two paths the model can use:
1. Explicit `reply` MCP tool from `belfry-mcp` → POST `/send` on the registry → daemon calls `sendMessage` and quote-replies the originating Telegram message (or the slug's most recent outbound message if no inbound is pending). **Provenance rule (#33):** the `reply` tool pushes to the sender's phone and is valid *only* on a turn whose inbound was a belfry `<channel source="belfry">` message. Terminal-typed input carries no such tag — answering it via `reply` pushes terminal-origin output to Telegram as noise. The terminal is the canonical full transcript: whenever the model replies to Telegram it must also render the full text as terminal output, so the terminal never carries less than what went to the phone. This contract lives in the MCP server `instructions` + the `reply` tool description in `bin/belfry-mcp.js`.
2. Auto-reply: when a Telegram message routes in, the daemon marks the slug as "owes a reply." On the next status flip to `ready` for that slug with a fresh `last_response`, the daemon sends `last_response` quote-replied to the originating message and clears the marker. Auto-reply is independent of subscriptions and throttle — it serves the conversational thread, not the event-ping channel.

**Why this works for active and idle sessions.** The MCP transport is alive for the entire lifetime of the session — active, mid-tool-call, idle waiting for input, all the same. There is no "session is between turns, the inbox can't drain" case (the v1 Stop-hook problem) and no "session has no terminal, spawn a parallel one" case (the v1 spawn problem). The plugin is *in* the session; the channel notification is the same path the user's keyboard would go through.

## Subscription config (`~/.claude/belfry.jsonc`)

See `docs/belfry.jsonc.example` for the canonical form. Phase 1+ will extend the schema with an inbound block (per-slug enable for replies, per-slug Telegram routing aliases). Keep additions backward-compatible — existing configs must continue to work as outbound-only.

`VALID_EVENTS` in `lib/config.js` is `{ready, error, waiting}` — a deliberately small subset of the statuses the convention can carry, to keep ping volume low. `waiting` corresponds to Claude Code's `Notification` event (permission prompts, idle waits) — produced by `bin/belfry-hook.js`. Other statuses the hook produces (`working`, `idle`, `offline`) are intentionally excluded from `VALID_EVENTS`: they fire on every tool call / session boundary and would drown the ping channel.

## Message format

Three-line composer optimized for mobile lock-screen previews. See `lib/composer.js`. No markdown tables, no nested lists, no ASCII art — the user should triage at a glance.

When inbound lands, outbound messages need a footer indicating the message is replyable (e.g. "↩ Reply to this message to continue this session"). Tight on character budget; keep additions surgical.

## The shared `/tmp/claude-dashboard/` convention

belfry reads and writes a small local-machine convention: `/tmp/claude-dashboard/<slug>.json` plus the slug-derivation rules. The full spec is in `docs/CONVENTION.md`. Neither belfry nor any other tool owns the convention — it is a filesystem shape that any local tool can choose to participate in. [claudelike-bar](https://github.com/harteWired/claudelike-bar) also reads and writes it, so a user can run either, both, or neither.

When belfry's hook (`bin/belfry-hook.js`) is installed in a project, it writes the JSON on every Stop / Notification / etc. event. `belfry-install-hook` adds the entry to `.claude/settings.json` and skips installation if it detects an existing writer of the convention (currently `claudelike-bar` and `belfry-hook`). Two writers writing the same shape on every event is wasted compute, so coordination happens once at install time, not at runtime.

Slug derivation order (see `lib/slug.js` and `docs/CONVENTION.md`): `CLAUDE_SESSION_SLUG` env → `CLAUDELIKE_BAR_NAME` env (legacy) → `~/.claude/claude-session-slugs.json` → `~/.claude/claudelike-bar-paths.json` (legacy) → `basename(cwd)`. The legacy paths exist for backward compatibility with users who installed claudelike-bar earlier; new writers should use the neutral paths.

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
| `BELFRY_REACT` | no | Routing-status emoji reactions (#32), on by default. Set to a falsy value (`0`/`off`/`false`/`no`) to disable the whole feature. |
| `BELFRY_REACT_DELIVERED` / `BELFRY_REACT_DROPPED` / `BELFRY_REACT_UNMATCHED` | no | Override the per-outcome emoji (defaults 👀 / 🤷 / 🤔). Set one to an empty string to disable just that outcome. Must be from Telegram's free reaction set (~70 emoji). |

The conversational agent + summarizer run inside a long-running `claude --print --input-format=stream-json` subprocess (the "brain"; see `lib/brain.js`) that uses the user's Claude.ai subscription via OAuth — no `ANTHROPIC_API_KEY` needed. Without claude on PATH or without subscription credentials, the brain simply doesn't start; deterministic routes still work and language-layer routes return "language layer is down".

## Privacy

1. No prompt or response text is logged to stderr — only event metadata (slug, status, timestamps).
2. Bot token + chat ID are passed as env vars only — no on-disk config inside the project.
3. Inbound: only messages from `BELFRY_CHAT_ID` are accepted. Telegram replies from any other chat are dropped silently. Don't introduce a whitelist of additional chat IDs without a real reason — single-user is the design.
4. Voice notes only leave the host when `BELFRY_TRANSCRIBE_KEY` is set — the daemon downloads the audio to the attachment dir and POSTs it to the configured Whisper provider (Groq by default). Without the key, voice notes are dropped without any network call past Telegram. Treat the key as opt-in for an additional egress destination, not as a quality-of-life toggle.

## Setup

See `README.md` for the bot token + chat ID quick start. This file is for design constraints and conventions; setup steps live in the README so they show on the GitHub repo page.
