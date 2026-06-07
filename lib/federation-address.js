/**
 * Federation addressing (#29). Resolve a `send_to` target against the gossiped
 * global view of which hosts own which slugs.
 *
 * A target is either:
 *   - host-qualified: `<letter>/<slug>` (one-letter host prefix), or
 *   - bare: `<slug>` — routes when the slug is globally unique.
 *
 * The host letters themselves are operator config (see federation-config.js),
 * never hardcoded here. Pure functions; the owners view is injected.
 */

const QUALIFIED_RE = /^([a-z0-9])\/(.+)$/;

/** Split a target into { qualified, hostLetter?, slug }. */
export function parseTarget(target) {
  const s = String(target ?? '').trim();
  const m = QUALIFIED_RE.exec(s);
  if (m) return { qualified: true, hostLetter: m[1], slug: m[2] };
  return { qualified: false, slug: s };
}

/**
 * Resolve `target` to an owning host.
 *
 * @param {string} target
 * @param {{ selfLetter?: string, owners?: Map<string, Set<string>> }} ctx
 *        owners: merged self+peer view, slug → set of host letters that own it.
 * @returns one of:
 *   { kind:'resolved', hostLetter, slug, local }   // route here
 *   { kind:'ambiguous', slug, candidates:[ 'd/slug', 'e/slug' ] }
 *   { kind:'unknown', slug }                         // bare with no known owner
 *   { kind:'invalid', reason }                       // empty/garbage target
 *
 * A host-qualified target always resolves (even if that host/slug isn't
 * currently in the gossip view) — the caller attempts delivery and it fails
 * gracefully if the peer is offline or the slug is gone. This keeps explicit
 * addressing working through gossip lag.
 */
export function resolveTarget(target, { selfLetter = null, owners = new Map() } = {}) {
  const parsed = parseTarget(target);
  if (!parsed.slug) return { kind: 'invalid', reason: 'empty target' };

  if (parsed.qualified) {
    return {
      kind: 'resolved',
      hostLetter: parsed.hostLetter,
      slug: parsed.slug,
      local: parsed.hostLetter === selfLetter,
    };
  }

  const set = owners.get(parsed.slug);
  const letters = set ? [...set] : [];
  if (letters.length === 0) return { kind: 'unknown', slug: parsed.slug };
  if (letters.length === 1) {
    return { kind: 'resolved', hostLetter: letters[0], slug: parsed.slug, local: letters[0] === selfLetter };
  }
  return {
    kind: 'ambiguous',
    slug: parsed.slug,
    candidates: letters.sort().map((l) => `${l}/${parsed.slug}`),
  };
}
