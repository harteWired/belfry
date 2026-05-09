#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { loadConfig, isSubscribed, isSummarized, isDigested, topicFor, topicSlugMap } from '../lib/config.js';
import { StatusWatcher } from '../lib/watcher.js';
import { Throttle } from '../lib/throttle.js';
import { Digest } from '../lib/digest.js';
import { compose } from '../lib/composer.js';
import { sendMessage } from '../lib/telegram.js';
import { ReplyTracker } from '../lib/reply-tracker.js';
import { Registry } from '../lib/registry.js';
import { Poller } from '../lib/poller.js';
import { maybeAutoReply } from '../lib/auto-reply.js';
import { summarize, summarizeBatch } from '../lib/summarizer.js';
import { makeStatusHandler } from '../lib/status-handler.js';
import { makeDigestFlush } from '../lib/digest-flush.js';
import { NicknameRegistry } from '../lib/nicknames.js';
import { makeNickHandler } from '../lib/nick-handler.js';
import { makeHelpHandler } from '../lib/help-handler.js';
import { RecentMessages } from '../lib/recent-messages.js';
import { makeAgentHandler } from '../lib/agent-handler.js';
import { ConversationMemory } from '../lib/conversation-memory.js';
import { ApprovalTokens } from '../lib/approval-tokens.js';
import { makeApprovalHandler } from '../lib/approval-handler.js';
import { approvalKeyboard } from '../lib/telegram.js';
import { transcribe } from '../lib/transcribe.js';
import { getHelpText } from '../lib/help-text.js';

