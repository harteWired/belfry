#!/usr/bin/env node
/**
 * belfry-install-hook — add belfry-hook to a project's `.claude/settings.json`,
 * skipping if another tool is already writing the `/tmp/claude-dashboard/`
 * convention (see docs/CONVENTION.md).
 *
 * Coordination is at install time, not runtime: if you have both belfry and
 * claudelike-bar installed, exactly one of them writes the JSON per Stop
 * event. Whoever runs `*-install-hook` first sticks; the second runs
 * detects the existing entry and exits without changing anything.
 *
 * Usage:
 *   belfry-install-hook                # apply to ./.claude/settings.json
 *   belfry-install-hook --target=PATH  # apply to PATH
 *   belfry-install-hook --dry-run      # report what would change
 *   belfry-install-hook --force        # install even if a conflicting writer is present
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_EVENTS = ['Stop', 'SubagentStop', 'Notification', 'SessionStart', 'SessionEnd'];

/**
 * Substrings used to recognize an existing writer of the convention. Any
 * tool that ships a Stop hook writing `/tmp/claude-dashboard/` should add
 * its command name here in a follow-up so other tools' installers detect
 * it. See docs/CONVENTION.md → "Coordination between writers".
 */
const KNOWN_WRITERS = [
  'belfry-hook',
  'claudelike-bar', // matches `claudelike-bar-hook`, `claudelike-bar/hooks/...`
];

export function detectExistingWriter(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return null;
  for (const eventName of Object.keys(hooks)) {
    const arr = hooks[eventName];
    if (!Array.isArray(arr)) continue;
    for (const matcherEntry of arr) {
      const inner = matcherEntry?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = typeof h?.command === 'string' ? h.command : '';
        for (const pat of KNOWN_WRITERS) {
          if (cmd.includes(pat)) return { writer: pat, event: eventName, command: cmd };
        }
      }
    }
  }
  return null;
}

export function buildSettingsWithBelfryHook(existing, hookCommand) {
  const settings = existing && typeof existing === 'object' ? { ...existing } : {};
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...settings.hooks } : {};
  for (const event of HOOK_EVENTS) {
    const arr = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
    // Dedupe: if any matcher entry already references hookCommand, skip. This
    // makes repeated --force runs idempotent — without the check, each rerun
    // multiplies belfry-hook entries and Claude Code would invoke us N times
    // per event.
    const alreadyHas = arr.some((entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((h) => h?.command === hookCommand),
    );
    if (!alreadyHas) {
      arr.push({ hooks: [{ type: 'command', command: hookCommand }] });
    }
    hooks[event] = arr;
  }
  settings.hooks = hooks;
  return settings;
}

/**
 * Best-effort scan for JSON-with-comments markers in raw settings.json text.
 * Strict JSON parses fine here, but if the user has hand-edited their file
 * (or another tool wrote JSONC), our `JSON.stringify` round-trip will drop
 * the comments silently. This returns true so the caller can warn before
 * destroying the user's annotations. False positives (e.g. `//` inside a
 * string literal) only produce extra warnings — they don't block the write.
 */
export function looksLikeJsonc(rawText) {
  if (typeof rawText !== 'string') return false;
  return rawText.includes('//') || rawText.includes('/*');
}

function parseArgs(argv) {
  const out = { target: '.claude/settings.json', dryRun: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg.startsWith('--target=')) out.target = arg.slice('--target='.length);
  }
  return out;
}

function readSettings(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return { raw, parsed: JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { raw: null, parsed: null };
    throw new Error(`failed to parse ${path}: ${err.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetPath = resolve(process.cwd(), args.target);
  const { raw, parsed: existing } = readSettings(targetPath);
  const detected = detectExistingWriter(existing);
  if (detected && !args.force) {
    process.stdout.write(
      `belfry-install-hook: convention writer already present (${detected.writer} on ${detected.event}). Skipping.\n` +
      `  command: ${detected.command}\n` +
      `Use --force to install anyway (only one writer per project is recommended).\n`,
    );
    process.exit(0);
  }

  const updated = buildSettingsWithBelfryHook(existing, 'belfry-hook');
  const text = JSON.stringify(updated, null, 2) + '\n';
  if (args.dryRun) {
    process.stdout.write(`belfry-install-hook: would write ${targetPath}:\n${text}`);
    process.exit(0);
  }
  // Comment guard: settings.json is strict JSON to Claude Code, but users
  // commonly hand-edit .claude/ files with comments. Round-tripping through
  // JSON.parse + JSON.stringify silently drops them, which we surface here
  // before the write so the user can review the diff or restore by hand.
  if (raw && looksLikeJsonc(raw)) {
    process.stderr.write(
      `belfry-install-hook: warning — ${targetPath} appears to contain comments (// or /*). ` +
      `These will be removed by this write. Review the diff before committing, or restore comments by hand.\n`,
    );
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, text);
  process.stdout.write(`belfry-install-hook: updated ${targetPath}\n`);
  if (detected && args.force) {
    process.stdout.write(
      `  warning: ${detected.writer} is also present on ${detected.event}. Two writers will race on each event — remove one.\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`belfry-install-hook: ${err.message}\n`);
    process.exit(1);
  }
}
