---
date: 2026-05-10
project: belfry
type: session-log
---

# 2026-05-10 — Post-Rebuild Recovery and Format Overhaul

## Quick Reference
**Keywords:** belfry, container rebuild, sops, age, secrets-manager, BELFRY_TOKEN, belfry-mcp, register 401 hot-swap, authToken let, Telegram HTML, parse_mode, blockquote expandable, promptCap 1500, responseCap 2500, oversize-cache, pack.js, PACK_PROMPT_PREFIX, chunk.js paragraph-aware, full command, full-expand action, hasFullStash, sendOutbound packing, MAX_SEND_TEXT_LEN 64KiB, MAX_BODY_BYTES 80KiB, late-bound brain, MCP host no respawn, feature/mcp-hub-spoke, three commits 0e4fa38 379f571 4036390
**Project:** belfry
**Outcome:** Recovered belfry after a container rebuild wiped sops + the age private key (sops binary reinstalled to /usr/local/share/npm-global/bin, age key restored from user's secrets store). Shipped three fixes: (1) belfry-mcp register-401 in-place token hot-swap (so future rebuild gaps self-heal); (2) Telegram HTML formatting with italicized header + expandable prompt blockquote, default caps bumped 200/400 → 1500/2500; (3) daemon-side reply packing via brain (haiku) with paragraph-aware truncate fallback, plus a `full` quote-reply command that retrieves the original chunked across messages.

## What Was Done
- Diagnosed post-rebuild outage: `/workspace/.belfry/belfry.pid` stale, secrets-manager failing with `sops: not found`, age key directory `~/.age` empty (no volume mount in devcontainer.json). User restored the age key via their secrets store; reinstalled `age v1.2.1` + `sops v3.9.4` into `/usr/local/share/npm-global/bin` (user-writable, on PATH) to bypass setup.sh's sudo requirement.
- Diagnosed inbound failure: 8 belfry-mcp processes started before the daemon came up, so `loadToken()` returned null at module init → cached `authToken = null` → every `/register` hit 401 → loop forever. Bug: `register()` never reloaded the token; only `recvLoop` did (and only after register succeeded).
- Empirically confirmed Claude Code's MCP host does NOT respawn stdio plugins on clean exit (killed a belfry-mcp, parent claude did not restart it). The project's existing "exit for respawn" pattern is unreliable.
- Implemented hot-swap-in-place fix: `register()` re-reads token file on 401, updates cached `authToken`, retries. `authToken` changed from const to let. recvLoop's 401 path converted to the same hot-swap (no more `process.exit(0)`). Commit `0e4fa38`.
- Telegram format pass 1: rewrote `compose()` and `composeDigest()` to emit HTML (parse_mode HTML), italic header, expandable `<blockquote>` prompt; bumped default promptCap/responseCap from 200/400 to 1500/2500; HTML-escaped user-supplied substrings. Commit `379f571`.
- User feedback: `<blockquote expandable>` rendered as "show more" tap, looked like truncation. Course-corrected.
- Telegram format pass 2: built daemon-side oversize-reply pipeline. New modules `lib/oversize-cache.js` (bounded insertion-order LRU), `lib/chunk.js` (paragraph-aware splitter), `lib/pack.js` (brain-via-PACK-prompt with truncate fallback). Added PACK call shape to `lib/brain-prompt.js`. `sendOutbound` in `bin/belfry.js` now packs anything over the cap, stashes original keyed by Telegram message_id, appends `↩ Reply "full" to this message for the complete response`. Router gains `full-expand` action (quote-reply + exact-word `full` + stash present); daemon resends the original chunked. Commit `4036390`.
- Raised registry caps: `MAX_SEND_TEXT_LEN` 4096 → 65536 (64 KiB); `MAX_BODY_BYTES` 16 → 80 KiB. Dropped truncation from `bin/belfry-mcp.js` reply tool — daemon owns it now.
- Late-bound `brain` reference in `bin/belfry.js` (let, assigned after BrainSupervisor construction) so `sendOutbound`'s closure can reach the brain without TDZ.
- Restarted daemon three times across the session: pid 42413, then 226984, then 281926, each picking up newer code.
- Updated `~/.claude/belfry.jsonc` to use new 1500/2500 caps (was 200/400).

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| Install sops/age to `/usr/local/share/npm-global/bin` (user-writable, on PATH) instead of `/usr/local/bin` via sudo | secrets-manager/setup.sh assumes sudo, which we don't have passwordless in this devcontainer. Side-effect: not persistent across rebuilds. Acceptable for one-shot recovery; user wanted to look at rebuild-flow fix separately. |
| Hot-swap token in-place on 401 (both register and recvLoop) instead of `process.exit(0)` for respawn | Verified empirically that the MCP host does NOT respawn stdio plugins on clean exit. Keeping the exit-for-respawn path was a dead end on real rebuilds. In-place heal works regardless of host behavior. |
| HTML parse_mode for status pings + digest only; leave brain/help/nick/resume/agent/auto-reply paths as plain text | Status pings have a fixed structure we control; the other paths render free-form Claude or static text. HTML escape there would be ~10 lines per handler. Scope-limited the PR; can revisit if those messages also look bad. |
| Drop `<blockquote expandable>` for plain `<blockquote>` after user feedback | Expandable rendered as "show more" cutoff in Telegram, indistinguishable from truncation. The packing pipeline elsewhere already solves the screen-real-estate problem. |
| Daemon owns packing (not the spoke) | Every reply source (this session's `reply` tool, brain's `reply_to_telegram`, auto-reply) goes through the daemon's `onSend`. Centralizing the packing keeps behavior uniform and lets the daemon access the brain. |
| Brain PACK call → text response with new system-prompt section, no tools | Mirrors SUMMARIZE shape. Brain returns plain compressed text; daemon checks fit and falls back to deterministic truncate on miss. |
| Paragraph-aware truncate fallback (not chunking) for the FIRST message | Chunking N messages on the initial send would N×spam the user's phone. Compress + footer keeps it to one buzz; user opts in to chunks via "full". |
| `full` trigger: quote-reply + exact `full` (case-insensitive, slash-optional) + stash present | Avoids collisions with conversational use of the word. Without a stash (expired/never existed) falls through to normal delivery so the user isn't silently dropped. |
| `OversizeCache` insertion-order LRU, not read-recency LRU | A stash gets one read (the "full" expansion) before being deleted. Promoting on read would just churn the data structure for no benefit. |
| Late-bind `brain` via `let` instead of holder object | Other late-binding in this file (watcher, brainSummarizers) uses the holder pattern; for `brain` the only consumer needing late binding is `sendOutbound`, and `let` + closure is simpler. JS resolves the binding at call time. |
| Raise registry `MAX_SEND_TEXT_LEN` to 64 KiB | A single Opus reply can plausibly hit 10–20 KiB. 64 KiB has headroom; 80-KiB body cap keeps room for JSON wrapper. |
| Update user's `~/.claude/belfry.jsonc` directly with new caps | The new defaults are baked into `lib/config.js` but explicit values in the user's config override them. Without touching it, the user wouldn't see any change — the whole point of the PR. |

## Solutions & Fixes
- **`sops: not found` post-rebuild**: secrets-manager shells out to `sops` for decrypt. The binary lives in container layer (`/usr/local/bin/sops`), not a volume — wiped on rebuild. Reinstalled to `/usr/local/share/npm-global/bin/{age,sops}` (user-writable, on PATH) without sudo.
- **`~/.age/key.txt` missing post-rebuild**: devcontainer.json mounts `/home/node/.claude` and `/home/node/.gemini` as named volumes but NOT `/home/node/.age`. The age private key gets wiped every rebuild. User restored from their secrets store (out-of-band). Without the matching private key the encrypted yaml files under `secrets-manager/secrets/` would have been unrecoverable.
- **Inbound replies dropped with "no instance for slug X"**: 8 belfry-mcp processes outlived the daemon's first lifetime, started with empty token file → `authToken = null` cached → `/register` returned 401 forever. Fix: `register()` reloads token on 401, updates cached value, retries. recvLoop converted to the same pattern.
- **`<blockquote expandable>` looked like truncation**: Telegram renders expandable quotes with a "show more" affordance that reads visually identical to a chopped message. Switched to plain `<blockquote>` always for the prompt slot — user feedback validated.
- **Long replies hard-truncated at 4040 chars in `bin/belfry-mcp.js`**: removed the local truncation entirely. Daemon's `sendOutbound` now packs via brain (5s timeout) with paragraph-aware truncate fallback. Original stashed; user reaches it via `full` quote-reply.
- **TDZ risk on `brain` reference inside `sendOutbound`**: declared `let brain = null` early, assigned after BrainSupervisor construction. Closure resolves at call time, by which point the assignment has happened.
- **`MAX_SEND_TEXT_LEN = 4096` blocked oversized payloads from even reaching the daemon's packer**: raised to 64 KiB. Per-request body cap raised in tandem to 80 KiB.

## Key Learnings
- **Claude Code's MCP host does NOT respawn stdio plugins on clean exit** (verified 2026-05-10). The "exit cleanly so the host respawns us with fresh state" pattern is unreliable. Use in-place state reload (hot-swap) when possible; if you must exit, accept that the spoke is dead until the user manually relaunches their session.
- **Telegram's `<blockquote expandable>` reads as truncation** to most users. The "show more" affordance is below the fold and easy to miss. For "show the user some content with optional context", a plain `<blockquote>` is clearer than the expandable variant; for genuine length problems, pack + provide a recovery command.
- **`~/.age` was never persisted across devcontainer rebuilds** — only `/home/node/.claude` and `/home/node/.gemini` have named volumes. Any tool that stashes secrets under `~/<dotdir>/` needs an explicit mount or a setup.sh hook to restore.
- **`secrets-manager/setup.sh` assumes interactive sudo**. In an unattended devcontainer postattach, it silently fails. The bypass — install binaries to a user-writable PATH dir — works but isn't idempotent across rebuilds.
- **Telegram's per-message cap is 4096, not 4040 or 2048**. The previous 200/400 promptCap/responseCap were leaving ~3500 chars on the floor. With HTML formatting + a packing fallback for true outliers, far larger caps are usable without screen-flooding.
- **Brain's stream-json mode handles a new "PACK" call shape via system-prompt teaching**, no tool calls needed for that path. Reply as plain text, daemon checks budget, fall back to deterministic truncate on miss.
- **Insertion-order Map preserves LRU semantics** for write-once-read-once caches like the oversize stash. No need for a dedicated LRU library.

## Files Modified
- `bin/belfry-mcp.js`: dropped local TELEGRAM_TEXT_CAP truncation in the reply tool; added 401 token hot-swap in `register()`; converted recvLoop's 401 path to hot-swap (not process.exit); `authToken` const → let.
- `bin/belfry.js`: added `let brain = null` late-binding; new `OversizeCache` instance; rewrote `sendOutbound` to pack via brain + stash original + append "Reply 'full'" footer; added `fullExpandHandler` (chunk + multi-send threaded); wired `onFullExpand` and `hasFullStash` into the Poller; set `parseMode: 'HTML'` on the status-ping and digest send paths.
- `lib/composer.js`: complete rewrite for HTML output — italic header, plain text response, blockquote-prompt (expandable initially, simplified later), HTML-escape helper, Telegram-cap-fit guard.
- `lib/config.js`: bumped DEFAULT_PROMPT_CAP 200 → 1500, DEFAULT_RESPONSE_CAP 400 → 2500.
- `lib/telegram.js`: added optional `parseMode` to `sendMessage` and `editMessageText`.
- `lib/registry.js`: raised MAX_SEND_TEXT_LEN to 64 KiB; raised MAX_BODY_BYTES to 80 KiB.
- `lib/router.js`: added `hasFullStash` callback param; new `full-expand` action when `^full$` + quote-reply + stash present; falls through to deliver otherwise.
- `lib/poller.js`: accepts `onFullExpand` + `hasFullStash`; dispatches the new action.
- `lib/brain-prompt.js`: added PACK call shape to system prompt; exported `PACK_PROMPT_PREFIX(targetChars)` sentinel builder.
- `lib/chunk.js` (NEW): `chunkParagraphAware(text, limit)` — prefers `\n\n` > `\n` > ` ` > hard cut, with second-half-of-window heuristic.
- `lib/oversize-cache.js` (NEW): bounded insertion-order LRU keyed by message_id, holds full pre-pack text.
- `lib/pack.js` (NEW): `packForTelegram(text, {brain, limit, reservedFooterChars, brainTimeoutMs, log})` — tries brain PACK, falls back to truncate.
- `docs/belfry.jsonc.example`: updated default caps + note explaining why larger caps are now safe.
- `/home/node/.claude/belfry.jsonc` (user config, not in repo): promptCap/responseCap bumped to match new defaults.
- `test/composer.test.js`: full rewrite for HTML format assertions + escape + truncation-cap-fit.
- `test/oversize-cache.test.js` (NEW): 5 tests — put/get/delete, LRU eviction, refresh-on-reput, input validation, constructor validation.
- `test/chunk.test.js` (NEW): 6 tests — fits, empty, paragraph break, line/space fallback, hard cut, input validation.
- `test/pack.test.js` (NEW): 7 tests — brain hit, brain over-budget, brain throws, brain not alive, brain timeout, no brain, input validation.
- `test/router.test.js`: 5 new tests for full-expand path (with stash, case-insensitive, slash-optional, no-stash fallthrough, "full me" stays as deliver).
- `test/registry.test.js`: oversize-payload guard updated to 70-KiB sample (was 5000 chars).
- `test/belfry-mcp.test.js`: 1 new test (token hot-swap on 401 → in-place register, no exit); updated huge-text test to assert pass-through instead of local truncation.

## Follow-ups
- [ ] **Stuck belfry-mcp processes still need session restart.** This conversation's pid 19345 + the 7 other long-lived MCPs (api, web-design-pipeline, vscode-enhancement, 3d-printing, claudelike-bar, git-publishing, life-planner) have the pre-fix code in memory. Inbound replies + new packing pipeline don't work for them until `/exit` + relaunch. User said they'd handle this.
- [ ] **Rebuild persistence**: bake sops/age into the Dockerfile, OR add `setup.sh` invocation to `postattach.sh` (with passwordless sudo for the install paths), AND add a volume mount for `/home/node/.age` in `devcontainer.json`. Otherwise every rebuild repeats the same recovery.
- [ ] **HTML format on the other reply paths** (brain reply, /help, /nick, /resume, /status, agent fallback) if the plain-text rendering still feels attenuated. Each needs HTML escaping of any user-derived substring.
- [ ] **Watch the brain PACK call's behavior** in production. The system-prompt instruction is new; haiku's compliance on the "≤N chars" constraint and tool-free response is unverified at scale. Bug-fixable by tightening the prompt or adding a retry with stricter instruction.
- [ ] **OversizeCache 50-entry ceiling** may be tight if user fires many long replies in quick succession. Easy bump if it becomes a problem.
- [ ] **Daemon-side packing for the per-event status pings** that hit composer.js: currently composer truncates with `…[truncated; full text in terminal]` when the composed total exceeds 4096. Could plumb the same brain-pack flow through, but composed pings rarely hit 4096 with the new caps so this is YAGNI for now.
