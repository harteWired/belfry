---
date: 2026-05-08
project: belfry
type: session-log
---

# 2026-05-08 — Autonomous Backlog Clear and Review

## Quick Reference
**Keywords:** belfry, autonomous mode, backlog clear, /review, 4-agent code review, Haiku summarizer, rollup digest, /status command, fusion360-mcp, port 49876, IANA dynamic range, claude --print, subscription auth, auto-reply guard regression, vendored hook, /tmp/claude-dashboard permissions, replyTracker debounce, digest-flush extraction
**Project:** belfry
**Outcome:** Cleared the entire belfry GitHub issues backlog (#1, #5, #7, #11, #12) plus closed 4 stale issues (#3, #4, #6, #8). Shipped per-message Haiku summarizer, rollup digest, and `/status` command. Two full /review passes (cohort + full-branch) — all findings actioned. Daemon port moved 9876 → 49876 to dodge fusion360-mcp. 63 → 170 tests on `feature/mcp-hub-spoke`. Branch is PR-ready (PR #10).

## What Was Done
- Triaged 8 open GitHub issues against the post-v2 architecture: closed #3 (PreToolUse hook) and #4 (Notification hook) as obsolete (replaced by MCP channel notifications); closed #6 (decouple from claudelike-bar) as shipped via vendored hook; closed #8 (long summary command) as superseded by #12; closed #1 epic with full phase status.
- Filed and shipped #11 (rollup digest summarizer) and #12 (`/status` command) during the session.
- Shipped #5 hygiene: pruned `working/idle/offline/done` from `STATUS_EMOJI` (filtered out at subscription gate anyway), updated CLAUDE.md to reflect that `waiting` is now produced by belfry-hook, softened the v0.18.1 claudelike-bar dep claim.
- Built `lib/summarizer.js` for #7 — calls Anthropic Messages API via raw fetch (no SDK, per the project's no-deps rule). SHA256 LRU cache (256 entries), 2s timeout, fail-open on missing key / timeout / non-2xx / parse failure.
- Built `lib/digest.js` for #11 — per-slug rollup buffer with two flush triggers (idleMs and windowMs cap). Wired through `bin/belfry.js` so digest-mode slugs bypass the per-event throttle.
- Built `lib/status-handler.js` for #12 — `/status` reads `/tmp/claude-dashboard/*.json`, produces all-slugs one-liner or single-slug Haiku-summarized rollup. Reserved command in `lib/router.js`.
- Two cohort-level /review passes (4-agent + judge) caught: digest shutdown race (Digest._flush was fire-and-forget while `process.exit(0)` raced it); untruncated digest payload to Haiku; STATUS_RE charset wider than PREFIX_RE; truncate dedup; summarizeBatch missing cache for /status.
- Full-branch /review caught 13 findings, 5 above warning bar:
  - **CRITICAL:** auto-reply guard rejected legitimate working→ready transitions because `belfry-hook` writes the same `last_response` on PreToolUse/PostToolUse/Stop. Auto-reply was silently never firing once the vendored hook was installed.
  - WARNING: `/status` digest message_id never recorded in replyTracker (quote-replies dropped silently).
  - WARNING: belfry-mcp 401 token-rotation logged "exiting for respawn" but never actually exited (wedged in a 2s backoff loop).
  - WARNING: `Registry.knownSlugs()` allocated a fresh Set per Telegram update, even for chat-id-rejected ones.
  - WARNING: `/tmp/claude-dashboard` world-readable on default umask (last_prompt/last_response leaks across UIDs).
- Shipped all 8 deferred suggestions: replyTracker write debounce (setImmediate coalesce + flush() on shutdown), 256 KiB stat-gate on status JSON reads, maybeSummarize/maybeSummarizeBatch helper extraction (3 callsites collapsed), `lib/digest-flush.js` extracted with 8 unit tests, readJson Buffer accumulation, indexOf-based path/query split for /recv hot path, auto-reply cross-module invariant doc, slug.js memoize ruled out with explanatory comment.
- Hit a port collision with fusion360-mcp (which hardcodes 9876). Killed the orphan, then moved belfry's default to 49876 (IANA dynamic range, kept "876" suffix for grep continuity). Updated daemon, spoke, registry, README, CLAUDE.md.
- Updated `/workspace/shared/belfry-launch.sh` to pull `ANTHROPIC_API_KEY` from secrets-manager so the launcher picks it up automatically when set.
- Investigated `claude --print` as a subscription-auth path for the summarizer features (instead of paying for API). Verified it works without a key but per-call latency is 6–20s vs 2s for the API; flaky on prompt compliance. Recommended skipping unless cost matters.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Summarizer lives in the daemon, not a sidecar | User explicitly chose this. Kept the no-SDK rule by calling Anthropic via raw `fetch` — same pattern as `lib/telegram.js`. New `lib/summarizer.js` module. |
| Skip `claude --print` subscription path for summarizer | 6–20s per-call latency (process startup) vs 2s API. Format compliance flaky — claude treats system prompt as overlay on its default coding-assistant prompt, doesn't fully obey instructions. Documented as Option 1/2/3 tradeoff for the user; they chose to defer. |
| Port move to 49876 | fusion360-mcp hardcodes 9876 (it's its IANA-registered communication port with the Fusion 360 add-in). Belfry's port is configurable; belfry moves. 49876 is in IANA dynamic range and keeps the "876" suffix for grep continuity. |
| Auto-reply guard now checks (status, last_response) tuple | Just `last_response` equality rejected legitimate working→ready transitions because vendored hook writes the same transcript tail on every event. Tuple comparison preserves duplicate detection without false negatives. |
| `/status` digest single-slug case records its message_id | Single-slug `/status` is naturally a thread anchor — user will quote-reply to it. All-slugs case skips recording (no slug to bind). New `recordReply` callback on `makeStatusHandler`. |
| Port-1 perf finding ruled non-issue | Performance reviewer flagged `summarize` blocking the throttle dispatch. Verified Throttle's setTimeout fires dispatch without awaiting → cross-slug dispatches already concurrent. Per-slug latency is the explicit cost of opting into summarize. |

## Solutions & Fixes
- **Auto-reply silently never firing with vendored hook:** changed guard to `(status, last_response)` tuple comparison. Added regression test `test/auto-reply.test.js:fires when status flips to ready even if last_response matches the prior non-ready write`.
- **/status quote-replies dropped:** added `recordReply` injection into `makeStatusHandler`; daemon passes `replyTracker.record`. All-slugs case correctly skips recording.
- **belfry-mcp 401 wedge:** replaced fall-through with `await shutdown('token-rotated')` so Claude Code respawns the spoke.
- **`new Set(this.bySlug.keys())` on every Telegram update:** `route()` now takes a `hasSlug` accessor; poller passes `registry.hasSlug.bind`. O(1) Map.has on prefix-path branch only.
- **/tmp/claude-dashboard world-readable:** `mkdirSync({ mode: 0o700 })` and `writeFileSync({ mode: 0o600 })` in `bin/belfry-hook.js`. Same in `lib/watcher.js`. `docs/CONVENTION.md` now mandates these perms for any participant.
- **Digest shutdown race:** `Digest._flush` tracks in-flight Promises in a `Set`; `flushAll` awaits `Promise.all(...)`; daemon's shutdown handler awaits `digest.flushAll()` before `process.exit(0)`.
- **fusion360-mcp port collision:** killed the orphan (PPID=1, broken Fusion 360 connection from 8 hours prior) and moved belfry to 49876.
- **Stale belfry-mcp spokes after port move:** identified 3 spokes — 1 live (this session, on old port 9876) and 2 orphans from old `npm test` runs polling phantom ephemeral ports. User will restart their claude session; orphans killed.
- **Anthropic key not in secrets:** ruled subscription-auth path too slow. User deferred — leaving summarizer features inert is the no-op fall-open path. Launcher updated to pick up the key automatically when set.

## Key Learnings
- **`claude --print` is not a viable subscription-auth path for hot-path use.** Process startup (LSP probe, plugin sync, MCP init, CLAUDE.md auto-discovery) costs 6+ seconds even on the simplest prompt. `--bare` flag would skip most init but explicitly disables OAuth, so it's API-key-only. The CLI also overlays the user `--system-prompt` on its default coding-assistant prompt, so structured-output instructions are unreliable.
- **Vendoring the hook regressed auto-reply.** The hook now writes the dashboard JSON on every Claude Code event (PreToolUse/PostToolUse/Stop), tailing the same transcript tail each time. Successive writes can carry identical `last_response` with different statuses. The auto-reply duplicate-detection guard, written when `last_response` was rare and only changed at end-of-turn, didn't anticipate this. Cross-module assumption that wasn't explicit.
- **`new URL(req.url, base)` is heavyweight for hot loopback paths.** Allocates a full URL object just to read `pathname` and one query param. For `/recv` (continuous long-poll per spoke), `indexOf('?')` split + locally-constructed `URLSearchParams` is materially cheaper.
- **fusion360-mcp uses port 9876.** Future similar collisions are likely — many local-loopback MCP-style servers gravitate to that port. IANA dynamic range (49152-65535) is the safer default for a configurable tool.
- **Throttle's setTimeout fires dispatch synchronously.** Not awaited inside the timer callback. Means cross-slug dispatches are concurrent automatically — the perf reviewer's "summarize blocks throttle" concern was structurally wrong, but the analysis surfaced the question worth answering.
- **The `--bare` flag is a one-way door for subscription users.** Anyone using OAuth (everyone with Claude Pro/Max) cannot use `--bare`. This is a real constraint on building automation that wraps the CLI.

## Files Modified
- `bin/belfry.js`: wires summarizer, digest, status handler, port move; `maybeSummarize`/`maybeSummarizeBatch` helpers; `digest.flushAll()` awaited on shutdown; `replyTracker.flush()` on shutdown; statusHandler's `recordReply` callback wiring.
- `bin/belfry-mcp.js`: 401 token-rotation actually exits via `await shutdown()`; default `BELFRY_MCP_BASE` now `http://127.0.0.1:49876`; debug log line removed.
- `bin/belfry-hook.js`: `mkdirSync({ mode: 0o700 })`, `writeFileSync({ mode: 0o600 })` for cross-UID isolation.
- `lib/summarizer.js` (new): Anthropic Messages API via raw fetch, LRU cache, fail-open. Both `summarize` and `summarizeBatch` exported.
- `lib/digest.js` (new): per-slug rollup buffer with idle/window flush triggers; `flushAll` awaits in-flight; `clearAll` for shutdown drop semantics.
- `lib/digest-flush.js` (new): extracted digest flush body — factory pattern matching `makeStatusHandler`. Now unit-testable without timers.
- `lib/status-handler.js` (new): `/status` command handler with all-slugs and single-slug paths. `recordReply` callback for tracking single-slug digest message_id. 256 KiB stat-gate on status JSON reads. `truncate` imported from composer.
- `lib/router.js`: `action: 'deliver' | 'status'` discriminator. STATUS_RE reserved command. `hasSlug` callback param replaces `knownSlugs` Set.
- `lib/registry.js`: default port 49876; `hasSlug` method (O(1) Map.has); `readJson` Buffer accumulation; `handle()` indexOf-based path/query split; `handleRecv` takes raw query string.
- `lib/poller.js`: dispatches `action='status'` to `onStatusRequest`; passes `hasSlug` accessor instead of materializing a Set per update.
- `lib/auto-reply.js`: tuple-based duplicate guard; cross-module invariant documented in header.
- `lib/composer.js`: prune dead STATUS_EMOJI; `composeDigest` for #11; `truncate` exported.
- `lib/config.js`: subscription gains `summarize` and `digest` flags; top-level `digestIdleMs` / `digestWindowMs`; `isSummarized` / `isDigested` helpers.
- `lib/reply-tracker.js`: setImmediate-debounced writes; new `flush()` for sync drain on shutdown.
- `lib/watcher.js`: `mkdirSync({ mode: 0o700 })`; 256 KiB stat-gate on JSON reads.
- `lib/slug.js`: explanatory comment about why memoize is intentionally absent.
- `docs/belfry.jsonc.example`: documents `summarize` and `digest` flags + timing knobs.
- `docs/CONVENTION.md`: mandates 0700/0600 perms for participants.
- `CLAUDE.md`: rewrote `waiting` event note (not dead anymore); updated default port reference.
- `README.md`: env var table updated for new default port.
- `/workspace/shared/belfry-launch.sh`: pulls `ANTHROPIC_API_KEY` from secrets-manager (optional).

Tests added: `test/summarizer.test.js` (13), `test/digest.test.js` (10), `test/status-handler.test.js` (15+), `test/digest-flush.test.js` (8), plus extensions to existing tests for auto-reply, composer, config, poller, router, reply-tracker. Net 63 → 170.

## Follow-ups
- [ ] Live-test summarizer + `/status` against a real `ANTHROPIC_API_KEY` once the user adds one to secrets-manager. Until then, features fail-open to truncate / raw view (which is correct, just unenriched).
- [ ] User to restart this Claude Code session — the spoke (pid 7112) still polls the old port 9876 and inbound for this session is wedged. Future sessions will pick up 49876 from the new spoke default automatically.
- [ ] Decide on PR #10 merge timing. PR description was rewritten via REST API to reflect the full branch scope (not just the original v2 hub-and-spoke rewrite).
- [ ] If subscription-auth becomes important, the path forward is a long-running `claude --resume <fixed-uuid> --input-format=stream-json --output-format=stream-json` subprocess pipeline. Substantial complexity vs paying for an API key at Haiku rates (pennies/month for this volume).
