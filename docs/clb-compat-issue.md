# Issue draft for harteWired/claudelike-bar

To file once `gh auth login` is set up, or paste the body manually into the GitHub UI.

---

**Title:** Compatibility: align with belfry on the shared `/tmp/claude-dashboard/` convention

**Body:**

belfry (https://github.com/aes87/belfry — Telegram bridge for Claude Code) and claudelike-bar both read and write `/tmp/claude-dashboard/<slug>.json` on the same machine, and both derive a slug from `(env → path index → cwd basename)`. Today belfry's slug derivation mirrors claudelike-bar's exactly so the two agree; that's coincidental rather than designed.

Proposal: treat the JSON shape and the slug-derivation rules as a **shared local-machine convention** that neither project owns. Both projects would describe themselves symmetrically as "uses the `/tmp/claude-dashboard/` convention," with no add-on/host hierarchy in either README. belfry will publish a `CONVENTION.md` describing what it reads and writes; the ask here is for claudelike-bar to adopt the same convention so a user can run either, both, or neither without coordination.

Three concrete asks:

1. **Adopt a neutral slug-index path.** Today claudelike-bar writes `~/.claude/claudelike-bar-paths.json`. belfry will start reading a neutral `~/.claude/claude-session-slugs.json` first, with the legacy path as a fallback. Suggest claudelike-bar do the same: write the neutral path going forward, keep reading the legacy path for backward compat, drop the legacy after a release or two. Same for the `CLAUDELIKE_BAR_NAME` env var — belfry will read `CLAUDE_SESSION_SLUG` first, then `CLAUDELIKE_BAR_NAME`.

2. **Install-time hook detection (no duplicate writers).** When both tools are installed in the same project, only one Stop hook should write the JSON. Each project's hook installer should scan `.claude/settings.json` for an existing entry that writes the convention (recognizable command name in a known list — `claudelike-bar-hook`, `belfry-hook`, etc.) and skip installing if one is found. Coordination at install time, no runtime detection needed. belfry's vendored hook will do this; suggest claudelike-bar do the same when its installer next changes.

3. **Populate `last_response` consistently.** belfry's composer reads `last_response` for the "Claude: …" line in Telegram pings. CLB v0.18.1+ documented support for it but the version installed in our test env is v0.17.0 and live JSONs only carry `last_prompt`. If claudelike-bar already populates this in current versions, ignore — otherwise treating it as part of the shared shape would close the gap.

This is purely additive: existing claudelike-bar users see no change unless they add belfry, and vice versa. Once both sides land items 1–2, the integration story for users with both installed is "they detect each other at install time and pick one writer." No runtime coordination, no duplicated compute on Stop events, no project framed as add-on to the other.

Cross-ref: belfry tracks the corresponding work at <link to belfry PR/issue once landed>.
