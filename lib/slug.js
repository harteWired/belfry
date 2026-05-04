/**
 * Derive the slug for a Claude Code session.
 *
 * Implements the slug-derivation rules in docs/CONVENTION.md. The neutral
 * `~/.claude/claude-session-slugs.json` path and the `CLAUDE_SESSION_SLUG`
 * env var are read first; the legacy claudelike-bar paths are read as
 * fallbacks for backward compatibility.
 *
 * Order of resolution:
 *   1. CLAUDE_SESSION_SLUG env var (neutral, primary)
 *   2. CLAUDELIKE_BAR_NAME env var (legacy)
 *   3. ~/.claude/claude-session-slugs.json index lookup by cwd
 *   4. ~/.claude/claudelike-bar-paths.json index lookup by cwd (legacy)
 *   5. basename(cwd) fallback
 *
 * Then sanitize: strip newlines, replace path-separators and Windows-
 * reserved chars with `_`, strip leading/trailing dots. Empty result
 * becomes 'unknown'.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

function lookupIndex(indexPath, cwd) {
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (index && typeof index === 'object') {
      const normalizedCwd = cwd.replace(/[/\\]+$/, '') || cwd;
      const hit = index[normalizedCwd] || index[cwd];
      if (typeof hit === 'string' && hit.length > 0) return hit;
    }
  } catch {
    // ENOENT or parse error — fall through.
  }
  return '';
}

export function deriveSlug({ cwd, env = process.env, homeDir = os.homedir() } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) cwd = process.cwd();

  let project = (env.CLAUDE_SESSION_SLUG || '').trim();
  if (!project) project = (env.CLAUDELIKE_BAR_NAME || '').trim();
  if (!project) project = lookupIndex(path.join(homeDir, '.claude', 'claude-session-slugs.json'), cwd);
  if (!project) project = lookupIndex(path.join(homeDir, '.claude', 'claudelike-bar-paths.json'), cwd);
  if (!project) project = path.basename(cwd);

  project = project
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
  if (!project) project = 'unknown';
  return project;
}
