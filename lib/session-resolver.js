/**
 * Resolve the most-recent Claude Code session UUID for a given cwd.
 *
 * Claude Code stores per-session JSONL transcripts at
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Encoding rule
 * (verified for /workspace/projects/<slug> paths): every `/` and `.` in the
 * absolute cwd is replaced with `-`. So `/workspace/projects/belfry` →
 * `-workspace-projects-belfry`.
 *
 * "Most recent" = highest mtime among `.jsonl` files in that dir. We use the
 * UUID to pass to `claude --resume <id>` so a Telegram reply lands in the
 * same conversation the user was last having.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

export function resolveSession(cwd, { fsImpl = fs, projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const dir = path.join(projectsDir, encodeCwd(cwd));
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch {
    return null;
  }
  let bestId = null;
  let bestMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    let stat;
    try {
      stat = fsImpl.statSync(path.join(dir, entry));
    } catch {
      continue;
    }
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      bestId = entry.slice(0, -'.jsonl'.length);
    }
  }
  return bestId;
}
