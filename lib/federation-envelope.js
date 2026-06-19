/**
 * Federation message envelope (#29). The A2A-shaped JSON that crosses between
 * daemons over Tailscale, and that the bridge POSTs to a deployed agent's
 * webhook. Kept deliberately small and transport-agnostic — the same envelope
 * serializes for daemon→daemon HTTP and daemon→agent-webhook.
 *
 * A2A alignment (so a real A2A facade is later a thin adapter, not a rewrite):
 *   correlationId  ↔ A2A messageId / task id
 *   text           ↔ A2A message part (text)
 *   from/to {host,slug} ↔ A2A agent identity (the slug is the agent name; the
 *                          one-letter host is operator config, never hardcoded)
 *
 * Kinds:
 *   'message'  — a relayed agent-to-agent message. Requires from,to,text.
 *                Carries correlationId when the sender expects a reply routed
 *                back (the bidirectional bridge path).
 *   'reply'    — an answer to a prior 'message'. Requires from,to,text,correlationId.
 *   'announce' — gossip: a host advertising the slugs it currently owns.
 *                Requires from.host + slugs[]. (No to/text.) Optionally carries
 *                `reachableAt` — the ms timestamp of this host's last poll that
 *                reached Telegram (ok or 409), used by the priority gate (#38)
 *                to tell a recoverable owner from an egress-dead one.
 *
 * Pure build/parse/validate; no I/O, no transport. `ts` defaults to Date.now()
 * but can be injected for deterministic tests.
 */

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_KINDS = Object.freeze(['message', 'reply', 'announce']);

const LETTER_RE = /^[a-z0-9]$/;

function validEndpoint(e) {
  return e && typeof e === 'object'
    && typeof e.host === 'string' && LETTER_RE.test(e.host)
    && typeof e.slug === 'string' && e.slug.length > 0;
}

/**
 * Build a normalized, validated envelope. Throws on missing/invalid fields so a
 * malformed send fails loudly at the source rather than on the wire.
 */
export function buildEnvelope({
  kind,
  from,
  to,
  text,
  correlationId = null,
  slugs = null,
  reachableAt = null,
  broadcast = false,
  ts = Date.now(),
} = {}) {
  if (!ENVELOPE_KINDS.includes(kind)) {
    throw new Error(`envelope: unknown kind "${kind}"`);
  }

  if (kind === 'announce') {
    if (!from || typeof from.host !== 'string' || !LETTER_RE.test(from.host)) {
      throw new Error('envelope(announce): from.host must be a single [a-z0-9]');
    }
    if (!Array.isArray(slugs)) {
      throw new Error('envelope(announce): slugs must be an array');
    }
    const env = {
      v: ENVELOPE_VERSION,
      kind,
      from: { host: from.host },
      slugs: slugs.map(String),
      ts,
    };
    if (typeof reachableAt === 'number' && reachableAt > 0) env.reachableAt = reachableAt;
    return env;
  }

  // message / reply
  if (!validEndpoint(from)) throw new Error('envelope: from must be { host:<letter>, slug }');
  if (!validEndpoint(to)) throw new Error('envelope: to must be { host:<letter>, slug }');
  if (typeof text !== 'string' || text.length === 0) throw new Error('envelope: text must be a non-empty string');
  if (kind === 'reply' && !correlationId) {
    throw new Error('envelope(reply): correlationId is required');
  }

  const env = {
    v: ENVELOPE_VERSION,
    kind,
    from: { host: from.host, slug: from.slug },
    to: { host: to.host, slug: to.slug },
    text,
    ts,
  };
  if (correlationId) env.correlationId = String(correlationId);
  if (broadcast) env.broadcast = true;
  return env;
}

/**
 * Parse + validate an incoming envelope (object or JSON string). Never throws —
 * returns { ok:true, envelope } or { ok:false, error } so the transport can
 * reject a bad payload with a clean error instead of crashing.
 */
export function parseEnvelope(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${err.message}` };
    }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'envelope must be an object' };
  if (obj.v !== ENVELOPE_VERSION) return { ok: false, error: `unsupported envelope version ${obj.v}` };
  try {
    // Re-run through buildEnvelope to normalize + apply the same validation,
    // preserving ts and correlationId from the incoming object.
    const envelope = buildEnvelope({
      kind: obj.kind,
      from: obj.from,
      to: obj.to,
      text: obj.text,
      correlationId: obj.correlationId ?? null,
      slugs: obj.slugs ?? null,
      reachableAt: typeof obj.reachableAt === 'number' ? obj.reachableAt : null,
      broadcast: obj.broadcast === true,
      ts: typeof obj.ts === 'number' ? obj.ts : Date.now(),
    });
    return { ok: true, envelope };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
