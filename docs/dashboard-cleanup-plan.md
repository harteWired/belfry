# Dashboard junk cleanup — plan + Status-File Contract v1

> **Status:** APPROVED (Matt, 2026-06-09) — implementation delegated to the projects to
> coordinate ("gossip") via the agent mesh. This file is belfry's durable record so the
> plan + contract are restorable. The de-dup was sorted peer-to-peer: the **canonical hook
> home is `claudelike-bar/hooks/`** (the published extension; its VSIX bundles
> `dashboard-status.js` and `src/setup.ts` installs it — `claude-terminal-dashboard` was a
> stale snapshot, retired). The **canonical contract home is
> `claudelike-bar/docs/STATUS-FILE-CONTRACT.md`** (it follows the hook). Tracks issue **#40**.

## Problem
The `/tmp/claude-dashboard/<slug>.json` convention accumulated ~61 entries, ~33 junk.
Root cause: the dashboard slug falls back to `basename(cwd)` whenever a session's cwd
isn't an **exact** key in the shared project index `~/.claude/claudelike-bar-paths.json`.
Sessions in a **subdirectory** of a project (or any unregistered dir) mint a junk slug
from the folder name (`itineraries`, `0-inbox`, `cache`, `docs`, …). Compounded by:
no GC of stale files, a config-list bloat in `claudelike-bar.jsonc`, a 10MB `debug.log`,
and the dashboard hook being **duplicated + drifted** across two repos.

A related belfry bug (already fixed, commit `1950328`): the daemon used
`os.tmpdir()/claude-dashboard`, which diverges from the convention literal when
`TMPDIR` is set per-process (Claude Code sets `TMPDIR=/tmp/claude-<uid>`) — so the daemon
watched a near-empty `/tmp/claude-1000/claude-dashboard` while sessions wrote
`/tmp/claude-dashboard`, breaking pings for most projects.

## The fixes (7 items) + ownership
| # | Fix | Owner |
|---|---|---|
| A | **Ancestor-walk** the index: from cwd, walk up to the nearest registered project root (stop at `/workspace`) → subdir terminals resolve to their real project. | vscode-enhancement authors the hook → claudelike-bar commits it; belfry (`lib/slug.js`/belfry-hook) |
| B | **Skip on no-match** (STRICT): no env + no ancestor → write no file. Flag-gated, default-on, legacy escape hatch. | same |
| C | **Stale GC**: drop `*.json` older than N days AND not tracked AND not in index/config (conservative); sweep `.tmp.<pid>`; never reap pinned/autoStart/path-bearing. | claudelike-bar |
| D | **Config-list hygiene**: stop `ensureEntry` persisting transient terminal names. | claudelike-bar |
| E | **Unify the dir/slug/sanitize CONTRACT** (below) — one spec, three implementations. | claudelike-bar lands the spec; belfry + the hook conform |
| F | **De-dup the hook** — canonical home is **`claudelike-bar/hooks/`** (published-extension source of truth); retire the stale `claude-terminal-dashboard` snapshot. **Resolved P2P.** | vscode-enhancement *authors* the reconciled hook → claudelike-bar *commits* it |
| G | **One-time cleanup** — sweep 33 junk + stale + 10MB `debug.log` [CLB]; remove the 4 `belfry-hook-test/bad-*` files + ensure belfry sessions set `CLAUDELIKE_BAR_NAME` [belfry]. | split |

**Constraints:** layout-agnostic gate (env-or-index, NOT hardcoded `/workspace/projects`);
never nuke real configured terminals (`Vault Direct`, `Shell` are pinned/autoStart).

## Decisions (Matt, 2026-06-09)
1. Canonical env var → **`CLAUDELIKE_STATUS_DIR`** (`CLAUDE_DASHBOARD_DIR` = deprecated alias, both honored during transition).
2. STRICT mode → **default ON** (unregistered dirs mint no file; register to opt in).
3. Old-dir migration → **let it age out** via the GC (active sessions re-write to the canonical dir on next event).

