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

Additional fields are permitted; readers should ignore unknown fields.

### `~/.claude/claude-session-slugs.json` — slug index (optional)

Maps absolute project paths to display slugs. Used by tools that need to derive a stable slug from `cwd` when no env override is set.

```json
{
  "/abs/path/to/project-a": "alice",
  "/abs/path/to/project-b": "bob"
}
```

A legacy index at `~/.claude/claudelike-bar-paths.json` exists from earlier claudelike-bar versions. Readers SHOULD read the neutral path first and fall back to the legacy path for backward compatibility.

## Slug derivation

Resolution order:

1. `CLAUDE_SESSION_SLUG` env var, if set and non-empty.
2. `CLAUDELIKE_BAR_NAME` env var, if set and non-empty (legacy).
3. `~/.claude/claude-session-slugs.json` lookup by absolute `cwd`.
4. `~/.claude/claudelike-bar-paths.json` lookup by absolute `cwd` (legacy).
5. `basename(cwd)`.

Then sanitize: strip newlines, replace path separators and Windows-reserved chars (`:*?"<>|`) with `_`, strip leading/trailing dots. If empty after sanitization, use `unknown`.

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
