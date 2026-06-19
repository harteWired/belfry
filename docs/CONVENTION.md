# `/tmp/claude-dashboard/` — local-machine convention

This document describes a small filesystem convention used by tools that observe Claude Code session state on a single machine. **No project owns this convention.** Tools choose to read or write it; if multiple tools both write it, they coordinate at install time so only one writes per project (see "Coordination" below).

belfry reads and writes this convention. claudelike-bar reads and writes this convention. Either can be installed without the other.

## Files

### `/tmp/claude-dashboard/<slug>.json` — session status

One JSON file per active Claude Code session, keyed by slug (see "Slug derivation"). Atomic write expected (`write tmp + rename` is fine; partial-read tolerance is the reader's responsibility, but writers should not write a half-formed file).

| field | type | required | meaning |
|---|---|---|---|
| `status` | string | yes | One of `ready`, `working`, `waiting`, `error`, `idle`, `offline`, `done`. New values may be added; readers should tolerate unknown values. |
| `event` | string | no | Event identifier that produced this write (e.g. `Stop`, `Notification`). |
| `statusLabel` | string | no | Human-readable status label (e.g. `"Working (3 agents)"`). When present, readers should prefer this over `status` for display. |
| `displayName` | string | no | Human-readable project name. Falls back to `slug`. |
| `last_prompt` | string | no | The most recent user prompt for this session. |
| `last_response` | string | no | The most recent assistant response for this session. |
| `ts` | number or string | no | ISO-8601 timestamp or epoch millis of this write. Used for staleness checks. |

Additional fields are permitted; readers should ignore unknown fields. When more than one tool writes the same file (e.g. a hook writes `status`/`last_response` while a statusline writes `context_percent`), writers SHOULD **read-merge-write**: read the existing JSON, overwrite only their own fields (clearing stale ones), and preserve foreign fields rather than clobbering the whole file. Belfry's hook owns `status`, `event`, `ts`, `last_prompt`, `last_response` and preserves everything else.

### `~/.claude/claude-session-slugs.json` — slug index (optional)

Maps absolute project paths to display slugs. Used by tools that need to derive a stable slug from `cwd` when no env override is set.

```json
{
  "/abs/path/to/project-a": "alice",
  "/abs/path/to/project-b": "bob"
}
```

A legacy index at `~/.claude/claudelike-bar-paths.json` exists from earlier claudelike-bar versions. Readers SHOULD read the neutral path first and fall back to the legacy path for backward compatibility.

## Status directory resolution

Writers and readers resolve the status directory with this precedence (Status-File Contract v1 §A):

1. `CLAUDELIKE_STATUS_DIR` env var, if set and non-empty (canonical).
2. `CLAUDE_DASHBOARD_DIR` env var, if set and non-empty (deprecated transition alias).
3. Default: POSIX → the **fixed literal** `/tmp/claude-dashboard`; Windows → `os.tmpdir()/claude-dashboard`.

The POSIX literal is intentionally **not** `os.tmpdir()/claude-dashboard`: Claude Code sets `TMPDIR=/tmp/claude-<uid>` per session, so `os.tmpdir()` would diverge writers from readers. Belfry implements this in `bin/belfry-hook.js` (`resolveStatusDir`) and `lib/watcher.js`, which must stay in lock-step.

## Slug derivation

Resolution order:

1. `CLAUDE_SESSION_SLUG` env var, if set and non-empty.
2. `CLAUDELIKE_BAR_NAME` env var, if set and non-empty (legacy).
3. `~/.claude/claude-session-slugs.json` lookup, **ancestor-walked** by `cwd`.
4. `~/.claude/claudelike-bar-paths.json` lookup, ancestor-walked (legacy).
5. No match → **STRICT** (default): mint no slug and skip the write; **LEGACY** (`CLAUDELIKE_BAR_STRICT` set to a falsy token — `0`/`false`/`off`/`no`): `basename(cwd)`.

**Ancestor-walk** (steps 3–4): normalize the trailing slash, then test `cwd` and each parent directory up to the filesystem root; the first registered ancestor wins. A session opened in a *subdirectory* of a registered project resolves to that project's slug instead of minting a junk slug from the folder name. **STRICT** (step 5) is the junk-slug fix (#40): an unregistered directory writes no status file at all, so subdir/scratch terminals don't accumulate stale entries. Register the project (write the path index) or set `CLAUDELIKE_BAR_STRICT=0` to restore the basename fallback.

Then sanitize: strip newlines, replace path separators and Windows-reserved chars (`:*?"<>|`) with `_`, strip leading/trailing dots. If empty after sanitization → STRICT skips the write; LEGACY uses `unknown`.

## Coordination between writers

When more than one tool wants to write `/tmp/claude-dashboard/<slug>.json` for the same session, they should coordinate at hook-install time, not at runtime:

- Each tool's installer scans `.claude/settings.json` Stop hooks for entries that write the convention.
- If an existing entry is found, skip installation and report which tool already provides the convention.
- If none, install the tool's own hook.

This keeps one writer per project, avoids redundant compute on every Stop event, and avoids races. Coordination cost is paid once at install time.

Recognized writer command names today: `claudelike-bar-hook`, `belfry-hook`. Tools adding new hooks should publish their command name here so installers of other tools can detect them.

## Privacy notes

- The status JSON contains user prompts and assistant responses (often partial code, occasionally pasted secrets, repo paths). On a multi-user host these must not leak across UIDs.
- **Required permissions for participating tools**:
  - `/tmp/claude-dashboard/` directory: `0700` (owner-only).
  - `/tmp/claude-dashboard/<slug>.json` files: `0600` (owner-only).
  - `~/.claude/claude-session-slugs.json` and the legacy `claudelike-bar-paths.json`: `0600`.
- Writers SHOULD pass these modes to `mkdirSync`/`writeFileSync` (or equivalent) explicitly rather than relying on the user's umask. Belfry does this in `bin/belfry-hook.js` and `lib/watcher.js`.
- Readers MUST NOT loosen perms they observe on existing files. If a tool finds the dir at `0755` it's the user's pre-existing setup; tightening retroactively could break other tools they rely on.

## Versioning

Fields are additive. Removals or semantic changes to existing fields require coordination across known consumers. There is no version field today; if one is added in future, omitting it must mean "version 1" so existing files keep parsing.
