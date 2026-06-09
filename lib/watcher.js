import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chokidar from 'chokidar';

// The convention path is the LITERAL /tmp/claude-dashboard (docs/CONVENTION.md),
// NOT os.tmpdir()/claude-dashboard. Claude Code sets TMPDIR=/tmp/claude-<uid> for
// sessions, so os.tmpdir() silently diverges the daemon's watched dir from where
// the hooks + claudelike-bar actually write — the daemon ends up watching a
// near-empty dir and never sees most sessions' status. Pin to the convention on
// POSIX (honor a CLAUDE_DASHBOARD_DIR override); fall back to os.tmpdir() on
// Windows, where /tmp doesn't exist.
const STATUS_DIR = (process.env.CLAUDE_DASHBOARD_DIR || '').trim()
  || (process.platform === 'win32' ? path.join(os.tmpdir(), 'claude-dashboard') : '/tmp/claude-dashboard');

/**
 * Watch /tmp/claude-dashboard/*.json. Emits one notification per status-file
 * write. The caller is responsible for filtering (subscription, transition
 * detection, throttle).
 *
 * Slug is derived from the filename (basename minus .json).
 *
 * Emitted shape: { slug, statusFile, prevStatusFile }
 *  - prevStatusFile is the previously-observed payload for this slug, used
 *    by the caller to detect transitions. null on first observation.
 */
export class StatusWatcher {
  constructor({ onUpdate, log = () => {}, statusDir = STATUS_DIR } = {}) {
    this.onUpdate = onUpdate;
    this.log = log;
    this.statusDir = statusDir;
    /** slug → previous statusFile payload */
    this.lastSeen = new Map();
    this.watcher = null;
  }

  start() {
    if (!fs.existsSync(this.statusDir)) {
      // Match belfry-hook's writeAtomic: 0700 so prompt/response payloads
      // aren't readable by other UIDs on a shared host. If the dir already
      // exists with looser perms (older claudelike-bar / older belfry),
      // we don't tighten retroactively — that's the user's choice.
      fs.mkdirSync(this.statusDir, { recursive: true, mode: 0o700 });
    } else {
      // Pre-existing dir from an older writer may be 0755. Warn once at
      // startup so the user knows last_prompt/last_response is readable to
      // other UIDs on this host. We don't auto-chmod — the contract above
      // says we leave existing perms alone.
      try {
        const mode = fs.statSync(this.statusDir).mode & 0o777;
        if (mode & 0o077) {
          this.log(`warning: ${this.statusDir} mode is 0${mode.toString(8)} (wider than 0700) — last_prompt/last_response readable by other UIDs. chmod 700 to tighten.`);
        }
      } catch {
        // stat failed; not worth blocking startup.
      }
    }
    this.watcher = chokidar.watch(this.statusDir, {
      ignored: (p, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        return !p.endsWith('.json');
      },
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    this.watcher.on('add', (p) => this.handle(p));
    this.watcher.on('change', (p) => this.handle(p));
    this.log(`watching ${this.statusDir}`);
    this.seedCache();
  }

  /**
   * Prime `lastSeen` from the dashboard dir at startup. chokidar 4's
   * `awaitWriteFinish` suppresses the initial 'add' events for pre-existing
   * *static* files (only files written AFTER the watch starts emit events), so
   * without this the in-memory cache contains only the handful of sessions that
   * happen to change after the daemon boots — leaving `getActiveSlugsFromCache()`
   * (and thus the brain's `list_sessions`/`getSession` and the agent handler's
   * routing context) blind to every idle session. Seeding reads each file once
   * into `lastSeen` WITHOUT firing `onUpdate`, so the cache is complete from boot
   * and transition detection gets a correct baseline (a pre-existing state is not
   * a new event → no spurious startup pings). A change event that beats the seed
   * wins (we never overwrite a fresher payload with stale disk data).
   */
  seedCache() {
    let entries;
    try {
      entries = fs.readdirSync(this.statusDir);
    } catch {
      return;
    }
    let seeded = 0;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const slug = name.slice(0, -'.json'.length);
      if (this.lastSeen.has(slug)) continue; // a chokidar change event already cached it
      const full = path.join(this.statusDir, name);
      try {
        if (fs.statSync(full).size > 256 * 1024) continue;
        this.lastSeen.set(slug, JSON.parse(fs.readFileSync(full, 'utf8')));
        seeded++;
      } catch {
        // malformed / mid-write — skip; chokidar will pick it up on the next write
      }
    }
    if (seeded > 0) this.log(`seeded ${seeded} slug(s) into the status cache at startup`);
  }

  handle(filePath) {
    const slug = path.basename(filePath, '.json');
    let statusFile;
    try {
      // Cap to 256 KiB. Status JSONs are a few KB by spec — a larger file is
      // either malformed or an attempt to balloon daemon memory on the hot
      // path. Drop and log; chokidar will re-fire on the next legitimate write.
      const stat = fs.statSync(filePath);
      if (stat.size > 256 * 1024) {
        this.log(`oversized status file ${slug}: ${stat.size} bytes — dropping`);
        return;
      }
      statusFile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      this.log(`parse error ${slug}: ${err.message}`);
      return;
    }
    const prev = this.lastSeen.get(slug) ?? null;
    this.lastSeen.set(slug, statusFile);
    try {
      this.onUpdate({ slug, statusFile, prevStatusFile: prev });
    } catch (err) {
      this.log(`onUpdate threw for ${slug}: ${err.message}`);
    }
  }

  /**
   * Snapshot of slugs currently present in the dashboard. Reads the dir
   * directly rather than returning `lastSeen.keys()` so the answer reflects
   * the on-disk state even before chokidar has fired its initial 'add'
   * events for each file. Used by the nickname registry to validate that
   * a slug exists before binding a nickname to it (cold path — once per
   * /nick command). Hot-path callers should use getActiveSlugsFromCache()
   * to avoid the synchronous readdir.
   */
  getActiveSlugs() {
    const out = new Set();
    let entries;
    try {
      entries = fs.readdirSync(this.statusDir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      out.add(name.slice(0, -'.json'.length));
    }
    return out;
  }

  /**
   * In-memory snapshot of slugs the watcher has observed. O(1) per call,
   * no filesystem access. Used on the hot Telegram path (agent handler
   * runs this on every unmatched message). May lag the on-disk state by
   * one chokidar event during startup; for the agent's "list active
   * sessions" use case that's fine.
   */
  getActiveSlugsFromCache() {
    return new Set(this.lastSeen.keys());
  }

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
