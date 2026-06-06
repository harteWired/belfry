/**
 * Routing-status emoji reactions (#32).
 *
 * When an inbound Telegram message routes (or fails to route), belfry reacts
 * to it with a single emoji encoding the routing OUTCOME — the cheapest "I
 * saw this, here's what happened to it" ack, landing before the model's text
 * reply does. A reaction carries no text, so it signals the outcome, not the
 * destination slug (that rides on the "<slug>:" header the reply path adds).
 *
 *   delivered → routed to at least one live session
 *   dropped   → slug recognized but no live session registered for it
 *   unmatched → no deterministic route (no quote-reply, no known prefix)
 *   replied   → the session answered — swap the 👀 ack to a 🫡 "replied" marker
 *               (set on the originating inbound when its reply lands)
 *
 * Telegram standard bots may only react with emoji from a fixed free set
 * (~70). The defaults below are all on it (👀 🤔 🤷 🫡 ✍️ 👍 👌 are valid).
 * NOTE: there is NO green check in the set — ✅ and ✔️ both 400 with
 * REACTION_INVALID (learned the hard way 2026-06-01), which is why the
 * "replied" marker is 🫡 (salute), not a checkmark. Override any state via its
 * env var, set a state's env var to an empty string to disable just that
 * state, or set BELFRY_REACT to a falsy value (0/off/false/no) to disable the
 * whole feature.
 */

export const DEFAULT_REACTIONS = Object.freeze({
  delivered: '👀',
  dropped: '🤷',
  unmatched: '🤔',
  replied: '🫡',
});

const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);

/**
 * Resolve the reaction config from the environment.
 *
 * Returns `null` when the feature is disabled wholesale, otherwise an object
 * `{ delivered, dropped, unmatched }` where each value is an emoji string or
 * `null` (that state disabled). `null` values are honored by the poller as
 * "don't react for this outcome".
 */
export function resolveReactionConfig(env = process.env) {
  const master = (env.BELFRY_REACT ?? '').trim().toLowerCase();
  if (OFF_VALUES.has(master)) return null;
  const pick = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const trimmed = raw.trim();
    // An explicitly-set empty value disables just this state. A non-empty
    // override replaces the default emoji.
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    delivered: pick('BELFRY_REACT_DELIVERED', DEFAULT_REACTIONS.delivered),
    dropped: pick('BELFRY_REACT_DROPPED', DEFAULT_REACTIONS.dropped),
    unmatched: pick('BELFRY_REACT_UNMATCHED', DEFAULT_REACTIONS.unmatched),
    replied: pick('BELFRY_REACT_REPLIED', DEFAULT_REACTIONS.replied),
  };
}
