/**
 * Wintermute message-flow tap (#49). When WINTERMUTE_TAP_URL is set, belfry
 * emits a flow event to the Wintermute Conductor whenever a message moves —
 * deliver / send / broadcast / send_to on the local registry, message relay +
 * gossip on the federation mesh. Wintermute animates these as its
 * message-propagation view; belfry gains no new behavior.
 *
 * Invariants:
 *   - METADATA ONLY. Events carry slugs, hosts, counts, and char lengths —
 *     never message text. The privacy rule ("belfry never logs prompt/response
 *     text") extends to this egress unchanged.
 *   - Fire-and-forget, never throws, short timeout (postToWebhook's shape):
 *     a down Wintermute must cost the hot path nothing.
 *   - Off by default: no URL → makeTap returns null → zero behavior change.
 */

export const DEFAULT_TAP_TIMEOUT_MS = 3_000;

/**
 * Build the emitter: `tap(kind, fields)` POSTs `{ v:1, kind, host, ts, ...fields }`
 * to the tap URL. Returns null when `url` is empty (feature off). Throws on a
 * malformed URL so a bad config fails loudly at boot.
 */
export function makeTap({ url = null, host = '?', token = null, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TAP_TIMEOUT_MS, log = () => {} } = {}) {
  if (url == null || String(url).trim() === '') return null;
  const target = String(url).trim();
  if (!/^https?:\/\//.test(target)) throw new Error(`wintermute-tap: url must be http(s), got "${target}"`);
  return (kind, fields = {}) => {
    const event = { v: 1, kind, host, ts: Date.now(), ...fields };
    try {
      fetchImpl(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      }).then(
        (res) => { if (!res.ok) log(`wintermute-tap: HTTP ${res.status}`); },
        (err) => log(`wintermute-tap: ${err.message}`),
      );
    } catch (err) {
      log(`wintermute-tap: ${err.message}`);
    }
  };
}
