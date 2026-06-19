/**
 * Derive the slug for a Claude Code session.
 *
 * Implements the slug-derivation rules in docs/CONVENTION.md and the
 * Status-File Contract v1 (docs/dashboard-cleanup-plan.md, #40):
 * an ancestor-walked path-index lookup plus a STRICT no-match gate that
 * skips minting a junk basename slug for unregistered directories.
 *
 * Order of resolution:
 *   1. CLAUDE_SESSION_SLUG env var (neutral, primary)
 *   2. CLAUDELIKE_BAR_NAME env var (legacy)
 *   3. ~/.claude/claude-session-slugs.json index, ANCESTOR-WALKED by cwd
 *   4. ~/.claude/claudelike-bar-paths.json index, ancestor-walked (legacy)
 *   5. NO MATCH → STRICT (default): no slug, caller skips the write;
 *      LEGACY (CLAUDELIKE_BAR_STRICT=0): basename(cwd)
 *
 * Then sanitize: strip newlines, replace path-separators and Windows-
 * reserved chars with `_`, strip leading/trailing dots. Empty after
 * sanitize → STRICT: no slug; LEGACY: 'unknown'.
 *
 * `resolveSlug` is the contract-faithful entry point (returns
 * `{ slug, matched, source }`, slug `null` when STRICT declines). The
 * older `deriveSlug` wrapper preserves the always-returns-a-string
 * behavior for callers that must have a slug regardless of registration.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// No in-process memoize: every current caller invokes resolveSlug at most once
// per process lifetime (belfry-mcp at startup, belfry-hook per hook firing
// which is itself a fresh subprocess). The OS page cache absorbs repeat reads
// on the same process anyway. Add memoization only if a future caller starts
// invoking it in a tight loop.

/**
 * Look up `cwd` (and each ancestor) in a `{ "<abs path>": "<slug>" }` index
 * file. Returns the first registered ancestor's slug, or '' on no match /
 * missing / malformed file.
 */
function lookupIndex(indexPath, cwd) {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return ''; // ENOENT or parse error — treat as no match.
  }
  if (!index || typeof index !== 'object') return '';
  // Ancestor-walk (Contract v1 §B): normalize the trailing slash, then test
  // cwd and each parent up to the filesystem root. First registered ancestor
  // wins, so a session in a SUBDIRECTORY of a registered project resolves to
  // that project's slug instead of minting a junk basename slug from the
  // folder name (itineraries, docs, 0-inbox, …).
  let dir = cwd.replace(/[/\\]+$/, '') || cwd;
  let prev = null;
  while (dir && dir !== prev) {
    const hit = index[dir];
    if (typeof hit === 'string' && hit.length > 0) return hit;
    prev = dir;
    dir = path.dirname(dir);
  }
  return '';
}

// Sanitize a candidate slug (Contract v1 §C). Byte-identical to the
// claudelike-bar hook so both writers produce the same filename.
function sanitizeSlug(name) {
  return String(name)
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
}

// STRICT is default-on; CLAUDELIKE_BAR_STRICT set to a falsy token disables it
// (legacy basename fallback). Mirrors the falsy-token convention the daemon's
// BELFRY_* boolean env vars use.
function strictEnabled(env) {
  const raw = (env.CLAUDELIKE_BAR_STRICT ?? '').toString().trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * Resolve the slug for a session.
 *
 * @returns {{ slug: string|null, matched: boolean, source: string }}
 *   `slug` is null only under STRICT when nothing identified the session
 *   (no env, no registered ancestor) or the candidate sanitized to empty.
 *   `matched` is true when an env var or the index identified it (i.e. NOT a
 *   basename fallback). `source` names where the slug came from.
 */
export function resolveSlug({ cwd, env = process.env, homeDir = os.homedir(), strict } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) cwd = process.cwd();
  if (strict === undefined) strict = strictEnabled(env);

  let project = (env.CLAUDE_SESSION_SLUG || '').trim();
  let source = project ? 'env:CLAUDE_SESSION_SLUG' : '';
  if (!project) {
    project = (env.CLAUDELIKE_BAR_NAME || '').trim();
    if (project) source = 'env:CLAUDELIKE_BAR_NAME';
  }
  if (!project) {
    project = lookupIndex(path.join(homeDir, '.claude', 'claude-session-slugs.json'), cwd);
    if (project) source = 'index:claude-session-slugs';
  }
  if (!project) {
    project = lookupIndex(path.join(homeDir, '.claude', 'claudelike-bar-paths.json'), cwd);
    if (project) source = 'index:claudelike-bar-paths';
  }

  const matched = !!project;
  if (!project) {
    // NO MATCH (Contract v1 §B): STRICT declines, LEGACY uses basename.
    if (strict) return { slug: null, matched: false, source: 'none' };
    project = path.basename(cwd);
    source = 'basename';
  }

  const slug = sanitizeSlug(project);
  if (!slug) {
    // Empty after sanitize (Contract v1 §C): STRICT skips, LEGACY → 'unknown'.
    return strict
      ? { slug: null, matched, source }
      : { slug: 'unknown', matched, source };
  }
  return { slug, matched, source };
}

/**
 * Legacy string-returning entry point. Always resolves to a slug (basename
 * fallback, 'unknown' on empty) by forcing STRICT off — for callers that
 * must have a slug regardless of registration (e.g. belfry-mcp registering
 * an active session it was explicitly attached to). The STRICT no-match
 * gate is for the hook, whose job is to AVOID minting junk slugs for
 * unregistered directories.
 */
export function deriveSlug(opts = {}) {
  return resolveSlug({ ...opts, strict: false }).slug;
}
