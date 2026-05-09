/**
 * Telegram-side handler for inline-keyboard taps on `waiting` pings.
 * Resolves the token to (slug, messageId), translates the verb to the text
 * we'll inject into the receiving session, edits the original message to
 * show the outcome and drop the keyboard, and dismisses Telegram's loading
 * spinner via answerCallbackQuery.
 *
 * If the token is unknown or expired, we still answer the callback (with a
 * toast explaining it's stale) so Telegram's button doesn't spin forever.
 */

import { editMessageText, answerCallbackQuery, APPROVAL_VERB_TEXT } from './telegram.js';

const VERB_LABEL = {
  allow: 'Allowed',
  deny: 'Denied',
  always: 'Allowed (Always)',
  defer: 'Deferred',
};

export function makeApprovalHandler({
  botToken,
  chatId,
  approvalTokens,
  registry,
  log = () => {},
  fetchImpl,
  now = () => Date.now(),
}) {
  return async ({ callbackQueryId, verb, token, messageId }) => {
    const entry = approvalTokens.consume(token);
    if (!entry) {
      // Stale or unknown token — most likely the user double-tapped or the
      // daemon restarted between send and tap. Tell the user and keep going.
      try {
        await answerCallbackQuery({
          botToken,
          callbackQueryId,
          text: 'This approval was already answered or has expired.',
          showAlert: true,
          fetchImpl,
        });
      } catch (err) {
        log(`stale approval ack failed: ${err.message}`);
      }
      return;
    }
    const verbText = APPROVAL_VERB_TEXT[verb];
    if (!verbText) {
      // Unknown verb — could be future-protocol drift or a tampered button.
      // Always answer the callback so Telegram's loading spinner stops; we
      // already consumed the token so the buttons are effectively dead.
      log(`approval: unknown verb '${verb}'`);
      try {
        await answerCallbackQuery({
          botToken,
          callbackQueryId,
          text: 'Unknown action — please try again.',
          showAlert: true,
          fetchImpl,
        });
      } catch (err) {
        log(`unknown-verb ack failed: ${err.message}`);
      }
      return;
    }

    // Inject into the receiving session via the existing deliver path. Defer
    // skips delivery — the user wants the prompt to stay open and answer
    // through normal chat instead.
    if (verb !== 'defer') {
      const fanout = registry.deliver(entry.slug, verbText, entry.messageId, null);
      log(`approval ${verb} → ${entry.slug} (${fanout} instance(s))`);
    } else {
      log(`approval defer → ${entry.slug} (no delivery)`);
    }

    // Edit the original message to show the outcome and drop the keyboard.
    // editMessageText replaces the body, so re-render = original + trailer.
    const stamp = new Date(now()).toISOString().slice(11, 16);
    const trailer = `\n→ ${VERB_LABEL[verb]} (${stamp})`;
    const newText = (entry.originalText || '') + trailer;
    try {
      await editMessageText({
        botToken,
        chatId,
        messageId,
        text: newText,
        replyMarkup: { inline_keyboard: [] },
        fetchImpl,
      });
    } catch (err) {
      log(`approval edit failed: ${err.message}`);
    }

    try {
      await answerCallbackQuery({
        botToken,
        callbackQueryId,
        text: VERB_LABEL[verb],
        fetchImpl,
      });
    } catch (err) {
      log(`approval ack failed: ${err.message}`);
    }
  };
}
