/**
 * /resume command handler. Lists recent Claude Code sessions per slug, and
 * for `/resume <slug> <uuid>` emits a copyable launch command (or exec's
 * a user-supplied launcher script if BELFRY_RESUME_LAUNCHER is set).
 *
 * Intentionally lean for v1: belfry doesn't shell out to tmux or know
 * how the user wants to attach. The launch shape is just text the user
 * pastes into their terminal. If they have tmux automation, they wire it
 * up via BELFRY_RESUME_LAUNCHER.
 *
 * Reads JSONL transcripts from ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 * — the standard layout Claude Code uses. cwd encoding replaces `/` with `-`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_PER_SLUG = 5;
const DEFAULT_OVERALL = 15;
const TAIL_BYTES = 256 * 1024; // read up to 256 KiB of each transcript

function encodeCwd(cwd) {
  // Claude Code's project-dir encoding: replace path separators with dashes,
  // leading slash → leading dash. The ~/.claude/projects/ entries on disk
  // confirm the shape (e.g. `-workspace-projects-belfry`).
  return cwd.replace(/\//g, '-');
}

/**
 * Build the slug → cwd map from claudelike-bar-paths.json (path → slug)
 * and claude-session-slugs.json (slug → path or path → slug — the legacy
 * file's keys vary; we tolerate both shapes).
 */
