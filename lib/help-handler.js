/**
 * Telegram-side handler for the /help command. Pure factory — bin/belfry.js
 * wires the sender; this module owns the rendering. The canonical text lives
 * in lib/help-text.js so the agent's `get_help_text` tool returns identical
 * content.
 */

import { getHelpText, HELP_TOPICS } from './help-text.js';

export function makeHelpHandler({ send, getHelp = getHelpText, log = () => {} }) {
  return async (action) => {
    try {
      const topic = action.topic ?? 'all';
      const text = getHelp(topic);
      if (text === null) {
        const list = HELP_TOPICS.join(', ');
        await send({
          text: `unknown help topic '${topic}'. Try: ${list}.`,
          replyToMessageId: action.messageId,
        });
        log(`help: unknown topic '${topic}'`);
        return;
      }
      await send({ text, replyToMessageId: action.messageId });
      log(`help: ${topic} (${text.length} chars)`);
    } catch (err) {
      log(`help handler error: ${err.message}`);
    }
  };
}
