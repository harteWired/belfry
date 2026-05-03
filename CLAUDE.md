# belfry

> Also follow /workspace/CLAUDE.md for global workspace conventions.

Telegram-to-terminal MUX rigging for remote driving of multiple Claude Code projects. Outbound: watches [claudelike-bar](https://github.com/harteWired/claudelike-bar)'s `/tmp/claude-dashboard/<slug>.json` files and pings a Telegram bot when subscribed slugs change state. Inbound (in progress): replies on Telegram are fed into the matching active session via Claude Code hooks, as if you'd typed them at the prompt.

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
3. A daemon you run on a remote host — MCP binds to loopback only; assume the same machine as Claude Code.
4. A multiplexer / GUI / keystroke-injection shim into a *running* terminal. Belfry never types into your active terminal. For idle sessions it spawns a parallel `claude --resume` against the same on-disk transcript — that's a programmatic Claude Code invocation, not a hijack of the user's terminal.

## Architecture

```
                 outbound                                inbound
  Claude Code hooks                            Telegram (your phone)
        ↓                                              ↕
  claudelike-bar hook                           getUpdates poller
        ↓                                              ↓
  /tmp/claude-dashboard/<slug>.json            per-slug inbox (in-process)
        ↓                                              ↓
  chokidar watcher                             HTTP MCP server (127.0.0.1)
        ↓                                              ↓
  composer + throttle                          Claude Code hooks call MCP
        ↓                                              ↓
  Telegram sendMessage                         Stop / PreToolUse hook
        ↓                                         returns reply as
  phone                                          decision/reason text
```

Single belfry process owns: the chokidar watcher, the Telegram poller, the per-slug inboxes, and the local HTTP MCP endpoint.

## Source layout

```
bin/belfry.js          — entry point + daemon loop
lib/watcher.js         — chokidar watcher on /tmp/claude-dashboard/*.json
lib/composer.js        — 3-line mobile-friendly message builder
lib/telegram.js        — Bot API HTTP helper (sendMessage)
lib/throttle.js        — per-slug rate limiting + coalesce
lib/config.js          — load + validate ~/.claude/belfry.jsonc
lib/inbox.js           — per-slug inbox (continuation + interrupt queues)
lib/reply-tracker.js   — outbound message_id → slug LRU
lib/router.js          — incoming Telegram update → (slug, queue, text)
lib/poller.js          — Telegram getUpdates long-poll loop
lib/mcp-server.js      — JSON-RPC over HTTP on 127.0.0.1, drain/peek tools
lib/slug.js            — slug derivation (mirrors claudelike-bar's rules)
lib/dispatcher.js      — picks inbox-vs-spawn based on dashboard status
lib/session-resolver.js — find most-recent session uuid for a slug's cwd
lib/runner.js          — spawn `claude --resume <id> --print …` for idle drives
hooks/stop-hook.js     — installable Stop hook (Phase 1)
test/                  — node --test
```

Phase 2 will add `hooks/pre-tool-use-hook.js` (interrupt-and-replace) and an interrupt-routing branch in `lib/router.js`. Phase 3 adds `hooks/notification-hook.js`.

## Bidirectional design (binding spec for in-progress work)

**Mechanism.** Two paths, picked at dispatch time by `lib/dispatcher.js` based on the slug's current dashboard status (`/tmp/claude-dashboard/<slug>.json`):

1. **Active session (status: working/tool_end/notification/etc.) → hook drain.** The reply lands in the in-memory inbox; the next hook firing on that session drains it.
   - `Stop` hook → continuation. Returns `{"decision":"block","reason":"<reply>"}` so Claude resumes as if the user typed `<reply>`.
   - `PreToolUse` hook → interrupt-and-replace (Phase 2, #3). Drains a separate `interrupt` queue; returns the same shape to short-circuit the tool with user feedback.
   - `Notification` hook → permission answer (Phase 3, #4). Same drain pattern.
2. **Idle session (status: ready / missing JSON / error) → spawn-and-relay.** The dispatcher resolves the slug's most-recent session UUID via `lib/session-resolver.js` (newest `.jsonl` mtime under `~/.claude/projects/<encoded-cwd>/`) and runs `claude --resume <id> --print "<reply>"` from the slug's cwd via `lib/runner.js`. Stdout is sent back to the same Telegram chat so the user sees the answer on their phone without alt-tabbing to the terminal. The on-disk JSONL is shared with the user's terminal session — when they next interact, the spawned turn is already in history.

Idle = `status === 'ready'` OR `status === 'error'` OR no dashboard JSON. Anything else is treated as active (the session is mid-conversation; a parallel spawn would race the same JSONL).

**Why two paths.** Spawning into an active session creates a JSONL race; the hook drain avoids that by piggybacking on the existing turn. Hook drain into an idle session is a no-op forever; spawning lights it back up. Each path covers what the other can't.

**Inbox semantics.**
1. Multiple replies for one slug between drains **concatenate** into a single prompt (separator: blank line). They're treated as one thought sent in pieces.
2. Continuation inbox and interrupt inbox are separate queues per slug.
3. Drain is destructive — once a hook reads it, it's gone. No re-delivery.

**Routing inbound Telegram → slug.**
1. Primary: Telegram quote-reply. Every outbound belfry message records its `message_id → slug`; replying to one binds the message to that slug.
2. Fallback: `/<slug-name> message body` for cold sends with no message to quote.
3. Unrouteable messages (no quote, no recognized prefix) → log + ignore. Don't guess.

**Session ↔ slug binding.** Sessions identify themselves by **cwd basename → slug**, matching claudelike-bar's existing convention. Hooks pass `$CLAUDE_PROJECT_DIR` (or equivalent) when calling the MCP; the MCP derives slug server-side. No per-project env wiring required.

**MCP transport.** HTTP on `127.0.0.1:<port>` (default `9876`, env override `BELFRY_MCP_PORT`). **Never stdio** — the Telegram poller is consume-once and inbox state is shared across sessions, so a single long-running daemon is forced. Loopback-only binding means no auth.

## Subscription config (`~/.claude/belfry.jsonc`)

See `docs/belfry.jsonc.example` for the canonical form. Phase 1+ will extend the schema with an inbound block (per-slug enable for replies, per-slug Telegram routing aliases). Keep additions backward-compatible — existing configs must continue to work as outbound-only.

`VALID_EVENTS` in `lib/config.js` is `{ready, error, waiting}` — a deliberately small subset of what claudelike-bar emits, to keep ping volume low. Note: `waiting` is currently a dead option (claudelike-bar doesn't produce that status). Either remove it or wire it up.

## Message format

Three-line composer optimized for mobile lock-screen previews. See `lib/composer.js`. No markdown tables, no nested lists, no ASCII art — the user should triage at a glance.

When inbound lands, outbound messages need a footer indicating the message is replyable (e.g. "↩ Reply to this message to continue this session"). Tight on character budget; keep additions surgical.

## Dependencies on claudelike-bar

belfry currently reads status JSONs that [claudelike-bar](https://github.com/harteWired/claudelike-bar)'s hook writes to `/tmp/claude-dashboard/<slug>.json`, and `lib/slug.js` mirrors claudelike-bar's slug derivation exactly (env → path index → cwd basename) so the hook-side slug matches the JSON-side slug. This makes claudelike-bar a hard install dep today.

**Direction (tracked in #6):** belfry should run standalone. The plan is to vendor a minimal hook inside belfry that writes the same JSON shape — claudelike-bar becomes an optional integration that adds the status bar UI on top, but belfry alone is enough for the Telegram bridge. Until that ships, treat the JSON contract as "what belfry expects to read" and verify against actual files in `/tmp/claude-dashboard/` rather than upstream docs.

belfry also reads `last_response` (when present) for the "Claude: …" line in the composer. Documented as added in claudelike-bar v0.18.1+, but the version installed in this workspace is v0.17.0 and live JSONs only carry `last_prompt`. The composer degrades gracefully (skips the line) but it never renders today. Tracked in #5.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Forum topic ID, if posting to a Forum group's topic |
| `BELFRY_MCP_PORT` | no | Override default MCP port (default `9876`) — Phase 1+ |

## Privacy

1. No prompt or response text is logged to stderr — only event metadata (slug, status, timestamps).
2. Bot token + chat ID are passed as env vars only — no on-disk config inside the project.
3. Inbound: only messages from `BELFRY_CHAT_ID` are accepted. Telegram replies from any other chat are dropped silently. Don't introduce a whitelist of additional chat IDs without a real reason — single-user is the design.

## Setup

See `README.md` for the bot token + chat ID quick start. This file is for design constraints and conventions; setup steps live in the README so they show on the GitHub repo page.