## Status-File Contract v1 (drafted by claudelike-bar, frozen)
**A) STATUS DIRECTORY** — `resolveStatusDir()`:
1. `CLAUDELIKE_STATUS_DIR` (non-empty) → use it
2. else `CLAUDE_DASHBOARD_DIR` (non-empty) → use it (transition alias)
3. else default: POSIX → `'/tmp/claude-dashboard'` (FIXED literal — **not** `os.tmpdir()`); Windows → `path.join(os.tmpdir(), 'claude-dashboard')`

The fixed POSIX literal is the whole fix — invariant to per-process `TMPDIR`.

**B) SLUG RESOLUTION** (identical in both hooks):
1. `$CLAUDELIKE_BAR_NAME` (non-empty) → slug
2. else path-index `~/.claude/claudelike-bar-paths.json` (`{"<abs cwd>":"<slug>"}`). **ANCESTOR-WALK**: normalize trailing slash, test cwd then each parent up to root, first hit wins.
3. else NO MATCH → gate: **STRICT** (default) = SKIP the write; **LEGACY** (`CLAUDELIKE_BAR_STRICT=0`) = `basename(cwd)`.

Extension owns WRITING the index (Register Project / wizard); both hooks only READ it.

**C) SANITIZE** (byte-identical, on the resolved slug before `<slug>.json`):
```
s = s.replace(/[\r\n]/g,'')
     .replace(/[\/\\:*?"<>|]/g,'_')
     .replace(/^\.+|\.+$/g,'')
```
STRICT: empty-after-sanitize → SKIP. LEGACY → `'unknown'`.

**D) FILE WRITE** — atomic: write `<dir>/<slug>.json.tmp.<pid>` then rename → `<dir>/<slug>.json`.
Read-merge-write: read existing JSON first, merge your fields, preserve foreign fields
(e.g. `context_percent` from the statusline); always write event-specific fields even when
empty to clobber stale values.

## Rollout order
E (land the spec) → A+B (root fix, all hooks) → F (de-dup) → C+D (hygiene) → G (sweep).
vscode-enhancement drafts the ancestor-walk for review first.

## Belfry implementation status (branch `feat/status-file-contract-v1`)
Belfry's half of the gate is **BUILT + tested** (not yet merged/deployed; the LIVE sweep + dir-converge wait for Matt's GO and a "gate green" ping to claudelike-bar):
- **A ancestor-walk** — `lib/slug.js` `lookupIndex` now walks `cwd` → each parent → root, first registered ancestor wins (was exact-key only).
- **B STRICT skip** — `lib/slug.js` `resolveSlug` returns `slug:null` on no-match (default-on; `CLAUDELIKE_BAR_STRICT=0` → legacy basename). `bin/belfry-hook.js` `runHook` skips the write when slug is null. Legacy `deriveSlug` wrapper (STRICT-off) preserved for `belfry-mcp`.
- **A-dir (§A) `CLAUDELIKE_STATUS_DIR` precedence** — `resolveStatusDir` in `bin/belfry-hook.js` + lock-step update in `lib/watcher.js`: `CLAUDELIKE_STATUS_DIR` → `CLAUDE_DASHBOARD_DIR` (alias) → POSIX literal.
- **D read-merge-write** — `writeAtomic` reads existing JSON, clears only belfry-owned keys (`status`/`event`/`ts`/`last_prompt`/`last_response`), preserves foreign fields (`context_percent` etc.), then atomic tmp+rename.
- **C sanitize** — already byte-identical (unchanged).
- Tests: `test/slug.test.js` (ancestor-walk, nearest-ancestor, STRICT skip, LEGACY escape tokens, deriveSlug back-compat) + `test/belfry-hook.test.js` (STRICT skip, `resolveStatusDir` precedence, read-merge preserve/clear) — green.
- Belfry's G items: the `belfry-hook-bad-*/test-*` probe files are STALE leftovers (the current test suite already isolates to a temp dir via `CLAUDE_DASHBOARD_DIR`), so they're one-time deletes that do **not** recur. `debug.log` rotation stays belfry's.
