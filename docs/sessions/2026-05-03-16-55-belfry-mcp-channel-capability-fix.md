---
date: 2026-05-03
project: belfry
type: session-log
---

# 2026-05-03 — Belfry MCP Channel Capability Fix

## Quick Reference
**Keywords:** belfry, belfry-mcp, MCP, claude/channel, experimental capabilities, plugin:telegram, notifications/claude/channel, bidirectional, hub-spoke, capability declaration, --channels server:belfry, --dangerously-load-development-channels, Claude Code MCP server
**Project:** belfry
**Outcome:** Diagnosed why Telegram quote-replies weren't injecting into the Claude session and patched belfry-mcp's `initialize` response to mirror plugin:telegram. Bug 2 (Stop hook not refreshing `last_response`) deferred — not a belfry bug to fix.

## What Was Done
- Investigated end-to-end with the user: daemon log, registry state, status JSON, session JSONL transcript, hook config.
- Confirmed the daemon was registering and routing inbound Telegram replies (`routed belfry → 1 instance(s)`), but the channel notification never surfaced as a user prompt in the session transcript.
- Read `plugin:telegram`'s `server.ts` to compare against `bin/belfry-mcp.js` and found the capability shape mismatch.
- Patched `bin/belfry-mcp.js` to mirror the official plugin's initialize response.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Move `claude/channel: {}` under `experimental` | Matches `plugin:telegram` server.ts:353-380. `claude/channel` is an experimental MCP capability — Claude Code doesn't recognize it at the top level, so notifications get silently dropped. |
| Add `tools: {}` and `instructions` to initialize response | Mirrors plugin:telegram exactly. Belt and suspenders for any other capability-detection differences. |
| Do NOT modify `~/.claude/hooks/dashboard-status.js` | That file belongs to claudelike-bar. Belfry depends on its status-JSON contract; debugging it from inside belfry is out of scope. The vendored-hook plan tracked in #6 is the right path. |
| Defer bug 2 (Stop hook not updating `last_response`) | Diagnosis was based on one observation that may have been misread (msg sizes 651/651/470 imply `last_response` did refresh between dispatches). User flagged the analysis as overreach. Re-evaluate after restart. |

## Key Learnings
- `claude/channel` MUST live under `capabilities.experimental`, not at the top level. Top-level reserved keys are `tools`, `prompts`, `resources`, `logging`, `experimental`. Anything else is dropped silently — no error, no log line, just no injection.
- Restart of the per-session belfry-mcp is required to pick up the change. The daemon (long-running) doesn't need a restart for this.
- When in doubt about MCP server shape, read the official plugin source. `plugin:telegram` is the reference implementation for the channel-injection path.

## Solutions & Fixes
- **Inbound Telegram replies not injecting** → fixed by moving `claude/channel: {}` under `experimental` in belfry-mcp's initialize response. Mirrors `plugin:telegram`'s declaration exactly.

## Files Modified
- `bin/belfry-mcp.js`: Updated `handleMessage` initialize handler to declare `tools: {}`, `experimental: { 'claude/channel': {} }`, and an `instructions` string. Comment explains why top-level `claude/channel` was wrong.

## Follow-ups
- [ ] User restarts their `claude --channels server:belfry --dangerously-load-development-channels server:belfry` session to spawn a fresh belfry-mcp with the fixed capabilities.
- [ ] Re-test Telegram quote-reply → session injection after restart.
- [ ] If outbound is still flaky after restart, re-investigate bug 2 (Stop hook not refreshing `last_response_at`). May require capturing what `transcript_path` is passed to the hook — but only via observation, not by editing claudelike-bar.
- [ ] Pending: 4 modified files on the branch (bin/belfry.js, docs/install-mcp.md, lib/reply-tracker.js, test/reply-tracker.test.js) plus today's bin/belfry-mcp.js change. Decide whether to bundle or split for commit/PR.
