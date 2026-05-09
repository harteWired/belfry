# belfry

Telegram-to-terminal MUX rigging for remote driving of multiple Claude Code projects. Status from N parallel sessions fans out to one Telegram feed; replies on Telegram feed back into the matching session as if you'd typed them at the prompt.

Single-user, single-platform (Telegram), single-host (loopback). Read `CLAUDE.md` for the architecture and design constraints.

## What it does

Two flows, one daemon.

**Outbound.** Watches `/tmp/claude-dashboard/<slug>.json` files (a shared local-machine convention; see `docs/CONVENTION.md`). When a subscribed slug enters a state you care about (`ready`, `error`), composes a 3-line message with the last user prompt + last Claude response and pushes it to your Telegram bot. Per-slug throttle and coalesce keep fan-out bursts from spamming you.

**Inbound.** Replies on Telegram route back to the matching session via a per-session `belfry-mcp` MCP plugin. The daemon owns the bot and the registry; each plugin registers over loopback HTTP and long-polls for replies, then emits MCP `notifications/claude/channel` to inject the text into its parent claude as user input — same path the bundled `plugin:telegram` uses, generalized to N sessions sharing one bot. No multiplexer, no keystroke injection — the local terminal stays sovereign.

**Replying to Telegram from the session.** Two paths. The model can call belfry-mcp's `reply` tool to send back explicitly. Or, automatically: when an inbound Telegram message routes into a session, the daemon marks the slug as owing a reply; on the next status flip to `ready` for that slug, it sends `last_response` quote-replied to the originating message and clears the marker.

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
6. (For status JSONs without claudelike-bar) Run `belfry-install-hook` from each project root. It adds `belfry-hook` to the project's `.claude/settings.json` and skips if it detects another writer of the convention (e.g. claudelike-bar). With both installed, neither overwrites the other — the first installer wins, the second is a no-op.
7. For an always-on setup, write a small launcher that pulls the credentials from your secret store of choice (env, dotenv, AWS Secrets Manager, age-encrypted YAML, whatever you use) and `exec`s `node bin/belfry.js`. Belfry itself is intentionally agnostic — it just reads env vars.

## Required env vars

| Variable | Required | Description |
|---|---|---|
| `BELFRY_TOKEN` | yes | Bot token from @BotFather |
| `BELFRY_CHAT_ID` | yes | Numeric chat ID where messages should land |
| `BELFRY_FORUM_TOPIC_ID` | no | Forum topic ID, if posting to a Telegram Forum group's topic rather than a plain chat |
| `BELFRY_MCP_PORT` | no | Local registry HTTP port (default `49876`, IANA dynamic range — avoids collision with fusion360-mcp and other tools that hardcode `9876`). Bound to loopback only. The per-session MCP plugin uses `BELFRY_MCP_BASE` (default `http://127.0.0.1:49876`) to find the daemon. |

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

## Trust model

Read this before pasting your bot token anywhere. Belfry's design is small and the threat model is short, but the consequences are sharp.

**Your bot token + chat ID together are equivalent to a shell credential.** When inbound is enabled, any Telegram message from `BELFRY_CHAT_ID` is injected into the matching Claude Code session as user input — same path your keyboard goes through. That includes "run this shell command", "delete this directory", "read this file and post the contents." Treat `BELFRY_TOKEN` like an SSH private key, not like a webhook URL.

What this implies:

1. **Don't post `BELFRY_TOKEN` in screenshots, logs, dotfile backups, or shared screen sessions.** Use a secret store (env loaded from your shell startup, age-encrypted YAML, `pass`, AWS Secrets Manager — whatever you already use). Belfry never reads tokens from disk inside the project; it only takes env vars. The launcher that sets the env is your responsibility.
2. **Rotate immediately if you suspect leak.** Message [@BotFather](https://t.me/BotFather) → `/revoke` → pick the bot → copy the new token. The old token is dead instantly and any attacker holding it loses access at the API edge. Update your launcher's secret store with the new value and restart belfry.
3. **One chat, one user.** Inbound messages from any chat ID other than `BELFRY_CHAT_ID` are silently dropped (`lib/router.js`). Don't add the bot to a group whose chat ID could collide; don't expand the allowlist without thinking through who that gives shell-equivalent access to.
4. **The registry is loopback-only.** The daemon binds `127.0.0.1:49876` and gates `/register`, `/recv`, `/send`, `/unregister` on a 32-byte bearer token at `~/.local/state/belfry/registry.token` (mode 0600). Other UIDs on the same machine cannot register a fake slug or call `/send` to abuse your bot. Don't change this binding to `0.0.0.0` — the trust model assumes loopback.
5. **`/tmp/claude-dashboard/` should be 0700 with files 0600.** belfry-hook and belfry's watcher both write at these perms. If you have an older directory created by an earlier `claudelike-bar` or `belfry-hook` at 0755, prompt and response text in `last_response` is readable by other UIDs on the host. The daemon warns at startup if it finds a wider mode; `chmod 700 /tmp/claude-dashboard` to tighten.
6. **`ANTHROPIC_API_KEY`, if set, leaves the host.** The summarizer (`lib/summarizer.js`) sends prompts and responses to `https://api.anthropic.com/v1/messages` so they can be Haiku-summarized into the lock-screen ping. The endpoint is hardcoded — there is no env override and no redirect path — but the data does leave the machine. Anthropic's standard data-handling applies (zero-data-retention is on by default for API customers). Subscriptions opt-in to summarize per-slug; the no-key fallback is a hard truncate that never leaves the host.

What belfry doesn't try to defend against:

- A compromised host. If a process running as your UID can read `~/.local/state/belfry/registry.token`, it can register as any slug. That's fine — it can already read your SSH keys. The trust boundary is the host, not the process.
- A compromised Telegram client. If your phone is rooted and an attacker can read messages or impersonate the bot via your account, belfry's chat-ID gate doesn't help. That's a "your phone is compromised" problem.
- A coerced user. Someone holding your phone can send commands to running Claude sessions. Don't unlock Telegram next to people you don't trust.

The repo is open source and tied to a real name. That's deliberate: the trust model is short enough to audit in a sitting, the codebase is ~15 small files with one runtime dependency (`chokidar`), and the loopback-only / chat-ID-only design narrows the attack surface to "guard your bot token." A public repo with auditable code is the right shape for a tool whose security posture is a few clear constraints rather than a wall of mitigations.

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
