/**
 * Federation peer registry (#29). Holds the eventually-consistent gossiped view
 * of remote hosts and the slugs they own, and builds the merged owners map the
 * address resolver consults.
 *
 * Hub-free: peers announce their local slug list periodically + on change; this
 * just stores, expires the stale, and merges. No consensus — if the view is
 * briefly stale a send fails gracefully and retries. Clock injected for tests.
 */

export const DEFAULT_PEER_TTL_MS = 90_000;

export class PeerRegistry {
  constructor({ selfLetter = null, ttlMs = DEFAULT_PEER_TTL_MS, now = () => Date.now() } = {}) {
    this.selfLetter = selfLetter;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, { name: string, addr: string|null, slugs: Set<string>, lastSeen: number, reachableAt: number }>} */
    this.peers = new Map();
  }

  /**
   * Upsert a peer from a gossip announcement (replaces its slug set, refreshes
   * lastSeen). Ignores an announcement for our own letter or a missing letter.
   * Returns true if applied.
   *
   * `reachableAt` (#38) is the peer's last-poll-reached-Telegram timestamp from
   * its announce; carried through verbatim so the priority gate can judge owner
   * recoverability. Absent/invalid → 0 (never confirmed reachable).
   */
  applyAnnouncement({ letter, name, addr = null, slugs = [], reachableAt = 0 } = {}) {
    if (!letter || letter === this.selfLetter) return false;
    this.peers.set(letter, {
      name: name ?? letter,
      addr,
      slugs: new Set(slugs),
      lastSeen: this.now(),
      reachableAt: typeof reachableAt === 'number' && reachableAt > 0 ? reachableAt : 0,
    });
    return true;
  }

  removePeer(letter) {
    return this.peers.delete(letter);
  }

  /** Drop peers not seen within ttl. Returns the removed letters. */
  prune() {
    const t = this.now();
    const removed = [];
    for (const [letter, p] of this.peers) {
      if (t - p.lastSeen > this.ttlMs) {
        this.peers.delete(letter);
        removed.push(letter);
      }
    }
    return removed;
  }

  /** A peer's record (after pruning), or null. */
  peer(letter) {
    this.prune();
    return this.peers.get(letter) ?? null;
  }

  /** Non-stale peer records. */
  livePeers() {
    this.prune();
    return [...this.peers.values()];
  }

  /**
   * JSON-safe snapshot of non-stale peers INCLUDING each host letter (which
   * livePeers() omits, since it's the Map key). `ageMs` is time since the
   * peer's last gossip announcement. Powers the /brain/list-peers liveness
   * endpoint the fleet self-healing poller reads.
   */
  snapshot() {
    this.prune();
    const now = this.now();
    return [...this.peers.entries()].map(([letter, p]) => ({
      letter,
      name: p.name,
      slugs: [...p.slugs].sort(),
      lastSeen: p.lastSeen,
      reachableAt: p.reachableAt,
      ageMs: now - p.lastSeen,
    }));
  }

  /**
   * Merged owners view: Map<slug, Set<hostLetter>> across this host's own slugs
   * and every non-stale peer's slugs. `selfSlugs` is an iterable of the local
   * slugs this daemon currently has registered. Feed the result to
   * resolveTarget().
   */
  ownerMap(selfSlugs = []) {
    this.prune();
    const map = new Map();
    const add = (slug, letter) => {
      let s = map.get(slug);
      if (!s) {
        s = new Set();
        map.set(slug, s);
      }
      s.add(letter);
    };
    if (this.selfLetter) {
      for (const slug of selfSlugs) add(slug, this.selfLetter);
    }
    for (const [letter, p] of this.peers) {
      for (const slug of p.slugs) add(slug, letter);
    }
    return map;
  }
}
