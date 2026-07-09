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
 *   'inbound'  — a HUMAN Telegram message forwarded by the bot owner to the host
 *                that owns the target slug (#38 Phase 2). Distinct from 'message'
 *                (agent a2a) because the remote delivers it via the HUMAN path
 *                (belfry provenance, `reply` tool valid) — not as origin="agent".
 *                Requires from.host (the forwarding owner), to {host,slug}, text,
 *                correlationId, and the Telegram context (chatId,
 *                originatingMessageId) the remote needs to send + react back.
 *   'replymap' — a reply-tracker anchor gossiped to peers (#38 Fornax-flip
 *                prerequisite). The source host pinged one of ITS local sessions
 *                and recorded message_id→slug; it forwards that pair so peers can
 *                resolve a quote-reply to that ping even when a DIFFERENT host
 *                (a higher-priority / sessionless bot owner) receives it. Peers
 *                store it host-qualified (<from.host>/<slug>) so the resolved
 *                quote-reply routes back over the mesh via the 'inbound' path.
 *                Requires from.host + integer messageId + non-empty slug.
 *
 * Pure build/parse/validate; no I/O, no transport. `ts` defaults to Date.now()
 * but can be injected for deterministic tests.
 */

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_KINDS = Object.freeze(['message', 'reply', 'announce', 'inbound', 'replymap', 'broadcast']);

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
  slug = null,
  slugs = null,
  messageId = null,
  reachableAt = null,
  broadcast = false,
  chatId = null,
  originatingMessageId = null,
  targetSlugs = null,
  excludeSlugs = null,
  ts = Date.now(),
} = {}) {
  if (!ENVELOPE_KINDS.includes(kind)) {
    throw new Error(`envelope: unknown kind "${kind}"`);
  }

  if (kind === 'broadcast') {
    // A fleet fan-out requested by a mesh agent (Wintermute-only by policy —
    // the receiving daemon enforces its broadcastHosts allowlist). from is the
    // full requesting identity; the receiving host fans `text` out to its OWN
    // registered sessions, optionally filtered.
    if (!validEndpoint(from)) throw new Error('envelope(broadcast): from must be { host:<letter>, slug }');
    if (typeof text !== 'string' || text.length === 0) throw new Error('envelope(broadcast): text must be a non-empty string');
    const slugList = (v, name) => {
      if (v == null) return null;
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.length === 0)) {
        throw new Error(`envelope(broadcast): ${name} must be an array of non-empty strings`);
      }
      return v.length > 0 ? v.map(String) : null;
    };
    const env = {
      v: ENVELOPE_VERSION,
      kind,
      from: { host: from.host, slug: from.slug },
      text,
      ts,
    };
    const t = slugList(targetSlugs, 'targetSlugs');
    const x = slugList(excludeSlugs, 'excludeSlugs');
    if (t) env.targetSlugs = t;
    if (x) env.excludeSlugs = x;
    return env;
  }

  if (kind === 'replymap') {
    // A reply-tracker anchor gossiped to peers (#38 Fornax-flip prerequisite).
    // No to/text — just the source host, the outbound message_id, and the LOCAL
    // slug it pinged. Peers qualify it as <from.host>/<slug> on record.
    if (!from || typeof from.host !== 'string' || !LETTER_RE.test(from.host)) {
      throw new Error('envelope(replymap): from.host must be a single [a-z0-9]');
    }
    if (!Number.isInteger(messageId)) throw new Error('envelope(replymap): messageId must be an integer');
    if (typeof slug !== 'string' || slug.length === 0) throw new Error('envelope(replymap): slug must be a non-empty string');
    return {
      v: ENVELOPE_VERSION,
      kind,
      from: { host: from.host },
      messageId,
      slug,
      ts,
    };
  }

  if (kind === 'inbound') {
    // A human Telegram message forwarded owner → owning-host (#38 Phase 2).
    // from is just the forwarding owner's host; to is the target session.
    if (!from || typeof from.host !== 'string' || !LETTER_RE.test(from.host)) {
      throw new Error('envelope(inbound): from.host must be a single [a-z0-9]');
    }
    if (!validEndpoint(to)) throw new Error('envelope(inbound): to must be { host:<letter>, slug }');
    if (typeof text !== 'string' || text.length === 0) throw new Error('envelope(inbound): text must be a non-empty string');
    if (!correlationId) throw new Error('envelope(inbound): correlationId is required');
    if (!Number.isInteger(chatId)) throw new Error('envelope(inbound): chatId must be an integer');
    if (!Number.isInteger(originatingMessageId)) throw new Error('envelope(inbound): originatingMessageId must be an integer');
    return {
      v: ENVELOPE_VERSION,
      kind,
      from: { host: from.host },
      to: { host: to.host, slug: to.slug },
      text,
      correlationId: String(correlationId),
      chatId,
      originatingMessageId,
      ts,
    };
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
      slug: typeof obj.slug === 'string' ? obj.slug : null,
      slugs: obj.slugs ?? null,
      messageId: Number.isInteger(obj.messageId) ? obj.messageId : null,
      reachableAt: typeof obj.reachableAt === 'number' ? obj.reachableAt : null,
      broadcast: obj.broadcast === true,
      chatId: typeof obj.chatId === 'number' ? obj.chatId : null,
      originatingMessageId: typeof obj.originatingMessageId === 'number' ? obj.originatingMessageId : null,
      targetSlugs: obj.targetSlugs ?? null,
      excludeSlugs: obj.excludeSlugs ?? null,
      ts: typeof obj.ts === 'number' ? obj.ts : Date.now(),
    });
    return { ok: true, envelope };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
