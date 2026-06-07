/**
 * Federation config (#29). Per-daemon host identity + peer list for the
 * decentralized agent-to-agent mesh.
 *
 * DESIGN PRINCIPLE: nothing host-specific is committed. Every value here is
 * operator config — env vars and/or the `federation` block of
 * ~/.claude/belfry.jsonc (which lives outside the repo). The repo ships only
 * `docs/federation.example.jsonc` with placeholders. Same posture as
 * BELFRY_TOKEN / BELFRY_CHAT_ID.
 *
 * Federation is OFF unless a host letter is configured (mirrors the brain/voice
 * "feature off when unconfigured" pattern). `parseFederationConfig` is pure
 * (env + file block in, normalized config out) so it is fully unit-testable.
 *
 * Env:
 *   BELFRY_HOST_LETTER   single [a-z0-9] — this host's address prefix. Required.
 *   BELFRY_HOST_NAME     display name (defaults to the letter).
 *   BELFRY_FED_TOKEN     per-daemon bearer for inter-daemon auth (secret → env only).
 *   BELFRY_FED_PEERS     compact peer list, ';'-separated, fields ','-separated:
 *                          "e,Erebus,http://erebus:49876;n,NAS,http://nas:49876"
 *                          (name optional → "e,http://erebus:49876")
 * File block (belfry.jsonc "federation"): { hostLetter, hostName, peers:[{letter,name,addr}] }
 * Env wins over the file block per field; BELFRY_FED_PEERS (if set) replaces the
 * file peer list wholesale.
 */

const LETTER_RE = /^[a-z0-9]$/;

export function parseFederationConfig({ env = {}, file = null } = {}) {
  const block = file && typeof file === 'object' ? file : {};
  const hostLetter = String(env.BELFRY_HOST_LETTER ?? block.hostLetter ?? '').trim().toLowerCase();
  if (!hostLetter) return { enabled: false };
  if (!LETTER_RE.test(hostLetter)) {
    throw new Error(`federation: host letter must be a single [a-z0-9], got "${hostLetter}"`);
  }

  const hostName = String(env.BELFRY_HOST_NAME ?? block.hostName ?? hostLetter).trim() || hostLetter;
  const token = String(env.BELFRY_FED_TOKEN ?? '').trim() || null;

  const envPeers = parsePeerEnv(env.BELFRY_FED_PEERS);
  const rawPeers = envPeers ?? (Array.isArray(block.peers) ? block.peers : []);

  const peers = [];
  const seen = new Set([hostLetter]);
  for (const p of rawPeers) {
    const letter = String(p.letter ?? '').trim().toLowerCase();
    const addr = String(p.addr ?? '').trim();
    const name = String(p.name ?? letter).trim() || letter;
    if (!LETTER_RE.test(letter)) {
      throw new Error(`federation: peer letter must be a single [a-z0-9], got "${letter}"`);
    }
    if (letter === hostLetter) {
      throw new Error(`federation: peer letter "${letter}" collides with this host's own letter`);
    }
    if (seen.has(letter)) {
      throw new Error(`federation: duplicate peer letter "${letter}"`);
    }
    if (!addr) throw new Error(`federation: peer "${letter}" is missing an addr`);
    seen.add(letter);
    peers.push({ letter, name, addr });
  }

  return { enabled: true, hostLetter, hostName, token, peers };
}

/**
 * Parse the compact BELFRY_FED_PEERS env form. Returns null when unset (so the
 * caller falls back to the file block) or an array of {letter,[name,]addr}.
 * Peers are ';'/newline separated; fields are ','-separated. URLs never contain
 * commas, so a comma delimiter is unambiguous (unlike ':' which collides with
 * the scheme separator).
 */
function parsePeerEnv(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw)
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const f = part.split(',').map((s) => s.trim());
      if (f.length === 2) return { letter: f[0], addr: f[1] };
      if (f.length >= 3) return { letter: f[0], name: f[1], addr: f.slice(2).join(',') };
      throw new Error(`federation: malformed peer spec "${part}" (want "letter,[name,]addr")`);
    });
}
