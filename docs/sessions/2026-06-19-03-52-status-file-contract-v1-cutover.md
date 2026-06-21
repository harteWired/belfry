---
date: 2026-06-19
project: belfry
type: session-log
---

# 2026-06-19 — Status-File Contract v1 gate (#40): built, deployed, mid-cutover with claudelike-bar

## Quick Reference
**Keywords:** belfry, Status-File Contract v1, #40 dashboard-junk cleanup, ancestor-walk, STRICT skip, CLAUDELIKE_BAR_STRICT, CLAUDELIKE_STATUS_DIR, read-merge-write, foreign-field preservation context_percent, resolveSlug, resolveStatusDir, deriveSlug legacy wrapper, lib/slug.js, bin/belfry-hook.js, lib/watcher.js lock-step, PR #46, feat/telegram-federated-dm, 57 tests green, AskUserQuestion not reaching Telegram, agent-to-agent send_to coordination, claudelike-bar cutover, computer-use #44 repo-state, PR #45 close, main stale fork v0.3.0, #35 #37 parallel commits, junk slug, basename fallback, Jinn deploy working-tree, daemon no-restart, gate green handshake
**Project:** belfry
**Outcome:** Built + tested (57 green) + merged (PR #46) + deployed-live-on-Jinn belfry's half of the Status-File Contract v1 cutover (#40): ancestor-walk + STRICT no-match gate + CLAUDELIKE_STATUS_DIR precedence + read-merge-write. Coordinated the live cross-tool cutover with the claudelike-bar peer agent (it flipped its side); reconciled local↔GitHub; and corrected two false premises from the computer-use peer about #44 repo state. Cutover is one VS Code window-reload away from the final joint verify + junk sweep.

## What Was Done
- **Answered "why AskUserQuestion Q/A form doesn't consistently reach Telegram"**: belfry only pushes on ready/error/waiting state flips; AskUserQuestion is a tool call (→ working, excluded). It surfaces only if a Notification event happens to fire (the inconsistency). Even then, options live in a tool_use block which belfry-hook's extractText deliberately ignores (type:"text" only — confirmed ping-dedup.js:30-32), and the picker is a terminal UI widget with no Telegram representation; AskUserQuestion blocks on local input, not a turn boundary, so the reply spoke can't inject either. No code change — diagnosis only.
- **Built the #40 gate** (branch feat/status-file-contract-v1, commit 4bb5e6e):
  - `lib/slug.js`: ancestor-walk the path index (cwd→parents→root, nearest registered ancestor wins, was exact-key only). New `resolveSlug` returns `{slug,matched,source}` with `slug:null` under STRICT no-match (default-on; `CLAUDELIKE_BAR_STRICT=0`/false/off/no → legacy basename). Legacy `deriveSlug` wrapper (STRICT-off, always a string) kept for belfry-mcp.
  - `bin/belfry-hook.js`: `runHook` skips the write on null slug; `resolveStatusDir` adds `CLAUDELIKE_STATUS_DIR` as first dir precedence (`CLAUDE_DASHBOARD_DIR` = deprecated alias); `writeAtomic` read-merge-writes — clears only OWNED_KEYS (status/event/ts/last_prompt/last_response), preserves foreign fields (context_percent).
  - `lib/watcher.js`: same dir precedence, kept in lock-step.
  - Docs: CONVENTION.md (dir resolution, ancestor-walk+STRICT, foreign-field preservation), CLAUDE.md slug section, dashboard-cleanup-plan.md (belfry implementation status).
  - Tests: +19 across slug + belfry-hook (ancestor-walk, nearest-ancestor, STRICT skip, LEGACY escape tokens, deriveSlug back-compat, resolveStatusDir precedence, read-merge preserve/clear). 57 green across slug/belfry-hook/watcher/install-hook/auto-reply.
- **Reconciled local↔GitHub**: repo-wide `git rev-list --branches --not --remotes=origin` = 1 (only the gate commit). feature/mcp-hub-spoke "ahead 2" was a false alarm (commits already on origin/main); no-upstream branches (chore/preserve-groq-voice, fix/broadcast-meta, main) all 0 unique commits. Pushed the gate → 0 unpushed.
- **Opened PR #46** scoped to base `feat/telegram-federated-dm` (NOT main — main is ~21 commits stale; PR-to-main would drag the whole federation epic into a release). Merged it (merge cd3fd7a). Updated the working tree to the active line.
- **Deployed live on Jinn**: launch script runs `bin/belfry.js` straight from the working tree (no git pull), so the per-subprocess hook gate went live immediately; daemon NOT restarted (CLAUDELIKE_STATUS_DIR unset → watcher already on the literal dir; restart would needlessly drop the reply path mid-cutover). Live-smoke verified all four: STRICT skip (clean env), LEGACY escape, read-merge foreign-field survival, ancestor-walk vs the real ~/.claude index.
- **Coordinated the live cutover with claudelike-bar** (peer agent via send_to): sent "gate green" → "GO" (after Matt's GO). CLB correctly refused destructive ops on a relayed GO and required Matt's direct confirmation. CLB then FLIPPED its side (hook writes literal dir + STRICT, extension 0.20.1+cutover installed), and caught/fixed a cherry-pick hazard (its feature/watch-terminals predated main's retry-trio hook commits — restored from a size-mismatch check so belfry's turn-boundary+flush-race fixes weren't regressed). Pending Matt's VS Code window reload → joint 3-point verify → CLB sweeps ~33 junk slugs (belfry keeps debug.log rotation).
- **Corrected computer-use's #44 repo-state claims** (peer agent): both false — (1) "~10 commits unpushed/at-risk" (actually 0 unpushed; conflated "not on main" with "not pushed"), (2) "live daemon missing #35/#37" (both already on the feature line via parallel commits — send-queue.js + 84a94ec; main's e22e39e/65706eb are the duplicates, the conflict source). Decisions as repo owner: don't rebase onto main (backwards), close PR #45 (base=main = stale-main epic; #44 already landed on the active line), #44 needs a daemon restart I'll own (held until #40 settles), v0.3.0 main-catch-up deferred/Matt-gated. computer-use acknowledged + closed #45.

## Decisions & Trade-offs
| Decision | Rationale |
|----------|-----------|
| STRICT skip default-on, `CLAUDELIKE_BAR_STRICT=0` escape | The junk-slug fix: unregistered subdir terminals mint no status file. Escape hatch preserves the old basename behavior for anyone who needs it. |
| Keep legacy `deriveSlug` (STRICT-off) for belfry-mcp | An attached spoke must always resolve a slug for its session; only the hook (whose job is avoiding junk) should skip. Avoids breaking the existing string-returning caller. |
| read-merge clears OWNED_KEYS then spreads payload | Preserves foreign fields (context_percent) AND clears stale owned fields (a pure-tool ready write mustn't inherit a prior turn's last_response). Replicates old clobber semantics for belfry's fields + adds foreign preservation. |
| PR base = feat/telegram-federated-dm, NOT main | main is 21 commits stale; merging there pulls the whole federation epic (the deferred v0.3.0 decision). Scoped the PR to the single gate commit. |
| No Jinn daemon restart for #40 | Hook is per-subprocess (already live on the branch checkout); watcher change is inert without CLAUDELIKE_STATUS_DIR; restart would drop belfry-mcp reply path + the live coordination channel. |
| Don't pressure CLB's direct-GO requirement | A peer agent refusing destructive ops on the human's machine from a relayed GO is correct security posture, not distrust. Acknowledged + held. |
| Don't rebase the feature line onto main (computer-use) | Backwards — main is the stale fork that already received duplicate #35/#37; rebasing risks reverting the feature line's versions for pure conflict pain. |
| Write the session log directly (not Haiku-delegated) | VS Code reload is imminent and would kill a delegated agent mid-write; direct Write guarantees it lands. |

## Key Learnings
- **Jinn's belfry deploy = the working tree.** `/workspace/shared/belfry-launch.sh` runs `node bin/belfry.js` with no git checkout/pull, so "deployed code" is whatever's checked out at `/workspace/projects/belfry`. The hook (fresh subprocess per event) picks up working-tree changes immediately; only the long-running daemon needs a restart to reload.
- **main is a stale fork, not the trunk.** The real trunk is `feat/telegram-federated-dm` (strictly ahead, +21). #35 (send-queue/429 fix) and #37 (broadcast string-meta) exist on BOTH main and the feature line via PARALLEL commits — that duplication is the merge-conflict source. "Reconcile origin" = catch main UP to the feature line (v0.3.0), not pull from main.
- **"not on origin/main" ≠ "not pushed."** The whole stack is on origin feature branches; repo-wide `git rev-list --branches --not --remotes=origin` is the correct at-risk check (was 0/1).
- **Interactive Jinn sessions export `CLAUDELIKE_BAR_NAME=<slug>`** — so STRICT's no-env branch mainly catches scratch/subdir terminals (exactly the junk case); real sessions always carry a slug. (Caused a misleading first smoke-test result until the ambient env was cleared.)
- **AskUserQuestion is structurally invisible to belfry**: tool-call (not a watched state), options in a tool_use block (parser ignores), terminal-UI widget blocking on local input (not a turn boundary). Would need a dedicated PreToolUse-matched feature + Telegram inline-keyboard composer to surface.
- The `belfry-hook-bad-*/test-*` probe files in /tmp/claude-dashboard are STALE one-time deletes — the current test suite already isolates to a temp dir (CLAUDE_DASHBOARD_DIR set before import), so they do NOT recur. (Corrected an earlier inaccurate note to CLB.)

## Files Modified
- `lib/slug.js`: ancestor-walk lookupIndex; new resolveSlug (STRICT, {slug,matched,source}); deriveSlug → STRICT-off wrapper; sanitizeSlug + strictEnabled helpers.
- `bin/belfry-hook.js`: resolveStatusDir (CLAUDELIKE_STATUS_DIR precedence); runHook STRICT skip; writeAtomic read-merge-write (OWNED_KEYS).
- `lib/watcher.js`: CLAUDELIKE_STATUS_DIR precedence (lock-step).
- `test/slug.test.js`, `test/belfry-hook.test.js`: +19 gate tests.
- `docs/CONVENTION.md`, `CLAUDE.md`, `docs/dashboard-cleanup-plan.md`: documented contract + marked belfry's gate built/landed.
- Git: branch feat/status-file-contract-v1 (4bb5e6e) → PR #46 merged into feat/telegram-federated-dm (cd3fd7a), pushed.

## Follow-ups
- [ ] **#40 finish (waiting on Matt's VS Code window reload):** CLB pings → joint 3-point verify (shared-slug context_percent survives belfry write; pings fire; unregistered dir mints nothing) → CLB sweeps ~33 junk slugs. belfry keeps debug.log rotation.
- [ ] **#44 deploy (belfry owns):** after #40 settles, restart Jinn daemon to load federation-aware deliver → re-register belfry-mcp spokes → ping computer-use → it drives /keeper→e/erebus-master round-trip.
- [ ] **#44 PR #45:** computer-use closing it (base=main stale-main epic). #44 already landed on the active line (caec5ed). Optional isolated review PR: head=caec5ed base=db157e9.
- [ ] **Erebus gate deploy** (hygiene, non-blocking): git pull the gate onto Erebus's clone (own host/tmp).
- [ ] **v0.3.0 release merge** (deferred, Matt-gated): merge feat/telegram-federated-dm → main, resolve duplicate #35/#37 in favor of the feature line; then the deferred Phase D (tag, delete superseded branches).
- [ ] Open #40 follow-ups from prior arc still stand: Phase 2 cross-host inbound forwarding; #42 fast heartbeat; #43 cold-start contention.
