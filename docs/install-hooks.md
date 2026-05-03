# Installing belfry hooks

Belfry's bidirectional features need Claude Code hooks that drain the local belfry MCP at the right boundaries. This doc covers Phase 1 only (Stop hook → continuation). Phases 2 and 3 add `PreToolUse` and `Notification` hooks; this file will grow as those land.

## Prerequisites

1. Belfry is running locally and reachable on `127.0.0.1:9876` (or whatever `BELFRY_MCP_PORT` is set to).
2. You know the absolute path to `hooks/stop-hook.js` in your belfry checkout.

## Stop hook (Phase 1)

Add this to `~/.claude/settings.json` under `hooks`:

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/belfry/hooks/stop-hook.js"
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/belfry/` with your actual checkout path.

## What it does

When a Claude Code session reaches the end of a turn:

1. The hook runs and reads the Stop event JSON from stdin.
2. It derives the slug for this session using the same rules `claudelike-bar` uses (`CLAUDELIKE_BAR_NAME` env → path index → cwd basename).
3. It calls belfry's MCP `drain_inbox(slug, "continuation")` over loopback HTTP.
4. If the inbox returned text, it prints `{"decision":"block","reason":"<text>"}` to stdout — Claude Code resumes with that text as the next prompt, identical to you typing it at the terminal.
5. If the inbox is empty, the daemon is unreachable, or anything else goes wrong, the hook exits silently. Hooks must never block the user because of a bridge daemon issue.

## Verifying it works

1. Start belfry with the env vars set (`BELFRY_TOKEN`, `BELFRY_CHAT_ID`).
2. Open a Claude Code session in a subscribed project.
3. Wait for belfry to ping your phone (or trigger a status change to force one).
4. Reply to that Telegram message with some text.
5. In Claude Code, hit Enter on an empty prompt (or just let the next Stop happen) — the reply text should appear as your next prompt.

## Environment variables read by the hook

| Variable | Default | Purpose |
|---|---|---|
| `BELFRY_MCP_PORT` | `9876` | Port the local belfry MCP is listening on |
| `CLAUDELIKE_BAR_NAME` | unset | Override slug derivation (highest precedence) |
| `CLAUDE_PROJECT_DIR` | unset | Fallback when stdin event lacks `cwd` |

## Troubleshooting

1. **Reply never lands.** Check the slug match. Run `ls /tmp/claude-dashboard/` — the filename without `.json` is the slug claudelike-bar wrote. The hook must derive the same slug. If they differ, set `CLAUDELIKE_BAR_NAME` in the session's environment.
2. **Hook seems to hang.** It shouldn't — the hook has a 2-second RPC timeout and a 200ms stdin wait. If it does, check that belfry is actually listening on the configured port.
3. **Telegram replies are silently ignored.** Verify `BELFRY_CHAT_ID` matches the chat you're replying from. Belfry drops messages from any other chat by design.

## Phase 2 / Phase 3

Tracked in [#3](https://github.com/harteWired/belfry/issues/3) and [#4](https://github.com/harteWired/belfry/issues/4) — install instructions for `PreToolUse` (interrupt-and-replace) and `Notification` (permission answer) hooks will land here when those phases ship.
