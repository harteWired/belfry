import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude', 'belfry.jsonc');
const DEFAULT_THROTTLE_MS = 30_000;
const DEFAULT_COALESCE_MS = 5_000;
const DEFAULT_PROMPT_CAP = 200;
const DEFAULT_RESPONSE_CAP = 400;
const DEFAULT_EVENTS = ['ready'];
const VALID_EVENTS = new Set(['ready', 'error', 'waiting']);

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
      throttleMs: DEFAULT_THROTTLE_MS,
      coalesceMs: DEFAULT_COALESCE_MS,
      promptCap: DEFAULT_PROMPT_CAP,
      responseCap: DEFAULT_RESPONSE_CAP,
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
    };
  }
  return {
    subscriptions,
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
