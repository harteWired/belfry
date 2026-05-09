<!-- title: /resume — pick from recent sessions and reattach from the phone -->
## Motivation

Belfry currently assumes the session is already running — there's a Claude Code process, the spoke is registered, the dashboard JSON exists, you can route to it. But sometimes the answer to "what was I doing?" is "I had a session a few hours ago and I want to pick it back up." Today the user has to SSH or open a terminal, find the project, run `claude --resume`, and pick from the list — none of which is fun on a phone.

A `/resume` command from Telegram would let the user list and reattach to recent sessions without leaving the chat. Pick a slug + session id, and the daemon spawns the right `claude --resume <session-uuid>` in the right cwd; the spoke registers itself a moment later and the chat can drive it.

## Shape

### Listing recent sessions

Claude Code keeps per-project session metadata at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` — the JSONL transcript files. Each project's session list is the contents of that directory, sortable by mtime.

A new reserved command:

```
/resume                      → list recent sessions across all projects
/resume <slug>               → list recent sessions for that slug
```

Output format (3 lines per session, mobile-friendly):

```
🔹 belfry — 2 hours ago
   "act on the /review findings"
   /resume belfry b2a7f1...

🔸 obsidian-vault — yesterday
   "indexing the inbox folder"
   /resume obsidian-vault 3f9c4e...
```

Capped at e.g. 5 sessions per slug, 15 total, sorted newest-first. The trailing `/resume <slug> <session-uuid>` is the command to tap-to-copy or quote-reply for resumption.

### Resumption

When the daemon receives `/resume <slug> <session-uuid>`:

1. Resolve the slug → project cwd. The dashboard JSON contains it (`statusFile.cwd` is part of the convention). If the slug isn't currently active, look up cwd from `~/.claude/claude-session-slugs.json` (the slug→path index belfry already reads at startup).
2. Validate the session uuid exists in `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
3. Spawn `claude --resume <session-uuid>` in the cwd. **Open question** below — this needs a TTY. Probably easiest path is via the user's existing terminal-multiplexer of choice, or a small "session launcher" the user installs alongside.
4. Reply on Telegram: `→ resuming belfry [b2a7f1] in <cwd>` — followed up by the spoke's normal `ready` ping when the session boots.

### The TTY problem

Claude Code expects a TTY for interactive sessions. Belfry can't just `child_process.spawn('claude')` and have it work — the user wouldn't see anything, and Claude Code might error on the missing TTY anyway.

Three workable shapes:

**A. tmux integration (opt-in).** If the user has tmux configured, `/resume` runs `tmux new-window -d -t <session-name> 'cd <cwd> && claude --resume <uuid>'`. Adds tmux as a soft dep but doesn't require it for the rest of belfry — only `/resume` needs it. Most likely path.

**B. systemd-run / launchd service.** Spawn the session as a transient service unit; spoke registers itself, user attaches later via `tmux attach` or by opening their terminal app. Niche.

**C. Don't spawn — emit instructions.** Reply with a copyable command line (`tmux new-window -d 'cd /path && claude --resume xyz'`) for the user to run when they're back at a desk. Loses the magic but adds zero infrastructure. Probably the v1 fallback when no spawner is configured.

A `BELFRY_RESUME_LAUNCHER` env var picks the strategy, defaulting to (C). When set to `tmux`, use (A); when set to a path, exec it as a subprocess with the resume command line passed via env.

## Inspiration

[six-ddc/ccbot](https://github.com/six-ddc/ccbot) (MIT) does session resumption via tmux — they spawn a new window per session. Their `/list` and `/switch` commands are a good reference for the listing UX, though their model is "always tmux, always one window per session" which is too prescriptive for belfry's "stay out of the user's terminal" stance.

## Open questions

- **Slug → cwd resolution when no active session exists.** Slug derivation reads from `~/.claude/claude-session-slugs.json` at startup; that map is built from previous live sessions and may not include slugs the user typed manually. Worth confirming the index covers the common cases.
- **Concurrent resumes of the same session.** `claude --resume <uuid>` against an already-attached uuid is undefined. We probably need to detect the case (the dashboard JSON or registered spoke has the session uuid) and reply "already attached" instead of spawning a duplicate.
- **JSONL transcript reading.** Pulling the *last user prompt* out of a transcript file to render in the listing requires parsing JSONL — easy but adds another file format the daemon understands. Cap the read at e.g. 256 KiB from the tail to bound cost.

## Non-goals

- Not a session manager. Belfry doesn't track which uuids belong to which slug or remember per-session state — Claude Code already does that.
- Not auto-resume. Resumption is always user-initiated.
- Not a tmux dependency for belfry overall. tmux is one of the three resume strategies, and explicitly opt-in.
- Not for *creating* new sessions, only resuming. New sessions need a project context and a CLAUDE.md and decisions about cwd that don't belong over Telegram.
