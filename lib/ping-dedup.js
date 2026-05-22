/**
 * Per-slug dedup for ready pings. Two orthogonal guards:
 *
 *   1. Time-window muzzle — set synchronously by every outbound send for a
 *      slug. The next ready ping for that slug within the window is dropped.
 *      Single-shot: the muzzle is consumed on the first ready transition,
 *      so legitimate later turns still ping. This kills the reply-tool
 *      echo (every reply via the MCP `reply` tool is followed by a ready
 *      ping carrying the post-turn assistant prose, which is a different
 *      string from the tool's `text` arg — content equality misses but
 *      time proximity catches it).
 *
 *   2. Content equality — keyed on `last_response` text. After the muzzle
 *      has been consumed (or was never armed), repeat pings carrying the
 *      same `last_response` for the same slug are suppressed. This is the
 *      /loop watchdog case from v0.1.3: pure-tool turns preserve the prior
 *      `last_response`, so successive watcher fires would re-emit the same
 *      body without this guard.
 *
 * Only used for ready transitions. error and waiting always fire — they
 * are rare and represent state the user must see regardless.
 *
 * Stateful (two Maps), so the caller holds an instance for the lifetime
 * of the daemon. Restart resets the dedup; first ping after a restart
 * always fires, which is desirable (it confirms belfry is back).
 *
 * Why muzzle, not text equality (v0.1.5 refactor):
 *
 *   The Stop hook in `bin/belfry-hook.js` builds `last_response` by
 *   walking the JSONL transcript for `type:"text"` assistant content
 *   blocks. The `text` argument the model passes to the reply MCP tool
 *   lives inside a `tool_use` block's `input.text` and is NEVER a
 *   top-level text block. So the model's prose around the tool call —
 *   not the tool arg — becomes `last_response`. v0.1.4 keyed echo
 *   suppression on `recordJustSent(slug, text)` matching `last_response`
 *   and consequently missed on every real reply-tool turn. Time proximity
 *   is the actual invariant: a send and the Stop-hook-driven ready ping
 *   that follows it are causally linked in time, not in content.
 */
export class PingDedup {
  /**
   * @param {object} [opts]
   * @param {number} [opts.muzzleWindowMs] — how long after `muzzleNext` a
   *   ready ping for the same slug is suppressed. Default 30s — long
   *   enough to cover a Stop hook delayed by transcript-flush retry on a
   *   busy host, short enough that a legitimate later-turn ping is still
   *   visible quickly.
   * @param {() => number} [opts.now] — injectable clock for tests.
   */
  constructor({ muzzleWindowMs = 30_000, now = () => Date.now() } = {}) {
    this.lastBySlug = new Map();    // slug → last_response text we last pinged
    this.muzzleBySlug = new Map();  // slug → muzzle-expires-at (ms)
    this.window = muzzleWindowMs;
    this.now = now;
  }

  /**
   * Arm the muzzle for `slug`. The next ready ping for this slug within
   * `muzzleWindowMs` will be suppressed (single-shot — consumed on first
   * match). Call this synchronously from every outbound-send path BEFORE
   * the network await, so a same-tick `onUpdate` -> `shouldSkip` check
   * sees the muzzle.
   *
   * @param {string} slug
   */
  muzzleNext(slug) {
    if (typeof slug !== 'string' || slug.length === 0) return;
    this.muzzleBySlug.set(slug, this.now() + this.window);
  }

  /**
   * Returns true if this ready ping should be skipped.
   *
   * Order matters: muzzle takes precedence over content equality so that
   * a fresh-content ping carrying the post-turn prose is still suppressed
   * (the muzzle's whole point). Both checks self-evict on read — the
   * muzzle is consumed on match, expired muzzles are deleted, and the
   * content map is updated to the latest seen value.
   *
   * @param {string} slug
   * @param {unknown} lastResponse — the dashboard JSON's `last_response`
   *   string. Missing or non-string → never dedup (we can't compare what
   *   we don't have).
   * @returns {boolean}
   */
  shouldSkip(slug, lastResponse) {
    if (typeof lastResponse !== 'string' || lastResponse.length === 0) {
      return false;
    }

    // Muzzle path — time-proximity echo suppression.
    const expiresAt = this.muzzleBySlug.get(slug);
    if (expiresAt !== undefined) {
      if (this.now() <= expiresAt) {
        // Consume the muzzle. Update lastBySlug too so a subsequent
        // /loop watchdog tick carrying the same content is also caught
        // via the content-equality path below.
        this.muzzleBySlug.delete(slug);
        this.lastBySlug.set(slug, lastResponse);
        return true;
      }
      // Expired muzzle — clean it up so the Map stays bounded.
      this.muzzleBySlug.delete(slug);
    }

    // Content-equality path — /loop watchdog dedup.
    if (this.lastBySlug.get(slug) === lastResponse) return true;
    this.lastBySlug.set(slug, lastResponse);
    return false;
  }
}
