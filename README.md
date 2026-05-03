# belfry

Outbound Telegram relay for [claudelike-bar](https://github.com/harteWired/claudelike-bar). Pings your phone when any of your Claude Code terminals needs attention, with enough context per message to triage without remembering what that terminal was doing.

Single-purpose, single-user, single-platform. Read `CLAUDE.md` for the architecture and design constraints.

## Quick start

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) (`/newbot`), save the token.
2. Get your chat ID: send the bot any message, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`.
3. Copy `docs/belfry.jsonc.example` to `~/.claude/belfry.jsonc` and edit the subscription whitelist.
4. Run with the bot credentials in env:
   ```
   BELFRY_TOKEN=<token> BELFRY_CHAT_ID=<chat-id> node bin/belfry.js
   ```
5. For an always-on setup, write a small launcher that pulls the credentials from your secret store of choice (env, dotenv, AWS Secrets Manager, age-encrypted YAML, whatever you use) and `exec`s `node bin/belfry.js`. Belfry itself is intentionally agnostic — it just reads env vars.

## Why belfry exists

Anthropic's official Telegram channel plugin (`claude --channels plugin:telegram`) handles bidirectional chat with one specific Claude session. That's perfect for "I want to talk to my project session from my phone." It does *not* fan out status from many parallel terminals into one Telegram feed.

belfry is the inverse: outbound-only, multi-terminal, per-slug whitelist. You install it once, subscribe the projects you care about, and your phone tells you when any of them needs you.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Forum topic ID, if posting to a Telegram Forum group's topic rather than a plain chat |
