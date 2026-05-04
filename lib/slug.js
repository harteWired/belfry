/**
 * Derive the claudelike-bar slug for a session.
 *
 * Mirrors the logic in claudelike-bar's hooks/dashboard-status.js so the
 * slug belfry-mcp registers under matches the slug the daemon's watcher
 * sees on /tmp/claude-dashboard/<slug>.json. Both must agree, or routed
 * Telegram replies will never reach the right session — the daemon's
 * registry indexes spokes by slug.
 *
 * Order of resolution:
 *   1. CLAUDELIKE_BAR_NAME env var (set by auto-started terminals)
 *   2. ~/.claude/claudelike-bar-paths.json index lookup by cwd
 *   3. basename(cwd) fallback
 *
 * Then sanitize: strip newlines, replace path-separators and Windows-
 * reserved chars with `_`, strip leading/trailing dots. Empty result
 * becomes 'unknown'.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export function deriveSlug({ cwd, env = process.env, homeDir = os.homedir() } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) cwd = process.cwd();

  let project = (env.CLAUDELIKE_BAR_NAME || '').trim();
  if (!project) {
    try {
      const indexPath = path.join(homeDir, '.claude', 'claudelike-bar-paths.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (index && typeof index === 'object') {
        const normalizedCwd = cwd.replace(/[/\\]+$/, '') || cwd;
        project = index[normalizedCwd] || index[cwd] || '';
      }
    } catch {
      // No index or unreadable — fall through to basename.
    }
  }
  if (!project) project = path.basename(cwd);

  project = project
    .replace(/[\r\n]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '');
  if (!project) project = 'unknown';
  return project;
}
