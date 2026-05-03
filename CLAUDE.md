# belfry

> Also follow /workspace/CLAUDE.md for global workspace conventions.

Outbound Telegram relay for Claude Code terminal status. Watches [claudelike-bar](https://github.com/harteWired/claudelike-bar)'s `/tmp/claude-dashboard/<slug>.json` files, debounces, composes mobile-friendly messages, posts to a Telegram bot.

Outbound only. Bidirectional chat with a specific Claude session is covered by Anthropic's official Telegram channel plugin — belfry exists for the multi-terminal *fan-out* case those plugins don't cover.

## What it is and isn't

It is:

1. A long-running Node process that subscribes to a file bus (`/tmp/claude-dashboard/*.json`) populated by `claudelike-bar`'s hook.
2. Per-slug opt-in via `~/.claude/belfry.jsonc` — silent by default, you whitelist what you want pinged.
3. Telegram-only. Bot API via raw HTTP POST. No SDK, no multi-platform abstraction.

It isn't:

1. A way to chat with Claude from your phone — use Anthropic's `claude --channels plugin:telegram` for that.
2. A permission-relay forwarder — same.
3. A general-purpose webhook router — Telegram is the only target.
4. A retry/circuit-breaker framework — per-slug throttle covers the spam case; transient API failures are logged and dropped.

## Architecture

```
Claude Code hooks
    ↓
hooks/dashboard-status.js  (lives in claudelike-bar)
    ↓
/tmp/claude-dashboard/<slug>.json   (already populated)
    ↓
belfry watcher (chokidar)
    ↓
composer + throttle
    ↓
Telegram Bot API
    ↓
phone
```

## Source layout

```
bin/belfry.js          — entry point + daemon loop
lib/watcher.js         — chokidar watcher on /tmp/claude-dashboard/*.json
lib/composer.js        — 3-line mobile-friendly message builder
lib/telegram.js        — Bot API POST helper (raw HTTP)
lib/throttle.js        — per-slug rate limiting + coalesce
lib/config.js          — load + validate ~/.claude/belfry.jsonc
test/                  — node --test
```

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) (`/newbot`). Save the token.
2. Find your chat ID: send any message to your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`.
3. Copy `docs/belfry.jsonc.example` to `~/.claude/belfry.jsonc` with the slugs you want pinged.
4. Run belfry with the bot credentials in env:
   ```
   BELFRY_TOKEN=<token> BELFRY_CHAT_ID=<chat-id> node bin/belfry.js
   ```
   For long-running setups, wrap this in a launcher that pulls the
   credentials from whatever secret store you use (env file, age, AWS
   Secrets Manager, GCP Secret Manager, HashiCorp Vault, …) and `exec`s
   the daemon with the variables exported. Belfry itself is intentionally
   agnostic about the source.

## Subscription config (`~/.claude/belfry.jsonc`)

```jsonc
{
  // Per-slug opt-in. Slugs not listed here are silently ignored.
  "subscriptions": {
    "life-planner": {
      // Events that trigger a ping. Defaults to ["ready"] if omitted.
      // Possible values: "ready" (Stop/Notification → ready), "error", "waiting".
      "events": ["ready", "error"]
    },
    "financial-planner": {
      "events": ["ready"]
    }
  },

  // Throttle per slug. Default 30s. Coalesces fan-out bursts.
  "throttleMs": 30000,

  // Coalesce window — multiple events within this window for the same slug
  // collapse into one message describing the latest state.
  "coalesceMs": 5000,

  // Truncate the user prompt + assistant response in the Telegram message.
  // Defaults: 200 / 400 chars.
  "promptCap": 200,
  "responseCap": 400
}
```

## Message format

Three-line composer optimized for mobile lock-screen previews:

```
🔔 life-planner — Needs permission

You: write tests for the migration script
Claude: I'd like to run `npm test` to verify the new test files…
```

No markdown tables, no nested lists, no ASCII art. The user should be able to triage the ping at a glance.

## Dependencies on claudelike-bar

belfry relies on `last_response` being present in the status JSON. The field is added by claudelike-bar v0.18.1+ (always captured by the hook on Stop/Notification, truncated to ~500 chars). Without it, messages still send but only show the project + status.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Forum topic ID, if posting to a Forum group's topic rather than a plain chat |

## Privacy

- No prompt or response text is logged to stderr — only event metadata (slug, status, timestamps).
- `last_response` capture in claudelike-bar always runs, so the field is present in the JSON. Belfry sends whatever the JSON contains; subscription-based opt-in is the gate.
- Bot token + chat ID are passed as env vars only — no on-disk config inside the project.
