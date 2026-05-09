import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chokidar from 'chokidar';

const STATUS_DIR = path.join(os.tmpdir(), 'claude-dashboard');

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

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