function buildSlugCwdMap({ home = process.env.HOME, fsImpl = fs } = {}) {
  const out = new Map();
  const tryRead = (p) => {
    try { return JSON.parse(fsImpl.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const legacy = tryRead(path.join(home, '.claude', 'claudelike-bar-paths.json'));
  if (legacy && typeof legacy === 'object') {
    for (const [k, v] of Object.entries(legacy)) {
      // legacy file is path → slug
      if (typeof k === 'string' && typeof v === 'string') out.set(v, k);
    }
  }
  const neutral = tryRead(path.join(home, '.claude', 'claude-session-slugs.json'));
  if (neutral && typeof neutral === 'object') {
    for (const [k, v] of Object.entries(neutral)) {
      // neutral file's shape isn't documented; tolerate both directions.
      if (typeof k === 'string' && typeof v === 'string') {
        // If `k` looks like a path (starts with /), it's path → slug.
        if (k.startsWith('/')) out.set(v, k);
        else out.set(k, v);
      }
    }
  }
  return out;
}

/**
 * Pull the most recent user message snippet from a JSONL transcript by
 * reading the file's tail. Best-effort — JSON-parses each line, returns
 * the last entry whose role is 'user'. Returns null on any failure.
 */
function extractLastUserMessage(transcriptPath, { fsImpl = fs, tailBytes = TAIL_BYTES } = {}) {
  try {
    const stat = fsImpl.statSync(transcriptPath);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fsImpl.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fsImpl.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        // Transcript entries have varying shapes across Claude Code versions.
        // We look for any entry with a user-role marker and a textual body.
        if (obj.role === 'user' || obj.message?.role === 'user' || obj.type === 'user') {
          const text = obj.message?.content?.[0]?.text
            ?? obj.message?.content
            ?? obj.text
            ?? obj.content
            ?? null;
          if (typeof text === 'string' && text.length > 0) return text;
        }
      }
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * List recent sessions across all slugs (or just one if filterSlug is set).
 * Returns an array of { slug, uuid, mtimeMs, lastUser } sorted newest first.
 */
export function listRecentSessions({
  filterSlug = null,
  perSlug = DEFAULT_PER_SLUG,
  overall = DEFAULT_OVERALL,
  home = process.env.HOME,
  fsImpl = fs,
  resolveNickname = () => null,
} = {}) {
  const slugToCwd = buildSlugCwdMap({ home, fsImpl });
  const projectsDir = path.join(home, '.claude', 'projects');
  // Don't pre-walk projectsDir — the per-slug readdirSync below already
  // handles the missing-dir case via try/catch and avoids materializing
  // the full project listing on machines with many projects.
  // Resolve filter — accept slug OR nickname.
  let resolvedFilter = filterSlug;
  if (filterSlug) {
    const aliased = resolveNickname(filterSlug);
    if (aliased) resolvedFilter = aliased;
  }

  // For each slug we have a cwd for, see if its encoded dir exists; collect
  // the .jsonl files, snip per-slug, then aggregate. Don't index by encoded
  // dir alone — multiple slugs can share a cwd (e.g. nicknames + actual slug).
  const allSessions = [];
  for (const [slug, cwd] of slugToCwd) {
    if (resolvedFilter && slug !== resolvedFilter) continue;
    const encodedDir = path.join(projectsDir, encodeCwd(cwd));
    let files;
    try {
      files = fsImpl.readdirSync(encodedDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const stats = files.map((f) => {
      const full = path.join(encodedDir, f);
      try {
        return { uuid: f.replace(/\.jsonl$/, ''), full, mtimeMs: fsImpl.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    }).filter(Boolean);
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const s of stats.slice(0, perSlug)) {
      allSessions.push({
        slug,
        cwd,
        uuid: s.uuid,
        mtimeMs: s.mtimeMs,
        lastUser: extractLastUserMessage(s.full, { fsImpl }),
      });
    }
  }
  allSessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return allSessions.slice(0, overall);
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function formatListing(sessions) {
  if (sessions.length === 0) return 'no recent sessions found.';
  const lines = sessions.map((s) => {
    const snippet = s.lastUser ? `\n   "${s.lastUser.slice(0, 80).replace(/\s+/g, ' ')}"` : '';
    const cmd = `\n   /resume ${s.slug} ${s.uuid.slice(0, 8)}`;
    return `${s.slug} — ${relativeTime(s.mtimeMs)}${snippet}${cmd}`;
  });
  return lines.join('\n\n');
}

/**
 * Resolve a uuid prefix (e.g. first 8 chars) to the full uuid for a slug.
 * Returns null on no match or ambiguous match.
 */
function resolveUuid(slug, uuidPrefix, sessions) {
  const candidates = sessions.filter((s) => s.slug === slug && s.uuid.startsWith(uuidPrefix));
  if (candidates.length !== 1) return null;
  return candidates[0];
}

export function makeResumeHandler({
  send,
  resolveNickname = () => null,
  launcherCmd = null, // BELFRY_RESUME_LAUNCHER env value, or null to emit copyable text
  log = () => {},
  spawnImpl = spawn,
  listRecent = listRecentSessions,
} = {}) {
  return async (action) => {
    try {
      const sessions = listRecent({ resolveNickname });
      // /resume — list everything
      if (!action.slug) {
        await send({ text: formatListing(sessions), replyToMessageId: action.messageId });
        return;
      }
      // /resume <slug> — list for one slug (slug arg may be a nickname)
      if (!action.uuid) {
        const slug = resolveNickname(action.slug) ?? action.slug;
        const filtered = sessions.filter((s) => s.slug === slug);
        if (filtered.length === 0) {
          await send({ text: `no recent sessions for '${slug}'.`, replyToMessageId: action.messageId });
          return;
        }
        await send({ text: formatListing(filtered), replyToMessageId: action.messageId });
        return;
      }
      // /resume <slug> <uuid-prefix>
      const slug = resolveNickname(action.slug) ?? action.slug;
      const match = resolveUuid(slug, action.uuid, sessions);
      if (!match) {
        await send({
          text: `couldn't resolve '${action.slug} ${action.uuid}'. Use /resume ${slug} to list candidates.`,
          replyToMessageId: action.messageId,
        });
        return;
      }
      // Single-quote-escape cwd so paths with spaces or shell metacharacters
      // ("/Users/me/My Project") produce a usable copyable command.
      const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
      const cmd = `cd ${shellQuote(match.cwd)} && claude --resume ${match.uuid}`;
      if (launcherCmd) {
        // Exec the user's launcher with the command in env. Detached + ignore
        // io so it survives the daemon (the launcher is presumably a
        // long-lived process, e.g. `tmux new-window`).
        try {
          const child = spawnImpl(launcherCmd, [], {
            shell: true,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, BELFRY_RESUME_CMD: cmd, BELFRY_RESUME_CWD: match.cwd, BELFRY_RESUME_UUID: match.uuid, BELFRY_RESUME_SLUG: slug },
          });
          child.unref();
          await send({ text: `→ launching ${slug} [${match.uuid.slice(0, 8)}] via $BELFRY_RESUME_LAUNCHER`, replyToMessageId: action.messageId });
          log(`resume: spawned launcher for ${slug}/${match.uuid}`);
          return;
        } catch (err) {
          log(`resume: launcher spawn failed: ${err.message}`);
          // fall through to copyable-command path
        }
      }
      await send({
        text: `Run this in your terminal to attach:\n\n${cmd}`,
        replyToMessageId: action.messageId,
      });
      log(`resume: emitted launch command for ${slug}/${match.uuid}`);
    } catch (err) {
      log(`resume handler error: ${err.message}`);
    }
  };
}
