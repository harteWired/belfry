/**
 * Bridge between the poller's onUnmatched callback and the Anthropic-backed
 * classifier. Pure factory — bin/belfry.js wires everything; the returned
 * function takes { text, messageId } and dispatches based on classification.
 *
 * Render rules:
 *   ask       → reply with payload.message
 *   route     → confirmation reply ("→ slug: 'body'") + deliver to slug
 *   ambiguous → reply with candidate list, ask user to disambiguate
 *   decline   → reply with payload.message
 *
 * On any classifier failure we fall through to a generic decline reply, so
 * the user always sees *something* — never a silent drop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { classify } from './agent.js';
import { getHelpText } from './help-text.js';

const MAX_REPLY_LEN = 1024;

function clip(s) {
  if (typeof s !== 'string') return '';
  return s.length > MAX_REPLY_LEN ? s.slice(0, MAX_REPLY_LEN - 1) + '…' : s;
}

/**
 * Default get_session implementation. Reads the dashboard JSON for `slug`
 * if it's in the active set. Injectable so tests can stub the I/O without
 * needing real files on disk.
 */
function defaultReadStatus(statusDir) {
  return (slug, activeSlugSet) => {
    if (!activeSlugSet.has(slug)) return { error: `no active session named '${slug}'` };
    try {
      const file = path.join(statusDir, `${slug}.json`);
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      return { error: err.message };
    }
  };
}

export function makeAgentHandler({
  apiKey,
  nicknames,
  recentMessages,
  getActiveSlugs,
  statusDir,
  readStatus = defaultReadStatus(statusDir),
  send,
  deliver,
  recordReply,
  memory = null,
  chatId = null,
  log = () => {},
  logFailure = () => {},
  fetchImpl,
  classifyFn = classify,
}) {
  return async ({ text, messageId }) => {
    if (typeof text !== 'string' || text.trim().length === 0) return;

    // Set, not array. Membership checks downstream are O(1).
    const activeSlugSet = getActiveSlugs();
    const activeSlugs = [...activeSlugSet];
    const nicknameMap = nicknames.list();

    const tools = {
      list_sessions: () => listSessions(activeSlugs, recentMessages),
      get_session: ({ slug }) => readStatus(slug, activeSlugSet),
      recent_messages: ({ slug, n }) => recentMessages.recent(slug, typeof n === 'number' ? n : 10),
      get_help_text: ({ topic }) => {
        const out = getHelpText(topic);
        return out ?? { error: `unknown help topic '${topic}'` };
      },
    };

    const contextBlock = memory && chatId !== null ? memory.contextBlock(chatId) : '';

    // Record the user turn before classifying so memory.contextBlock sees the
    // latest history. Done here (not after classify) so a slow classify call
    // doesn't leave the user turn in limbo.
    if (memory && chatId !== null) {
      memory.push(chatId, { role: 'user', text });
    }

    let result;
    try {
      result = await classifyFn({
        text,
        apiKey,
        activeSlugs,
        nicknames: nicknameMap,
        contextBlock,
        tools,
        fetchImpl,
        logFailure,
      });
    } catch (err) {
      log(`agent threw: ${err.message}`);
      result = { intent: 'decline', message: "I couldn't process that. Try /status." };
    }

    const recordAssistant = (turnText) => {
      if (memory && chatId !== null && turnText) {
        memory.push(chatId, { role: 'assistant', text: turnText });
      }
    };

    try {
      if (result.intent === 'ask') {
        const reply = clip(result.message || "I don't have an answer for that.");
        await send({ text: reply, replyToMessageId: messageId });
        recordAssistant(reply);
        log(`agent ask: ${reply.length} chars`);
        return;
      }
      if (result.intent === 'route') {
        if (!activeSlugSet.has(result.target_slug)) {
          const reply = `couldn't route to '${result.target_slug}' — not in active sessions.`;
          await send({ text: reply, replyToMessageId: messageId });
          recordAssistant(reply);
          log(`agent route rejected: slug ${result.target_slug} not active`);
          return;
        }
        const confirm = `→ ${result.target_slug}: '${clip(result.body)}'`;
        const sent = await send({ text: confirm, replyToMessageId: messageId });
        if (sent?.message_id && recordReply) recordReply(sent.message_id, result.target_slug);
        const fanout = deliver(result.target_slug, result.body, sent?.message_id ?? null);
        recordAssistant(confirm);
        log(`agent route → ${result.target_slug} (${fanout} instance(s))`);
        return;
      }
      if (result.intent === 'ambiguous') {
        const list = (result.candidates ?? []).slice(0, 5).map((c, i) => `${i + 1}. ${c}`);
        const lines = list.length > 0
          ? [`I think you meant one of:`, ...list, `Reply with the slug or quote-reply this message.`]
          : [`I'm not sure which session you meant.`];
        if (result.hint) lines.push(`(${clip(result.hint)})`);
        const reply = lines.join('\n');
        await send({ text: reply, replyToMessageId: messageId });
        recordAssistant(reply);
        log(`agent ambiguous: ${(result.candidates ?? []).length} candidate(s)`);
        return;
      }
      // decline (or anything unrecognized)
      const msg = clip(result.message || "I'm not sure what you meant. Try /help.");
      await send({ text: msg, replyToMessageId: messageId });
      recordAssistant(msg);
      log('agent decline');
    } catch (err) {
      log(`agent dispatch error: ${err.message}`);
    }
  };
}

function listSessions(activeSlugs, recentMessages) {
  return activeSlugs.map((slug) => {
    const last = recentMessages.recent(slug, 1)[0];
    return {
      slug,
      last_outbound_ts: last?.ts ?? null,
      last_outbound_kind: last?.kind ?? null,
    };
  });
}
