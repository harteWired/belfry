import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude', 'belfry.jsonc');
const DEFAULT_THROTTLE_MS = 30_000;
const DEFAULT_COALESCE_MS = 5_000;
// Telegram's hard cap is 4096. The composer renders the RESPONSE first and the
// prompt (collapsed blockquote) last, so when the whole message would exceed
// 4096 it's the prompt tail that gets sacrificed — the response is protected by
// ordering. So give the response the lion's share and keep the prompt a short
// preview, with the SUM (+ header/markup/escaping headroom) safely under 4096 so
// `fitToTelegramCap` never has to byte-slice (a slice mid-HTML-entity would make
// Telegram reject the ping). 3200 + 600 ≈ 3800 raw leaves ~300 chars of escaping
// headroom. Raised the response cap 2500→3200 (#48: verbose agent turns >2500
// were getting their ready-ping clipped); prompt 1500→600 to fund it safely.
const DEFAULT_PROMPT_CAP = 600;
const DEFAULT_RESPONSE_CAP = 3200;
const DEFAULT_DIGEST_IDLE_MS = 15_000;
const DEFAULT_DIGEST_WINDOW_MS = 60_000;
const DEFAULT_EVENTS = ['ready'];
export const VALID_EVENTS = new Set(['ready', 'error', 'waiting']);

function stripJsonc(text) {
  // Drop // line comments and /* block comments */ before JSON.parse.
  // Keep strings intact: a // inside a "..." literal must survive.
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    return {
      subscriptions: {},
      nicknames: null,
      throttleMs: DEFAULT_THROTTLE_MS,
      coalesceMs: DEFAULT_COALESCE_MS,
      promptCap: DEFAULT_PROMPT_CAP,
      responseCap: DEFAULT_RESPONSE_CAP,
      digestIdleMs: DEFAULT_DIGEST_IDLE_MS,
      digestWindowMs: DEFAULT_DIGEST_WINDOW_MS,
      federation: null,
      bridges: null,
      configPath,
      missing: true,
    };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(stripJsonc(raw));
  const subscriptions = {};
  for (const [slug, sub] of Object.entries(parsed.subscriptions ?? {})) {
    const events = Array.isArray(sub?.events) && sub.events.length > 0
      ? sub.events.filter((e) => VALID_EVENTS.has(e))
      : DEFAULT_EVENTS;
    if (events.length === 0) continue;
    subscriptions[slug] = {
      events,
      summarize: sub?.summarize === true,
      digest: sub?.digest === true,
      topic: typeof sub?.topic === 'number' && sub.topic > 0 ? sub.topic : null,
    };
  }
  const nicknames =
    parsed.nicknames && typeof parsed.nicknames === 'object'
      ? Object.fromEntries(
          Object.entries(parsed.nicknames).filter(
            ([, v]) => typeof v === 'string' && v.length > 0,
          ),
        )
      : null;
  return {
    subscriptions,
    nicknames,
    throttleMs: typeof parsed.throttleMs === 'number' && parsed.throttleMs >= 0
      ? parsed.throttleMs
      : DEFAULT_THROTTLE_MS,
    coalesceMs: typeof parsed.coalesceMs === 'number' && parsed.coalesceMs >= 0
      ? parsed.coalesceMs
      : DEFAULT_COALESCE_MS,
    promptCap: typeof parsed.promptCap === 'number' && parsed.promptCap > 0
      ? parsed.promptCap
      : DEFAULT_PROMPT_CAP,
    responseCap: typeof parsed.responseCap === 'number' && parsed.responseCap > 0
      ? parsed.responseCap
      : DEFAULT_RESPONSE_CAP,
    digestIdleMs: typeof parsed.digestIdleMs === 'number' && parsed.digestIdleMs > 0
      ? parsed.digestIdleMs
      : DEFAULT_DIGEST_IDLE_MS,
    digestWindowMs: typeof parsed.digestWindowMs === 'number' && parsed.digestWindowMs > 0
      ? parsed.digestWindowMs
      : DEFAULT_DIGEST_WINDOW_MS,
    // Federation (#29): the raw `federation` block, passed through verbatim for
    // parseFederationConfig() to validate. Federation stays OFF unless a host
    // letter is configured (here or via env), so a config without this block —
    // every existing config — behaves exactly as before.
    federation: parsed.federation && typeof parsed.federation === 'object' ? parsed.federation : null,
    // Webhook bridges (#29 Phase C): { slug: url } for headless agents reached
    // over HTTP (e.g. the NAS life-planner). Passed through for parseBridges().
    bridges: parsed.bridges && typeof parsed.bridges === 'object' ? parsed.bridges : null,
    configPath,
    missing: false,
  };
}

/** True when `slug` is subscribed to `event`. */
export function isSubscribed(config, slug, event) {
  const sub = config.subscriptions[slug];
  return Boolean(sub && sub.events.includes(event));
}

/** True when `slug` opted into Haiku summarization in its subscription block. */
export function isSummarized(config, slug) {
  const sub = config.subscriptions[slug];
  return Boolean(sub && sub.summarize === true);
}

/** True when `slug` opted into rollup digest mode. */
export function isDigested(config, slug) {
  const sub = config.subscriptions[slug];
  return Boolean(sub && sub.digest === true);
}

/**
 * Per-slug forum topic ID, or null when the slug has no specific topic.
 * Caller decides whether to fall back to a global default (e.g. the
 * BELFRY_FORUM_TOPIC_ID env var) when null.
 */
export function topicFor(config, slug) {
  const sub = config?.subscriptions?.[slug];
  return sub?.topic ?? null;
}

/**
 * Inverse map: numeric topic ID → slug. Built once at startup so the
 * inbound poller can resolve a message_thread_id to the slug it belongs
 * to in O(1). Returns a Map.
 */
export function topicSlugMap(config) {
  const out = new Map();
  for (const [slug, sub] of Object.entries(config?.subscriptions ?? {})) {
    if (sub?.topic && typeof sub.topic === 'number') out.set(sub.topic, slug);
  }
  return out;
}
