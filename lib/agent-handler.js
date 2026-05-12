/**
 * Bridge between the poller's onUnmatched callback and the brain
 * subprocess. The brain owns all language work — classification, tool
 * use, reply rendering. This module only:
 *
 *   1. Forwards an "unrouted Telegram message" prompt to the brain.
 *   2. Falls back to a "language layer is down" reply when the brain
 *      isn't running (crash, never started, OOM, no claude on PATH).
 *
 * The brain calls reply_to_telegram / deliver_to_slug / decline via its
 * MCP tools (out-of-band; goes through /brain/* on the daemon's loopback
 * registry). So the user's reply happens during the brain's turn, not
 * after this function returns. We ignore the brain's stream-json text
 * result — it's typically empty when the brain calls reply_to_telegram.
 */

const FALLBACK_DOWN =
  'language layer is down. Deterministic routes still work: /status, /nick, /unnick, /nicks, /help, /resume, quote-reply on belfry messages, or /<slug> body.';

const FALLBACK_ERROR =
  'language layer hit an error. Try again, or use /help to see what works.';

export function makeAgentHandler({ brain, brainHandlers = null, send, log = () => {} }) {
  return async ({ text, messageId }) => {
    if (typeof text !== 'string' || text.trim().length === 0) return;

    if (!brain || !brain.isAlive()) {
      try {
        await send({ text: FALLBACK_DOWN, replyToMessageId: messageId });
        log('agent: brain down — fallback reply sent');
      } catch (err) {
        log(`agent: brain-down fallback send failed: ${err.message}`);
      }
      return;
    }

    // Build a prompt the brain can act on. Active sessions, nicknames, and
    // help text are all reachable via MCP tools — we don't dump them into
    // the prompt to keep token cost bounded.
    const prompt = [
      'CLASSIFY this Telegram message and respond by calling exactly one tool.',
      `Originating message_id: ${messageId} — pass it as reply_to_message_id when calling reply_to_telegram, deliver_to_slug, or decline.`,
      `User said: ${text}`,
    ].join('\n');

    // Clear the brain-handlers' per-turn action flag so we can tell
    // afterward whether any reply/deliver/decline tool fired. If one did,
    // the user has already received a visible result and we must not
    // double-send the model's stray text output. Pre-fix, "text fallback"
    // fired even when a tool had fired, producing duplicate replies (the
    // 2026-05-11 bug).
    brainHandlers?.resetActionFlag?.();

    try {
      const result = await brain.send(prompt);
      const toolFired = brainHandlers?.didActionFire?.() === true;
      const hasText = !!result && result.trim().length > 0;
      if (toolFired) {
        if (hasText) log(`agent: brain returned text alongside tool — suppressed (${result.length} chars)`);
        else log(`agent: brain processed (msg ${messageId})`);
        return;
      }
      if (hasText) {
        // No tool fired but the brain produced text. Forward as a fallback
        // so the user is never silently ignored on prompt-compliance miss.
        await send({ text: result.trim(), replyToMessageId: messageId });
        log(`agent: brain returned text fallback (${result.length} chars)`);
      } else {
        log(`agent: brain processed (msg ${messageId})`);
      }
    } catch (err) {
      log(`agent: brain.send failed: ${err.message}`);
      try {
        await send({ text: FALLBACK_ERROR, replyToMessageId: messageId });
      } catch (sendErr) {
        log(`agent: error fallback send failed: ${sendErr.message}`);
      }
    }
  };
}
