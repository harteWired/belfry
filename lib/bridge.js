/**
 * Webhook bridge for federation delivery targets (#29 Phase C).
 *
 * Most "sessions" on the mesh are interactive Claude Code spokes reached by
 * channel injection. But some are headless agents reached over HTTP — e.g. the
 * NAS life-planner, an Agent-SDK app that ingests messages at POST /api/inbox.
 * A *bridge* maps such a slug to a webhook URL so the federation layer can serve
 * it as a first-class mesh target:
 *
 *   inbound : a mesh message for a bridge slug is POSTed to the webhook as an
 *             A2A envelope (instead of channel-injected). A correlation id is
 *             minted mapping the envelope back to its original sender.
 *   reply   : the agent answers asynchronously by calling the daemon's
 *             /bridge/reply { correlationId, text }; the daemon resolves the
 *             correlation to the original sender and routes the reply back over
 *             the mesh (→ another session, or → Telegram if the origin was human).
 *
 * This module is pure config + transport: parsing the slug→url map and POSTing.
 * The wiring (correlation, reply routing) lives in lib/federation-daemon.js.
 */

const SLUG_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Parse the bridge map from env (`BELFRY_BRIDGES="slug=url;slug2=url2"`) or the
 * belfry.jsonc `bridges` block ({ slug: url }). Env wins when both are present.
 * Returns a Map<slug,url>. Throws on a malformed slug or non-http(s) url so a
 * bad bridge fails loudly at boot rather than silently dropping messages.
 */
export function parseBridges({ env = {}, file = null } = {}) {
  const out = new Map();
  const add = (slug, url) => {
    const s = String(slug).trim();
    const u = String(url).trim();
    if (!SLUG_RE.test(s)) throw new Error(`bridge: invalid slug "${s}"`);
    if (!/^https?:\/\//.test(u)) throw new Error(`bridge: "${s}" url must be http(s), got "${u}"`);
    out.set(s, u);
  };
  const raw = env.BELFRY_BRIDGES;
  if (raw != null && String(raw).trim() !== '') {
    for (const part of String(raw).split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf('=');
      if (i <= 0) throw new Error(`bridge: malformed entry "${part}" (want slug=url)`);
      add(part.slice(0, i), part.slice(i + 1));
    }
  } else if (file && typeof file === 'object') {
    for (const [slug, url] of Object.entries(file)) add(slug, url);
  }
  return out;
}

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * POST an A2A envelope to a bridge's webhook. Best-effort by contract — returns
 * a result object, never throws — so a down webhook can't crash the daemon's
 * mesh hot path. `fetchImpl` is injectable for tests.
 */
export async function postToWebhook(url, envelope, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `bridge webhook unreachable: ${err.message}` };
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, status: res.status, error: `bridge webhook HTTP ${res.status} ${body.slice(0, 160)}` };
  return { ok: true, status: res.status, body };
}
