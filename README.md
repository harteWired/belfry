# belfry

Telegram-to-terminal MUX rigging for remote driving of multiple Claude Code projects. Status from N parallel sessions fans out to one Telegram feed; replies on Telegram feed back into the matching session as if you'd typed them at the prompt.

Single-user, single-platform (Telegram), single-host (loopback). Read `CLAUDE.md` for the architecture and design constraints.

## What it does

Two flows, one daemon.

**Outbound.** Watches [claudelike-bar](https://github.com/harteWired/claudelike-bar)'s `/tmp/claude-dashboard/<slug>.json` files. When a subscribed slug enters a state you care about (`ready`, `error`), composes a 3-line message with the last user prompt + last Claude response and pushes it to your Telegram bot. Per-slug throttle and coalesce keep fan-out bursts from spamming you.

**Inbound.** Replies on Telegram route back to the matching session via Claude Code hooks. A `Stop` hook drains the slug's inbox and feeds the reply text back as the next prompt. No multiplexer, no keystroke injection — the local terminal stays sovereign. Replies show up exactly as if you'd typed them.

Routing inbound: quote-reply (primary) or `/<slug-name> message body` (fallback). Replies from any chat ID other than `BELFRY_CHAT_ID` are silently dropped.

## Why belfry exists

Anthropic's official Telegram channel plugin (`claude --channels plugin:telegram`) handles bidirectional chat with one specific Claude session. Perfect for "I want to talk to one project from my phone." It does not fan out across many parallel terminals into one feed, and it doesn't let you drive more than one session from that one Telegram conversation.

belfry is the inverse: outbound-only at first, then bidirectional, multi-terminal, per-slug whitelist. Install once, subscribe the projects you care about, and your phone tells you when any of them needs you — and you can answer back.

## Quick start

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) (`/newbot`). Save the token.
2. Get your chat ID: send the bot any message, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`.
3. Copy `docs/belfry.jsonc.example` to `~/.claude/belfry.jsonc` and edit the subscription whitelist.
4. Run with the bot credentials in env:
   ```
   BELFRY_TOKEN=<token> BELFRY_CHAT_ID=<chat-id> node bin/belfry.js
   ```
5. (For inbound replies) Add the belfry MCP plugin to each project you want to drive — see `docs/install-mcp.md`. Drop a `.mcp.json` at the project root pointing at `bin/belfry-mcp.js` and restart the Claude Code session.
6. For an always-on setup, write a small launcher that pulls the credentials from your secret store of choice (env, dotenv, AWS Secrets Manager, age-encrypted YAML, whatever you use) and `exec`s `node bin/belfry.js`. Belfry itself is intentionally agnostic — it just reads env vars.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Forum topic ID, if posting to a Telegram Forum group's topic rather than a plain chat |
| `BELFRY_MCP_PORT` | no | Local registry HTTP port (default `9876`). Bound to loopback only. The per-session MCP plugin uses `BELFRY_MCP_BASE` (default `http://127.0.0.1:9876`) to find the daemon. |

## Architecture (one diagram)

```
                  Telegram (one bot, one chat)
                            ↕
                  belfry-daemon (bin/belfry.js)
                  ↑           ↓
       outbound watcher   HTTP loopback registry
                            ↓
        ┌───────────────────┼───────────────────┐
        ↓                   ↓                   ↓
    session A           session B           session C
   [belfry-mcp]        [belfry-mcp]        [belfry-mcp]
```

**Two processes.** The daemon owns the bot, polls Telegram, and runs the chokidar watcher → composer chain for outbound. Each session you want bidirectional runs a tiny `belfry-mcp` stdio plugin that registers with the daemon and long-polls for replies. When a reply arrives, the plugin emits MCP `notifications/claude/channel` to inject the text into its parent claude — the same mechanism the bundled `plugin:telegram` uses for one-session bidirectional, generalized to N sessions sharing one bot.

## What's shipped

| Phase | Scope | Status |
|---|---|---|
| 0 | Outbound: chokidar watcher → composer → Telegram | shipped |
| 1 | Inbound (Stop-hook + inbox MCP) | shipped, then replaced by Phase 2 |
| 2 | Inbound (per-session MCP plugin + central registry) | shipped — works for active *and* idle sessions |

Out of scope for now: per-session permission answers, interrupt-and-replace mid-tool-call. Both possible on top of Phase 2 by adding more notification methods to the plugin.

## Running tests

```
npm test
```

Pure ESM, Node ≥ 20. Only runtime dep is `chokidar`. Telegram client is native `fetch`; MCP plugin is hand-rolled JSON-RPC over stdio; registry is hand-rolled HTTP over `node:http`. No SDK required.
