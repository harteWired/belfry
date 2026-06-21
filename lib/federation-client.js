/**
 * FederationClient — outbound HTTP to peer daemons over the mesh (#29).
 *
 * Sends an A2A-shaped envelope (lib/federation-envelope.js) to a peer's
 * `/fed/*` endpoint, authenticated with the shared per-daemon bearer token, over
 * whatever private network the peer addresses point at (Tailscale, or a LAN IP
 * for early testing — the client is address-agnostic).
 *
 * Best-effort by contract: every call returns a result object, never throws.
 * Federation is eventually-consistent — a dropped message is re-surfaced by the
 * next gossip round or retried by the caller — so a transport failure must not
 * crash the daemon's hot path. `fetchImpl` is injectable for tests.
 */

export const DEFAULT_FED_TIMEOUT_MS = 8_000;

const ENVELOPE_PATH = Object.freeze({
  announce: '/fed/announce',
  message: '/fed/message',
  reply: '/fed/reply',
  inbound: '/fed/inbound',
  replymap: '/fed/replymap',
});

export class FederationClient {
  constructor({
    token = null,
    timeoutMs = DEFAULT_FED_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    log = () => {},
  } = {}) {
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  /**
   * POST `envelope` to `peer` (a { letter, name, addr } record from config).
   * The route is chosen from envelope.kind. Returns
   *   { ok: true, status, body } | { ok: false, status?, error }
   * — never throws.
   */
  async send(peer, envelope) {
    const path = ENVELOPE_PATH[envelope?.kind];
    if (!path) return { ok: false, error: `federation: unsendable envelope kind "${envelope?.kind}"` };
    if (!peer?.addr) return { ok: false, error: 'federation: peer has no addr' };
    const url = String(peer.addr).replace(/\/$/, '') + path;

    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Timeout, DNS, connection refused, peer offline — all best-effort drops.
      return { ok: false, error: `federation: ${peer.letter ?? '?'} unreachable: ${err.message}` };
    }

    const body = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, status: res.status, error: `federation: ${peer.letter ?? '?'} HTTP ${res.status} ${body.slice(0, 160)}` };
    }
    return { ok: true, status: res.status, body };
  }
}
