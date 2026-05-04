# Installing the belfry MCP plugin

For each project you want bidirectional (i.e., to be able to reply on Telegram and have the text land in that session as if you typed it), add the belfry MCP plugin to its Claude Code config.

## Per-project (recommended)

Drop a `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "belfry": {
      "command": "node",
      "args": ["/absolute/path/to/belfry/bin/belfry-mcp.js"]
    }
  }
}
```

Replace `/absolute/path/to/belfry/` with your checkout. Restart any open Claude Code session in that directory **with the channel tag**:

```bash
claude --channels server:belfry
```

The `--channels` flag is mandatory. Without it, Claude Code silently drops every channel notification belfry-mcp emits — the daemon will route the reply, the plugin will write the JSON-RPC notification to stdout, and nothing visible will happen in your session. The flag is the security gate that lets an MCP server inject text into the conversation as if you typed it; Claude Code requires explicit per-session opt-in. Combine with whatever other flags you normally use, e.g. `claude --dangerously-skip-permissions --channels server:belfry`.

The tag format is:

- `server:<name>` — for MCP servers configured in `.mcp.json` or `~/.claude/mcp.json` (this is the belfry case, since the server is named `belfry` in the JSON above).
- `plugin:<name>@<marketplace>` — for plugin-provided channels (e.g. the bundled `plugin:telegram@claude-plugins-official`). Not used by belfry.

You can repeat the flag (`--channels server:belfry --channels plugin:telegram@claude-plugins-official`) to enable both belfry and the official single-session plugin in the same session, though there's rarely a reason to.

## Global (every project gets it)

If you want every Claude Code session to be drivable, put the same block in `~/.claude/mcp.json`. **Caveat:** projects without a corresponding outbound subscription (`~/.claude/belfry.jsonc`) will register but never have anything to receive — silent waste of a stdio process.

## Verifying

1. Start (or restart) belfry: `/workspace/shared/belfry-launch.sh` (or `BELFRY_TOKEN=… BELFRY_CHAT_ID=… node bin/belfry.js`).
2. Open a Claude Code session in the configured project: `claude --channels server:belfry`.
3. The daemon log should show: `registry: registered <slug> (instance <pid>-<id>, pid <session-pid>)`.
4. Reply to one of belfry's Telegram pings (or send `/<slug-name> hi`). The reply should appear in your terminal as the next user prompt within ~1 second.

If step 4 silently fails — daemon logs `routed <slug> → 1 instance(s)` but nothing happens in the session — you almost certainly forgot the `--channels server:belfry` flag. The plugin emits the notification correctly, but Claude Code drops it without a visible warning when the channel isn't tagged.

## What it doesn't do

The plugin only handles **inbound** routing. Outbound status pings still come from the central daemon's chokidar watcher → composer → Telegram chain, exactly as in Phase 0. The plugin doesn't talk to Telegram directly.

## Migrating from Phase 1 (Stop-hook)

If you have the old Stop hook in `~/.claude/settings.json` from before v2, remove it — it points at the now-defunct MCP-over-HTTP drain endpoint. The hook fails silently when belfry doesn't expose that endpoint, so leaving it in place won't break anything, but it's dead code.

```jsonc
// Remove this block from ~/.claude/settings.json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /…/belfry/hooks/stop-hook.js" }
        ]
      }
    ]
  }
}
```
