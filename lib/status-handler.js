/**
 * On-demand status digest (#12).
 *
 * Triggered by `/status` or `/status <slug>` from Telegram. Reads the
 * dashboard JSONs in `statusDir`, optionally pipes through Haiku, and
 * sends a quote-replied digest back to the user.
 *
 * Two modes:
 *   1. all-slugs (no slug given): one line per active dashboard JSON.
 *      Format: `<slug> — <statusLabel or status> — <relative time>`.
 *      Cap at MAX_SLUGS to keep the message lock-screen-sized. No model
 *      call (the value here is a quick directory dump, not a synthesis).
 *   2. single-slug: read that slug's JSON, run summarizeBatch on a
 *      one-event "burst" (the current state) so Haiku produces a tight
 *      paraphrase. Falls back to a non-AI single-line fallback on miss.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_STATUS_DIR = path.join(os.tmpdir(), 'claude-dashboard');
const MAX_SLUGS = 12;
const SINGLE_SLUG_RESPONSE_CAP = 280;

function relTime(ts) {
  if (!Number.isFinite(ts)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function tsFromStatusFile(s) {
  // Convention writers may set updatedAt or last_update or similar. Try a
  // few common keys; fall back to null if none present.
  const candidates = [s?.updatedAt, s?.updated_at, s?.last_update, s?.ts, s?.timestamp];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
      const parsed = Date.parse(c);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readStatusFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function listSlugs(statusDir = DEFAULT_STATUS_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(statusDir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length));
}

export function buildAllSlugsDigest({ statusDir = DEFAULT_STATUS_DIR, maxSlugs = MAX_SLUGS } = {}) {
  const slugs = listSlugs(statusDir);
  if (slugs.length === 0) return '📋 No active sessions — nothing in /tmp/claude-dashboard.';
  const rows = [];
  for (const slug of slugs) {
    const filePath = path.join(statusDir, `${slug}.json`);
    const sf = readStatusFile(filePath);
    if (!sf) continue;
    const label = sf.statusLabel || sf.status || 'unknown';
    const ts = tsFromStatusFile(sf);
    const tsStr = ts ? ` — ${relTime(ts)}` : '';
    rows.push({ slug, label, ts: ts ?? 0, line: `• ${slug} — ${label}${tsStr}` });
  }
  rows.sort((a, b) => b.ts - a.ts); // most-recent first
  const head = `📋 ${rows.length} session${rows.length === 1 ? '' : 's'}`;
  const body = rows.slice(0, maxSlugs).map((r) => r.line).join('\n');
  const more = rows.length > maxSlugs ? `\n…and ${rows.length - maxSlugs} more` : '';
  return `${head}\n\n${body}${more}`;
}

export async function buildSingleSlugDigest({
  slug,
  statusDir = DEFAULT_STATUS_DIR,
  apiKey = '',
  summarizeBatchFn,
}) {
  const filePath = path.join(statusDir, `${slug}.json`);
  const sf = readStatusFile(filePath);
  if (!sf) return `📋 ${slug} — no dashboard JSON (not running, or slug not recognized)`;

  const label = sf.statusLabel || sf.status || 'unknown';
  const ts = tsFromStatusFile(sf);
  const tsStr = ts ? ` — ${relTime(ts)}` : '';
  const header = `📋 ${slug} — ${label}${tsStr}`;

  // No API key → single-line fallback (status only).
  if (!apiKey || !summarizeBatchFn) {
    const tail = sf.last_response
      ? `\n\nClaude: ${truncate(sf.last_response, SINGLE_SLUG_RESPONSE_CAP)}`
      : '';
    return `${header}${tail}`;
  }

  const summary = await summarizeBatchFn({
    events: [{
      status: sf.status,
      statusLabel: sf.statusLabel,
      prompt: sf.last_prompt,
      response: sf.last_response,
    }],
    apiKey,
  });
  if (!summary) {
    const tail = sf.last_response
      ? `\n\nClaude: ${truncate(sf.last_response, SINGLE_SLUG_RESPONSE_CAP)}`
      : '';
    return `${header}${tail}`;
  }
  return `${header}\n\n${summary}`;
}

function truncate(text, cap) {
  if (typeof text !== 'string') return '';
  if (text.length <= cap) return text;
  return text.slice(0, cap - 1) + '…';
}

/**
 * Wire-it-all-up factory used by bin/belfry.js. Returns an async handler
 * that can be passed as poller.onStatusRequest.
 */
export function makeStatusHandler({
  statusDir = DEFAULT_STATUS_DIR,
  apiKey = '',
  summarizeBatchFn,
  send,
  log = () => {},
}) {
  return async ({ slug, messageId }) => {
    let text;
    if (slug) {
      text = await buildSingleSlugDigest({ slug, statusDir, apiKey, summarizeBatchFn });
    } else {
      text = buildAllSlugsDigest({ statusDir });
    }
    try {
      await send({ text, replyToMessageId: messageId });
      log(`status digest sent (slug=${slug ?? '*'}, ${text.length} chars)`);
    } catch (err) {
      log(`status digest send failed: ${err.message}`);
    }
  };
}

export const _internals = { relTime, tsFromStatusFile, MAX_SLUGS };
