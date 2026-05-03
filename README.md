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
5. (Optional, for inbound replies) Install the Stop hook — see `docs/install-hooks.md`.
6. For an always-on setup, write a small launcher that pulls the credentials from your secret store of choice (env, dotenv, AWS Secrets Manager, age-encrypted YAML, whatever you use) and `exec`s `node bin/belfry.js`. Belfry itself is intentionally agnostic — it just reads env vars.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Forum topic ID, if posting to a Telegram Forum group's topic rather than a plain chat |
| `BELFRY_MCP_PORT` | no | Local MCP HTTP port (default `9876`). Bound to loopback only. |

## Architecture (one diagram)

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
  composer + throttle                          Claude Code Stop hook
        ↓                                          drains inbox,
  Telegram sendMessage                          returns text as
        ↓                                       continuation prompt
  phone
```

Single belfry daemon owns: the chokidar watcher, the Telegram poller, the per-slug inboxes, and the local HTTP MCP endpoint.

## What's shipped

| Phase | Scope | Status |
|---|---|---|
| 0 | Outbound: chokidar watcher → composer → Telegram | shipped |
| 1 | Inbound continuation: HTTP MCP + inbox + poller + Stop hook | shipped |
| 2 | Inbound interrupt: PreToolUse hook for "stop, do X instead" | tracked in [#3](https://github.com/harteWired/belfry/issues/3) |
| 3 | Inbound permission answer: Notification hook | tracked in [#4](https://github.com/harteWired/belfry/issues/4) |

Other open work: standalone (no claudelike-bar dep) tracked in [#6](https://github.com/harteWired/belfry/issues/6); hygiene cleanups in [#5](https://github.com/harteWired/belfry/issues/5).

## Running tests

```
npm test
```

Pure ESM, Node ≥ 20. Only runtime dep is `chokidar`. Telegram client is native `fetch`; MCP server is hand-rolled JSON-RPC over `node:http`. No SDK required for either side.
