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
 *   BELFRY_HOST_PRIORITY non-negative integer — this host's ownership priority
 *                          for the Telegram-owner election (#38). LOWER = higher
 *                          priority (1 = primary). Unset → no priority gating
 *                          (pure 409 election, prior behavior).
 *   BELFRY_FED_TOKEN     per-daemon bearer for inter-daemon auth (secret → env only).
 *   BELFRY_FED_PEERS     compact peer list, ';'-separated, fields ','-separated:
 *                          "e,Erebus,http://erebus:49876,2;n,NAS,http://nas:49876,3"
 *                          By field count: "letter,addr" | "letter,name,addr" |
 *                          "letter,name,addr,priority".
 * File block (belfry.jsonc "federation"):
 *   { hostLetter, hostName, priority, peers:[{letter,name,addr,priority}] }
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
  const priority = parsePriority(env.BELFRY_HOST_PRIORITY ?? block.priority, `host "${hostLetter}"`);

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
    peers.push({ letter, name, addr, priority: parsePriority(p.priority, `peer "${letter}"`) });
  }

  // Broadcast-authorized mesh hosts: which peer letters may trigger a fleet
  // fan-out on THIS host via /fed/broadcast. Default empty — nobody. The fleet
  // policy (2026-07-08) is Wintermute-only, so every host sets this to "w".
  // Env: comma/space-separated letters; jsonc: `broadcastHosts: ["w"]`.
  const rawBroadcastHosts = env.BELFRY_FED_BROADCAST_HOSTS != null
    ? String(env.BELFRY_FED_BROADCAST_HOSTS).split(/[\s,;]+/).filter(Boolean)
    : (Array.isArray(block.broadcastHosts) ? block.broadcastHosts : []);
  const broadcastHosts = [];
  for (const raw of rawBroadcastHosts) {
    const letter = String(raw).trim().toLowerCase();
    if (!LETTER_RE.test(letter)) {
      throw new Error(`federation: broadcastHosts letter must be a single [a-z0-9], got "${letter}"`);
    }
    if (!broadcastHosts.includes(letter)) broadcastHosts.push(letter);
  }

  return { enabled: true, hostLetter, hostName, token, priority, peers, broadcastHosts };
}

/**
 * Parse an optional ownership priority. Unset/blank → null (no gating). Must be
 * a non-negative integer otherwise — a typo'd priority should fail loud, not
 * silently disable failover ordering.
 */
function parsePriority(v, who) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`federation: priority for ${who} must be a non-negative integer, got "${v}"`);
  }
  return n;
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
      // URLs never contain commas, so field count is unambiguous.
      if (f.length === 2) return { letter: f[0], addr: f[1] };
      if (f.length === 3) return { letter: f[0], name: f[1], addr: f[2] };
      if (f.length === 4) return { letter: f[0], name: f[1], addr: f[2], priority: f[3] };
      throw new Error(`federation: malformed peer spec "${part}" (want "letter,[name,]addr[,priority]")`);
    });
}
