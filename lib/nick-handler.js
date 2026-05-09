/**
 * Telegram-side handler for the /nick, /unnick, /nicks commands.
 *
 * Pure factory — bin/belfry.js wires the registry + sender + logger; the
 * returned function takes the routed action and emits a one-shot Telegram
 * reply describing the outcome. No state of its own.
 */

const MAX_LIST_LINES = 30;

export function makeNickHandler({ nicknames, send, log = () => {} }) {
  return async (action) => {
    try {
      if (action.action === 'nick-set') {
        const out = nicknames.set(action.nickname, action.slug);
        const text = out.ok
          ? `nicked '${action.nickname.toLowerCase()}' → ${action.slug}`
          : `couldn't set nickname: ${out.reason}`;
        await send({ text, replyToMessageId: action.messageId });
        log(`nick-set ${action.nickname} → ${action.slug}: ${out.ok ? 'ok' : out.reason}`);
        return;
      }
      if (action.action === 'nick-unset') {
        const had = nicknames.unset(action.nickname);
        const text = had
          ? `removed nickname '${action.nickname.toLowerCase()}'`
          : `no nickname '${action.nickname.toLowerCase()}'`;
        await send({ text, replyToMessageId: action.messageId });
        log(`nick-unset ${action.nickname}: ${had ? 'ok' : 'absent'}`);
        return;
      }
      if (action.action === 'nick-list') {
        const list = nicknames.list();
        const entries = Object.entries(list).sort(([a], [b]) => a.localeCompare(b));
        let text;
        if (entries.length === 0) {
          text = 'no nicknames set. Use /nick <name> <slug> to add one.';
        } else {
          const truncated = entries.slice(0, MAX_LIST_LINES);
          const lines = truncated.map(([n, s]) => `${n} → ${s}`);
          if (entries.length > MAX_LIST_LINES) {
            lines.push(`… and ${entries.length - MAX_LIST_LINES} more`);
          }
          text = lines.join('\n');
        }
        await send({ text, replyToMessageId: action.messageId });
        log(`nick-list: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
      }
    } catch (err) {
      log(`nick handler error: ${err.message}`);
    }
  };
}
