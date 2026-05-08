---
date: 2026-05-03
project: belfry
type: session-log
---

# 2026-05-03 — Belfry MCP Server Name Mismatch

## Quick Reference
**Keywords:** belfry, belfry-mcp, MCP, claude/channel, serverInfo.name, .mcp.json, plugin:telegram, notifications/claude/channel, channel injection, hub-spoke, --channels server:belfry, recv long-poll, registry, transcript JSONL
**Project:** belfry
**Outcome:** Yesterday's capability fix did not unblock Telegram→session injection. Diagnosed that the daemon was still routing successfully (`routed belfry → 1 instance(s)`) but no `<channel source="belfry">` ever appears in the session transcript JSONL. Hypothesis: `serverInfo.name` was `'belfry-mcp'` while the `.mcp.json` key is `'belfry'` — plugin:telegram has both matching. Patched the name and added a stderr log on emit. Test pending: user restart + Telegram quote-reply.

## What Was Done
- Verified daemon (pid 179044) listening on 9876 and belfry-mcp (pid 453628) registered as `slug=belfry` at 00:00:14 with two ESTABLISHED sockets to the daemon (recv long-poll active).
- Confirmed `/workspace/.belfry/belfry.log` shows `routed belfry → 1 instance(s) (16 chars)` at 00:09:55 — delivery into the registry queue worked.
- Scanned the active session JSONL (`6fd283a9-…jsonl`): zero `<channel source="belfry">` injections; the only `<channel>` strings present are quoted file content from Read-tool outputs. Confirms injection never occurred.
- Verified Claude Code DID acknowledge the channel server: transcript contains `addedNames:["belfry","plugin:telegram:telegram"]` event at 00:00:32, so the `instructions` block from initialize was accepted.
- Compared MCP wire format against `@modelcontextprotocol/sdk`'s `serializeMessage` — confirmed our hand-rolled `JSON.stringify(msg) + '\n'` matches exactly. Format is not the issue.
- Compared belfry-mcp's `initialize` response against `plugin:telegram`'s `server.ts:353-380` line-by-line. Both declare `capabilities.tools: {}` and `capabilities.experimental: { 'claude/channel': {} }`. The single remaining difference: plugin:telegram's `serverInfo.name` is `'telegram'` (matches its plugin install name), but belfry-mcp's was `'belfry-mcp'` while the `.mcp.json` key is `'belfry'`.
- Patched `bin/belfry-mcp.js`: renamed `serverInfo.name` → `'belfry'` to match the `.mcp.json` key, and added a stderr log inside the recv loop so the next test will print `recv got N chars — emitting channel notification` if the emit path is reached.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Rename `serverInfo.name` to `'belfry'` (was `'belfry-mcp'`) | plugin:telegram has `serverInfo.name === '.mcp.json' key` (both `'telegram'`). Claude Code likely identifies channel servers by the `.mcp.json` key it loaded; if `serverInfo.name` reported back during `initialize` doesn't match, channel-source resolution may silently drop the notification. Cheap fix, high-likelihood candidate. |
| Add `log()` call inside the recv loop, not inside `injectChannelMessage` | We need to see whether the emit path is even reached — distinguishes "recv loop didn't get text" from "stdio write happened but Claude Code dropped it." Stays in stderr (visible in MCP debug log) and out of stdout (would corrupt JSON-RPC). |
| Do NOT also declare `claude/channel/permission` capability | That's about relaying Claude permission prompts to the user, not channel input injection. Wrong knob for this bug. |

## Key Learnings
- Channel acknowledgement (the `addedNames` event in the transcript) means the server's `instructions` block was accepted and the channel was registered — but it does NOT mean `notifications/claude/channel` from that server will be honored. Two separate gates.
- The MCP wire format for stdio is dead simple: `JSON.stringify(message) + '\n'`. No Content-Length framing, no length prefix, no tagging. Matches what we already do.
- The `_oncancel`/`_onnotification` SDK paths drop notifications whose method has no registered handler, but that's the receiving side. Our sending side just writes the JSON; if Claude Code's reader silently drops "channel notifications from a server whose serverInfo.name doesn't match the registered .mcp.json key," we'd see exactly the symptom we're seeing.

## Solutions & Fixes
- **Telegram replies still not injecting after yesterday's capability fix** → patched `serverInfo.name` to match the `.mcp.json` key (`'belfry'`). Test pending — verifies via stderr log line whether the emit path runs, and via session transcript whether `<channel source="belfry">` finally appears as user input.

## Files Modified
- `bin/belfry-mcp.js`:
  - Line 63: `serverInfo: { name: 'belfry-mcp', version: '0.2.0' }` → `serverInfo: { name: 'belfry', version: '0.2.0' }`.
  - Around line 170: added `log(\`recv got \${body.text.length} chars — emitting channel notification\`)` immediately before `injectChannelMessage(body.text)` so the next test attempt logs to stderr whether the emit ran.

## Follow-ups
- [ ] User restart: `claude --dangerously-skip-permissions --channels server:belfry --dangerously-load-development-channels server:belfry`. Required so a fresh belfry-mcp loads with the new `serverInfo.name`.
- [ ] User sends a Telegram quote-reply to a recent belfry message.
- [ ] Inspect: (a) `/workspace/.belfry/belfry.log` — should show another `routed belfry → 1 instance(s)` line; (b) MCP debug log / Claude Code stderr — should show the new `recv got N chars — emitting channel notification` line; (c) session JSONL — should show a `<channel source="belfry">` user-input event.
- [ ] If emit-line appears but no transcript injection: bug is on Claude Code's side (open an issue with the official plugin team — channel server name resolution).
- [ ] If emit-line does NOT appear: belfry-mcp's recv loop never returned text. Check that the registered instance_id matches what the daemon's `routed` line targeted (race? stale registration?).
- [ ] Once injection works end-to-end, remove the temporary `recv got N chars` debug log line.
- [ ] Pending uncommitted changes on `feature/mcp-hub-spoke`: bin/belfry-mcp.js, bin/belfry.js, docs/install-mcp.md, lib/reply-tracker.js, test/reply-tracker.test.js plus today's edits. Decide bundling for commit/PR.