function log(msg) {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

/**
 * Decide whether a transition should fire a Telegram message.
 *
 * Rules:
 *   1. Slug must be subscribed.
 *   2. The new status must be in the subscription's events list.
 *   3. The transition must be a *meaningful* state change. We currently fire
 *      on any entry into a subscribed status, regardless of the previous
 *      status — except `ready → ready` (label refresh). This mirrors the
 *      filter the AudioPlayer uses in claudelike-bar.
 */
function shouldFire(config, slug, prevStatus, newStatus) {
  if (!isSubscribed(config, slug, newStatus)) return false;
  if (newStatus === 'ready' && prevStatus === 'ready') return false;
  return true;
}

async function main() {
  const config = loadConfig();
  if (config.missing) {
    log(`config missing at ${config.configPath} — running with empty whitelist (every event will be ignored)`);
  } else {
    const slugs = Object.keys(config.subscriptions);
    log(`config: ${slugs.length} subscribed slug(s): ${slugs.join(', ') || '(none)'}`);
  }

  const botToken = (process.env.BELFRY_TOKEN ?? '').trim();
  const chatId = (process.env.BELFRY_CHAT_ID ?? '').trim();
  const forumTopicId = (process.env.BELFRY_FORUM_TOPIC_ID ?? '').trim();
  const mcpPort = Number(process.env.BELFRY_MCP_PORT || 49876);
  if (!botToken || !chatId) {
    log('missing BELFRY_TOKEN and/or BELFRY_CHAT_ID env vars — relay disabled');
    log('see README.md for setup. Common pattern: a launcher script reads from your secret store and exec-s belfry with the env vars set.');
    process.exit(1);
  }
  log(`telegram bot configured (chat ${chatId}${forumTopicId ? `, topic ${forumTopicId}` : ''})`);

  // Optional Haiku summarizer. Per-slug opt-in via subscriptions[slug].summarize
  // in belfry.jsonc. If the env var is unset, summarization is disabled and
  // the composer falls back to its existing truncate path — no error.
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (anthropicApiKey) {
    const enabledSlugs = Object.entries(config.subscriptions)
      .filter(([, s]) => s.summarize)
      .map(([slug]) => slug);
    if (enabledSlugs.length > 0) {
      log(`summarizer enabled for ${enabledSlugs.length} slug(s): ${enabledSlugs.join(', ')}`);
    }
  } else {
    const wantSummarize = Object.values(config.subscriptions).some((s) => s.summarize);
    if (wantSummarize) {
      log('ANTHROPIC_API_KEY unset — summarize:true subscriptions will fall back to truncate');
    }
  }

  // Optional voice-note transcription (#19). Defaults to Groq's
  // whisper-large-v3-turbo. Without the env, voice messages drop with a
  // polite Telegram reply explaining how to enable.
  const transcribeKey = (process.env.BELFRY_TRANSCRIBE_KEY ?? '').trim();
  if (transcribeKey) {
    log('voice transcription enabled (Groq Whisper)');
  }

  // Inbound: per-session belfry-mcp plugins register here. The poller routes
  // each Telegram reply to the slug's registered plugin(s) which inject the
  // text via MCP `notifications/claude/channel` — same path plugin:telegram
  // uses, just with multi-session fan-out.
  const stateDir =
    (process.env.BELFRY_STATE_DIR ?? '').trim() ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'belfry');
  const replyTracker = new ReplyTracker({
    persistPath: join(stateDir, 'reply-tracker.json'),
    log,
  });

  // Auth token: random 32-byte hex written 0600 to the state dir. Spokes
  // read it from the same path. Without this, any local user/process could
  // /register an arbitrary slug and drain another session's Telegram replies.
  const tokenPath = join(stateDir, 'registry.token');
  const authToken = ensureAuthToken(tokenPath);

  // Scratch directory for inbound attachments (Telegram photos / voice
  // notes downloaded for forwarding to sessions). 0700 dir, 0600 files —
  // payloads can be sensitive (screenshots of work) so other UIDs on the
  // host shouldn't read them. GC on startup drops anything older than 24h
  // since by then the receiving session has either consumed the file or
  // moved on; the path is opaque to the daemon after delivery.
  const attachmentDir = join(stateDir, 'attachments');
  gcOldAttachments(attachmentDir, log);

  // In-memory ring of recent outbound messages per slug. Read by the
  // conversational agent's `recent_messages` tool to answer "what's been
  // happening with X?" without going to disk. Non-persistent — a daemon
  // restart drops the rings; we don't write history to disk because the
  // dashboard JSON is already there.
  const recentMessages = new RecentMessages();

  // Resolve the topic to send a slug's outbound messages into. Per-slug
  // subscription override → BELFRY_FORUM_TOPIC_ID env fallback → main chat.
  const topicForSlug = (slug) => topicFor(config, slug) ?? (forumTopicId || null);

  // Outbound dispatcher used by both the spoke `reply` tool (via /send) and
  // the auto-reply path below. Records the new message_id in the reply
  // tracker so subsequent quote-replies on this thread route correctly.
  // Per-slug forum topic override means the right session's topic gets the
  // reply (when configured); otherwise the daemon-level fallback applies.
  const sendOutbound = async ({ slug, text, replyToMessageId }) => {
    const result = await sendMessage({
      botToken, chatId, text, forumTopicId: topicForSlug(slug), replyToMessageId,
    });
    if (result?.message_id) replyTracker.record(result.message_id, slug);
    recentMessages.push(slug, { kind: 'outbound', text });
    log(`sent ${slug}: outbound reply (${text.length} chars, msg ${result?.message_id}${replyToMessageId ? `, in reply to ${replyToMessageId}` : ''})`);
    return { message_id: result?.message_id };
  };

  const registry = new Registry({ port: mcpPort, log, authToken, onSend: sendOutbound });
  await registry.start();

  // Watcher is created later (after we know the digest flush + onUpdate
  // callbacks), but the nickname registry and agent handler both need to
  // call into it. Single forward-declared holder both close over.
  let watcher = null;
  const nicknames = new NicknameRegistry({
    persistPath: join(stateDir, 'nicknames.json'),
    getActiveSlugs: () => (watcher ? watcher.getActiveSlugs() : new Set()),
    log,
  });
  nicknames.load();
  if (config.nicknames) nicknames.bootstrap(config.nicknames);
  log(`nicknames loaded: ${Object.keys(nicknames.list()).length} entr${Object.keys(nicknames.list()).length === 1 ? 'y' : 'ies'}`);

  // Rate-limited summarizer failure logger. Without this, repeated 401s on
  // a bad key spam stderr once per ping. We log each category at most once
  // per minute — enough to tell "key is invalid" from "Anthropic 5xx" from
  // "network gone" without flooding logs in steady-state failure.
  const summarizerLogState = new Map();
  const SUMMARIZER_LOG_WINDOW_MS = 60_000;
  const logSummarizerFailure = (category, detail) => {
    const now = Date.now();
    const last = summarizerLogState.get(category) ?? 0;
    if (now - last < SUMMARIZER_LOG_WINDOW_MS) return;
    summarizerLogState.set(category, now);
    log(`summarizer ${category}${detail ? ` (${detail})` : ''}`);
  };

  // Two thin wrappers around the summarizer so each callsite (throttle
  // dispatch, digest flush, /status handler) shares one "is the API key
  // present? then summarize, else null" path. Both return null when
  // disabled — callers fall back to the truncate / raw-text path.
  const maybeSummarize = anthropicApiKey
    ? (args) => summarize({ ...args, apiKey: anthropicApiKey, logFailure: logSummarizerFailure })
    : async () => null;
  const maybeSummarizeBatch = anthropicApiKey
    ? (args) => summarizeBatch({ ...args, apiKey: anthropicApiKey, logFailure: logSummarizerFailure })
    : async () => null;
  const statusHandler = makeStatusHandler({
    summarizeFn: anthropicApiKey ? maybeSummarize : null,
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    // For single-slug /status, record the digest message_id against the
    // slug so a follow-up quote-reply lands on the same session.
    // All-slugs digests pass slug=null inside the handler and skip recording.
    recordReply: (msgId, slug) => replyTracker.record(msgId, slug),
    log,
  });

  const nickHandler = makeNickHandler({
    nicknames,
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    log,
  });

  const helpHandler = makeHelpHandler({
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    log,
  });

  // Approval tokens for inline-keyboard taps on `waiting` pings (#17).
  // The throttle dispatch issues a token per waiting message; tap callbacks
  // resolve back to (slug, messageId) and inject the chosen verb as session
  // input, then edit the prompt to drop the keyboard + show outcome.
  const approvalTokens = new ApprovalTokens();
  const approvalHandler = makeApprovalHandler({
    botToken,
    chatId,
    approvalTokens,
    registry,
    log,
  });

  // Conversational agent (#13). Activates only when ANTHROPIC_API_KEY is
  // set; otherwise the handler still runs but classify() returns a decline
  // immediately. getActiveSlugs uses the in-memory cache (no readdir on
  // every Telegram message); the cold-path /nick validation in
  // NicknameRegistry uses the readdir variant directly via watcher.getActiveSlugs.
  // Per-chat memory keeps recent turns in the classify prompt so follow-ups
  // and disambiguation replies have context.
  const conversationMemory = new ConversationMemory();
  const agentHandler = makeAgentHandler({
    apiKey: anthropicApiKey,
    nicknames,
    recentMessages,
    memory: conversationMemory,
    chatId: Number(chatId),
    getActiveSlugs: () => (watcher ? watcher.getActiveSlugsFromCache() : new Set()),
    statusDir: undefined, // resolved by readStatus closure below
    readStatus: (slug, activeSlugSet) => {
      if (!activeSlugSet.has(slug)) return { error: `no active session named '${slug}'` };
      try {
        const file = join(watcher.statusDir, `${slug}.json`);
        const raw = readFileSync(file, 'utf8');
        return JSON.parse(raw);
      } catch (err) {
        return { error: err.message };
      }
    },
    getHelp: getHelpText,
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    deliver: (slug, text, messageId) => registry.deliver(slug, text, messageId),
    recordReply: (msgId, slug) => replyTracker.record(msgId, slug),
    logFailure: logSummarizerFailure, // share the rate-limited bucket
    log,
  });

  // Forum-topic routing (#15). Per-slug topic IDs in subscriptions[slug].topic
  // get inverted at startup so the inbound poller can resolve a Telegram
  // message_thread_id back to the slug it belongs to in O(1).
  const topicMap = topicSlugMap(config);
  if (topicMap.size > 0) {
    log(`forum topics: ${topicMap.size} slug(s) bound to topic IDs`);
  }

  const poller = new Poller({
    botToken,
    expectedChatId: Number(chatId),
    replyTracker,
    target: registry,
    onStatusRequest: statusHandler,
    onNickRequest: nickHandler,
    onHelpRequest: helpHandler,
    onApproval: approvalHandler,
    onUnmatched: agentHandler,
    resolveNickname: (token) => nicknames.resolve(token),
    resolveTopic: (id) => topicMap.get(id) ?? null,
    attachmentDir,
    transcribeFn: transcribeKey
      ? ({ audioPath }) => transcribe({ apiKey: transcribeKey, audioPath, logFailure: logSummarizerFailure })
      : null,
    onVoiceWithoutKey: async ({ messageId }) => {
      try {
        await sendMessage({
          botToken,
          chatId,
          text: 'voice notes need BELFRY_TRANSCRIBE_KEY set in the daemon env (Groq, free tier works).',
          replyToMessageId: messageId,
        });
      } catch (err) {
        log(`voice no-key reply failed: ${err.message}`);
      }
    },
    log,
  });
  poller.start();
  log(`poller started (chat ${chatId})`);

  // Outbound: chokidar watcher → throttle → composer → Telegram.
  const throttle = new Throttle({
    coalesceMs: config.coalesceMs,
    throttleMs: config.throttleMs,
    dispatch: async (slug, event) => {
      let statusFile = event.statusFile;
      if (isSummarized(config, slug)) {
        const summary = await maybeSummarize({
          prompt: statusFile?.last_prompt,
          response: statusFile?.last_response,
        });
        if (summary) {
          statusFile = {
            ...statusFile,
            last_prompt: summary.prompt ?? statusFile?.last_prompt,
            last_response: summary.response ?? statusFile?.last_response,
          };
        }
      }
      const text = compose({
        slug,
        status: event.status,
        event: event.event,
        statusFile,
        displayName: statusFile?.displayName ?? slug,
        promptCap: config.promptCap,
        responseCap: config.responseCap,
        replyFooter: true,
      });
      // For `waiting` events (Claude Code blocked on a permission prompt
      // or notification), include an inline keyboard with Allow/Deny/
      // Always/Defer. Issue the token now so the keyboard's callback_data
      // can carry it; patch in the assigned message_id after send returns.
      // Revoke on send failure to avoid leaking the entry until TTL.
      let replyMarkup;
      let tokenForThis = null;
      if (event.status === 'waiting') {
        tokenForThis = approvalTokens.issue(slug, null, text);
        replyMarkup = approvalKeyboard(tokenForThis);
      }
      try {
        const result = await sendMessage({
          botToken, chatId, text, forumTopicId: topicForSlug(slug), replyMarkup,
        });
        if (result?.message_id) {
          replyTracker.record(result.message_id, slug);
          if (tokenForThis) approvalTokens.setMessageId(tokenForThis, result.message_id);
        }
        recentMessages.push(slug, { kind: 'event', text });
        log(`sent ${slug}: ${event.status} (${text.length} chars, msg ${result?.message_id}${tokenForThis ? `, +approval-buttons` : ''})`);
      } catch (err) {
        if (tokenForThis) approvalTokens.revoke(tokenForThis);
        log(`send failed for ${slug}: ${err.message}`);
      }
    },
  });

  // Optional rollup digest mode (#11). Slugs with subscriptions[slug].digest
  // bypass the per-event throttle and feed into a per-slug rollup buffer
  // that flushes after `digestIdleMs` of quiet (or `digestWindowMs` cap).
  // Flush body lives in lib/digest-flush.js for testability.
  const digestFlush = makeDigestFlush({
    promptCap: config.promptCap,
    responseCap: config.responseCap,
    summarizeBatchFn: anthropicApiKey ? maybeSummarizeBatch : null,
    send: ({ slug, text }) => sendMessage({ botToken, chatId, text, forumTopicId: topicForSlug(slug) }),
    recordReply: (msgId, slug) => replyTracker.record(msgId, slug),
    recordRecent: (slug, entry) => recentMessages.push(slug, entry),
    log,
  });
  const digest = new Digest({
    idleMs: config.digestIdleMs,
    windowMs: config.digestWindowMs,
    flush: digestFlush,
  });

  watcher = new StatusWatcher({
    onUpdate: ({ slug, statusFile, prevStatusFile }) => {
      const newStatus = statusFile?.status;
      const prevStatus = prevStatusFile?.status;
      if (typeof newStatus !== 'string') return;

      // Auto-reply path: independent of subscriptions and throttle. If this
      // slug owes Telegram a reply (an inbound message routed in earlier)
      // and the session has now produced a fresh last_response, quote-reply
      // it back. Pure function in lib/auto-reply.js; tested in isolation.
      maybeAutoReply({
        slug,
        statusFile,
        prevStatusFile,
        newStatus,
        getOwesReply: (s) => registry.getOwesReply(s),
        clearOwesReply: (s) => registry.clearOwesReply(s),
        sendOutbound,
        log,
      });

      if (!shouldFire(config, slug, prevStatus, newStatus)) return;
      const event = { status: newStatus, event: statusFile.event, statusFile };
      if (isDigested(config, slug)) {
        digest.enqueue(slug, event);
      } else {
        throttle.enqueue(slug, event);
      }
    },
    log,
  });
  watcher.start();
  log('belfry up');

  const shutdown = async (signal) => {
    log(`received ${signal} — shutting down`);
    throttle.clearAll();
    await digest.flushAll();
    await poller.stop();
    await registry.stop();
    await watcher.stop();
    replyTracker.flush(); // sync flush of any debounced setImmediate save
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Drop attachment files older than 24h. Best-effort — log on failure
 * rather than blocking startup. The receiving session has either consumed
 * the path or moved on by then; we don't track that signal so use a wall
 * clock cap.
 */
function gcOldAttachments(dir, log) {
  const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet or unreadable; created on first download
  }
  const now = Date.now();
  let dropped = 0;
  for (const name of names) {
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (now - stat.mtimeMs > ATTACHMENT_TTL_MS) {
      try {
        unlinkSync(full);
        dropped++;
      } catch (err) {
        log(`gc attachments: failed to unlink ${full}: ${err.message}`);
      }
    }
  }
  if (dropped > 0) log(`gc attachments: dropped ${dropped} file(s) older than 24h`);
}

/**
 * Read or generate the registry auth token. Persisted so daemon restarts
 * don't break already-running spokes — they cache the token at startup.
 */
function ensureAuthToken(tokenPath) {
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') log(`auth token read failed (${err.message}) — regenerating`);
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  log(`auth token written to ${tokenPath}`);
  return token;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log(`fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
