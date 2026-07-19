#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { loadConfig, isSubscribed, isSummarized, isDigested, topicFor, topicSlugMap, meshTelegramMode } from '../lib/config.js';
import { StatusWatcher } from '../lib/watcher.js';
import { Throttle } from '../lib/throttle.js';
import { Digest } from '../lib/digest.js';
import { compose } from '../lib/composer.js';
import {
  sendMessage as rawSendMessage,
  sendDocument as rawSendDocument,
  setMessageReaction as rawSetMessageReaction,
  editMessageText as rawEditMessageText,
  downloadFile,
} from '../lib/telegram.js';
import { SendQueue, DEFAULT_SEND_INTERVAL_MS } from '../lib/send-queue.js';
import { ReplyTracker } from '../lib/reply-tracker.js';
import { Registry } from '../lib/registry.js';
import { Poller } from '../lib/poller.js';
import { makeDeliveryTarget } from '../lib/delivery-target.js';
import { maybeAutoReply } from '../lib/auto-reply.js';
import { makeBrainSummarizers } from '../lib/brain-summarize.js';
import { makeStatusHandler } from '../lib/status-handler.js';
import { makeDigestFlush } from '../lib/digest-flush.js';
import { NicknameRegistry } from '../lib/nicknames.js';
import { makeNickHandler } from '../lib/nick-handler.js';
import { makeHelpHandler } from '../lib/help-handler.js';
import { RecentMessages } from '../lib/recent-messages.js';
import { makeAgentHandler } from '../lib/agent-handler.js';
import { ApprovalTokens } from '../lib/approval-tokens.js';
import { makeApprovalHandler } from '../lib/approval-handler.js';
import { approvalKeyboard } from '../lib/telegram.js';
import { makeResumeHandler } from '../lib/resume-handler.js';
import { BrainSupervisor } from '../lib/brain.js';
import { BRAIN_SYSTEM_PROMPT } from '../lib/brain-prompt.js';
import { makeBrainHandlers } from '../lib/brain-handlers.js';
import { OversizeCache } from '../lib/oversize-cache.js';
import { packForTelegram } from '../lib/pack.js';
import { chunkParagraphAware } from '../lib/chunk.js';
import { makeVoiceHandler } from '../lib/voice.js';
import { PingDedup } from '../lib/ping-dedup.js';
import { resolveReactionConfig } from '../lib/reactions.js';
import { BroadcastTracker, DEFAULT_BROADCAST_TIMEOUT_MS } from '../lib/broadcast-tracker.js';
import { buildBroadcastSummary } from '../lib/broadcast-summary.js';
import { AgentRelayGuard } from '../lib/agent-relay-guard.js';
import { parseFederationConfig } from '../lib/federation-config.js';
import { wireFederation, DEFAULT_FED_PORT } from '../lib/federation-daemon.js';
import { TelegramOwner } from '../lib/federation-owner.js';
import { parseBridges } from '../lib/bridge.js';
import { SubscriptionsStore } from '../lib/subscriptions-store.js';
import { makeTap } from '../lib/wintermute-tap.js';
import { makeWatchHandler } from '../lib/watch-handler.js';
import { answerCallbackQuery as rawAnswerCallbackQuery } from '../lib/telegram.js';

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

  // Live, persisted watch overrides (#40 — /watch from Telegram). Layers a
  // machine-managed overrides file over the hand-edited belfry.jsonc and mutates
  // config.subscriptions IN PLACE, so /watch toggles apply immediately (no
  // restart) and the daemon's shouldFire reads the live state.
  const subscriptionsStore = new SubscriptionsStore({ subscriptions: config.subscriptions, log });

  const botToken = (process.env.BELFRY_TOKEN ?? '').trim();
  const chatId = (process.env.BELFRY_CHAT_ID ?? '').trim();
  const forumTopicId = (process.env.BELFRY_FORUM_TOPIC_ID ?? '').trim();
  const mcpPort = Number(process.env.BELFRY_MCP_PORT || 49876);
  const transcribeKey = (process.env.BELFRY_TRANSCRIBE_KEY ?? '').trim();
  const transcribeProvider = (process.env.BELFRY_TRANSCRIBE_PROVIDER ?? '').trim() || undefined;
  // Wintermute message-flow tap (#49): metadata-only flow events to the fleet
  // control plane. Off unless WINTERMUTE_TAP_URL is set; a bad URL disables the
  // tap loudly rather than crashing the daemon.
  let tap = null;
  try {
    tap = makeTap({
      url: (process.env.WINTERMUTE_TAP_URL ?? '').trim() || null,
      token: (process.env.WINTERMUTE_TAP_TOKEN ?? '').trim() || null,
      host: (process.env.BELFRY_HOST_LETTER ?? '').trim() || hostname().toLowerCase(),
      log,
    });
    if (tap) log(`wintermute-tap: emitting flow events to ${(process.env.WINTERMUTE_TAP_URL ?? '').trim()}`);
  } catch (err) {
    log(`wintermute-tap: invalid config (${err.message}) — tap disabled`);
  }
  // Federation-only mode (#29): this node participates ONLY in the cross-host
  // a2a mesh — it runs the loopback registry + the /fed listener but NEVER polls
  // Telegram. A peer host (e.g. Erebus) that has no Telegram role must not start
  // the poller: Telegram allows one getUpdates owner per bot, and the floating
  // election would otherwise hand inbound replies to a daemon with no sessions
  // to route them to. So in this mode we skip the poller, the outbound dashboard
  // watcher, and the brain — the whole Telegram side — and serve the mesh only.
  const fedOnly = /^(1|true|yes|on)$/i.test((process.env.BELFRY_FED_ONLY ?? '').trim());
  if (!botToken || !chatId) {
    // A federation-only node has no Telegram role, so it doesn't need the bot
    // token to run — it's a pure multi-agent mesh node (registry + /fed). Only
    // a Telegram-serving daemon requires the credentials.
    if (!fedOnly) {
      log('missing BELFRY_TOKEN and/or BELFRY_CHAT_ID env vars — relay disabled');
      log('see README.md for setup. Common pattern: a launcher script reads from your secret store and exec-s belfry with the env vars set.');
      process.exit(1);
    }
    log('BELFRY_FED_ONLY with no BELFRY_TOKEN/CHAT_ID — running as a pure mesh node (registry + federation only, no Telegram)');
  } else {
    log(`telegram bot configured (chat ${chatId}${forumTopicId ? `, topic ${forumTopicId}` : ''})`);
  }
  if (fedOnly) log('BELFRY_FED_ONLY set — federation-only node: Telegram poller, watcher and brain disabled (mesh only)');

  // Single serial pacer for every outbound Telegram write (#35). belfry sends
  // to one chat, whose per-chat rate limit a `/all` fan-out (N replies + N
  // reaction swaps + pings, all near-simultaneous) blows straight past → 429.
  // Funnelling sendMessage/editMessageText/setMessageReaction through one queue
  // turns the burst into a paced stream and honours the 429 retry_after instead
  // of dropping the message. The wrappers shadow the imported names, so every
  // existing call site downstream is paced with no further changes. Base
  // interval is BELFRY_SEND_INTERVAL_MS (default 1.1s, safe for ~1 msg/s); on a
  // 429 the queue self-tunes up to the server's retry_after (≈3s for groups).
  const sendIntervalOverride = Number(process.env.BELFRY_SEND_INTERVAL_MS);
  const sendQueue = new SendQueue({
    minIntervalMs: sendIntervalOverride > 0 ? sendIntervalOverride : DEFAULT_SEND_INTERVAL_MS,
    log,
  });
  log(`send pacing: ${sendQueue.minIntervalMs}ms base interval, 429 retry_after honoured`);
  const sendMessage = (args) => sendQueue.enqueue(() => rawSendMessage(args), { label: 'sendMessage' });
  const sendDocument = (args) => sendQueue.enqueue(() => rawSendDocument(args), { label: 'sendDocument' });
  // Outbound file limits (#files): Telegram caps documents at 50MB / photos at
  // 10MB; we cap at 50MB and at a sane count per reply to bound a runaway model.
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_FILES_PER_REPLY = 10;
  const setMessageReaction = (args) => sendQueue.enqueue(() => rawSetMessageReaction(args), { label: 'setMessageReaction' });
  const editMessageText = (args) => sendQueue.enqueue(() => rawEditMessageText(args), { label: 'editMessageText' });

  // Per-slug summarizer / digest opt-in via subscriptions[slug].summarize.
  // Both run via the brain subprocess (subscription auth — see lib/brain.js).
  const enabledSummarizeSlugs = Object.entries(config.subscriptions)
    .filter(([, s]) => s.summarize)
    .map(([slug]) => slug);
  if (enabledSummarizeSlugs.length > 0) {
    log(`summarizer enabled for ${enabledSummarizeSlugs.length} slug(s): ${enabledSummarizeSlugs.join(', ')}`);
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

  // One chokepoint for "this outbound message_id belongs to a LOCAL session
  // slug": persist it locally AND gossip the anchor to peers so whichever host
  // owns the bot can resolve a quote-reply to it and forward the reply back
  // (#38 Fornax-flip prerequisite). EVERY outbound sender — replies, status
  // pings, /status digests, full-expand, rollup digests — records through here,
  // centralized so a new send path can't silently skip the sync (the status-
  // ping path originally did, which is exactly the message users quote-reply).
  // syncReplyMap self-guards (live-local-slug only; skips qualified/daemon
  // slugs); `federation` is read at call time (assigned later in startup).
  const recordReplyAnchor = (messageId, slug) => {
    replyTracker.record(messageId, slug);
    federation?.syncReplyMap?.(messageId, slug);
  };

  // Auth token: random 32-byte hex written 0600 to the state dir. Spokes
  // read it from the same path. Without this, any local user/process could
  // /register an arbitrary slug and drain another session's Telegram replies.
  const tokenPath = join(stateDir, 'registry.token');
  const authToken = ensureAuthToken(tokenPath);

  // Scratch directory for inbound attachments (Telegram photos downloaded
  // for forwarding to sessions). 0700 dir, 0600 files —
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

  // Late-bound BrainSupervisor reference. The pack pipeline inside
  // `sendOutbound` (defined below) needs to consult the brain; brain
  // construction itself depends on the registry's port + token which
  // aren't known until later, so we declare the binding here and assign
  // once the supervisor is built. Closures resolve `brain` at call time,
  // by which point the assignment has happened.
  let brain = null;

  // Per-slug dedup for ready pings (content equality + reply-tool echo
  // suppression). Hoisted above sendOutbound so the reply path can stash
  // the just-sent text synchronously — see lib/ping-dedup.js.
  const pingDedup = new PingDedup();

  // Routing-status emoji reactions (#32): 👀 delivered / 🤷 dropped / 🤔
  // unmatched on the inbound (fired by the poller), and 🫡 replied — swapped
  // onto the originating message by sendOutbound when the session answers.
  // Resolved from env (default on); see lib/reactions.js. Hoisted above
  // sendOutbound so the reply path can read reactEmoji.replied.
  const reactEmoji = resolveReactionConfig(process.env);
  if (reactEmoji) {
    log(`reactions on (delivered=${reactEmoji.delivered ?? '-'} dropped=${reactEmoji.dropped ?? '-'} unmatched=${reactEmoji.unmatched ?? '-'} replied=${reactEmoji.replied ?? '-'})`);
  }

  // Broadcast completion tracking (#30). When a /all fans out, each reached
  // session is instructed to answer succinctly; the tracker collects those
  // replies (tapped in sendOutbound below) and fires `onComplete` once every
  // session has answered OR a timeout elapses — at which point the daemon
  // posts an aggregated roll-up threaded under the broadcast.
  // A non-positive / unparseable override falls back to the default (and an
  // explicit 0 can't accidentally disable the timeout, which would leak
  // trackers forever).
  const broadcastTimeoutOverride = Number(process.env.BELFRY_BROADCAST_TIMEOUT_MS);
  const BROADCAST_TIMEOUT_MS = broadcastTimeoutOverride > 0 ? broadcastTimeoutOverride : DEFAULT_BROADCAST_TIMEOUT_MS;
  if (BROADCAST_TIMEOUT_MS !== DEFAULT_BROADCAST_TIMEOUT_MS) {
    log(`broadcast: completion timeout overridden to ${BROADCAST_TIMEOUT_MS}ms`);
  }
  async function sendBroadcastSummary({ messageId, expected, responses, missing, timedOut }) {
    await sendMessage({
      botToken, chatId,
      text: buildBroadcastSummary({ expected, responses, missing, timedOut }),
      forumTopicId: forumTopicId || null,
      replyToMessageId: messageId,
    });
  }
  const broadcastTracker = new BroadcastTracker({
    defaultTimeoutMs: BROADCAST_TIMEOUT_MS,
    onComplete: (result) => {
      sendBroadcastSummary(result).catch((err) => log(`broadcast summary failed (msg ${result.messageId}): ${err.message}`));
    },
  });

  // Resolve the topic to send a slug's outbound messages into. Per-slug
  // subscription override → BELFRY_FORUM_TOPIC_ID env fallback → main chat.
  const topicForSlug = (slug) => topicFor(config, slug) ?? (forumTopicId || null);

  // Outbound dispatcher used by both the spoke `reply` tool (via /send) and
  // the auto-reply path below. Records the new message_id in the reply
  // tracker so subsequent quote-replies on this thread route correctly.
  // Per-slug forum topic override means the right session's topic gets the
  // reply (when configured); otherwise the daemon-level fallback applies.
  //
  // Oversize handling: if the reply doesn't fit one Telegram message we
  // pack it via the brain (or paragraph-truncate as fallback), stash the
  // original in `oversizeCache`, and append a "Reply 'full' for the
  // complete response" footer. The user can later quote-reply with "full"
  // to retrieve the original chunked across multiple messages.
  const oversizeCache = new OversizeCache({ max: 50 });
  // Reserve room for the footer plus a small buffer for the ID-suffix
  // wording. The pack helper takes `reservedFooterChars` and aims for
  // (limit - reserved) chars of body.
  const TELEGRAM_TEXT_CAP = 4096;
  const FULL_FOOTER = '\n\n↩ Reply "full" to this message for the complete response';
  // Project-tag prefix for every outbound reply. The user reads Telegram
  // and needs a one-glance answer to "which session is talking to me right
  // now?" — slug-tagged for session replies, "daemon:" for daemon-level
  // sends (brain, /status, command handlers).
  const replyHeader = (slug) => `${slug || 'daemon'}:\n\n`;
  const sendOutbound = async ({ slug, text = '', replyToMessageId, files }) => {
    // Arm the echo muzzle SYNCHRONOUSLY before any await. The sync prefix
    // of an async function runs in the calling tick, so a same-tick
    // `onUpdate` → `shouldSkip` (the auto-reply path) sees the muzzle
    // before its own check. v0.1.5: drops v0.1.4's text-equality stash
    // because the reply-tool `text` arg is never byte-identical to the
    // Stop-hook-derived `last_response` — time proximity is the right
    // invariant. See lib/ping-dedup.js.
    pingDedup.muzzleNext(slug);
    const fileList = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f) : [];
    let firstMessageId = null;

    // 1) Text (if any) — the existing packed path. Skipped for a files-only reply.
    if (typeof text === 'string' && text.length > 0) {
      const header = replyHeader(slug);
      const packTrigger = TELEGRAM_TEXT_CAP - FULL_FOOTER.length - header.length;
      let toSend = header + text;
      let stashOriginal = null;
      let packMode = null;
      if (text.length > packTrigger) {
        const packed = await packForTelegram(text, {
          brain,
          limit: TELEGRAM_TEXT_CAP,
          reservedFooterChars: FULL_FOOTER.length + header.length,
          log,
        });
        toSend = header + packed.text + FULL_FOOTER;
        stashOriginal = text;
        packMode = packed.mode;
      }
      const result = await sendMessage({
        botToken, chatId, text: toSend, forumTopicId: topicForSlug(slug), replyToMessageId,
      });
      if (result?.message_id) {
        firstMessageId = result.message_id;
        recordReplyAnchor(result.message_id, slug);
        if (stashOriginal) oversizeCache.put(result.message_id, slug, stashOriginal);
      }
      recentMessages.push(slug, { kind: 'outbound', text: toSend });
      const packTag = packMode ? `, packed=${packMode} (orig ${text.length}→${toSend.length})` : '';
      log(`sent ${slug}: outbound reply (${toSend.length} chars, msg ${result?.message_id}${replyToMessageId ? `, in reply to ${replyToMessageId}` : ''}${packTag})`);
    }

    // 2) Files (if any) — each as its own message threaded to the same
    // originating message. Best-effort per file: a missing/oversized/failed
    // file is logged and skipped, never aborting the rest of the reply.
    for (const fp of fileList.slice(0, MAX_FILES_PER_REPLY)) {
      try {
        const st = statSync(fp);
        if (!st.isFile()) { log(`file skip (not a regular file): ${fp}`); continue; }
        if (st.size > MAX_FILE_BYTES) { log(`file skip (>${MAX_FILE_BYTES}B): ${fp}`); continue; }
        const fres = await sendDocument({
          botToken, chatId, filePath: fp, forumTopicId: topicForSlug(slug), replyToMessageId,
        });
        if (fres?.message_id) {
          if (firstMessageId === null) firstMessageId = fres.message_id;
          recordReplyAnchor(fres.message_id, slug);
        }
        log(`sent ${slug}: file ${fp.split('/').pop()} (msg ${fres?.message_id})`);
      } catch (err) {
        log(`file send failed (${fp}): ${err.message}`);
      }
    }

    const result = { message_id: firstMessageId };
    // Message-flow tap (#49): one event per outbound send, metadata only.
    tap?.('send', { from: slug || 'daemon', chars: typeof text === 'string' ? text.length : 0, files: fileList.length });
    // Swap the originating inbound's routing-status reaction to the 'replied'
    // emoji (🫡 by default) now that the session has answered — the 👀 ack
    // becomes a visible "done" marker. Only when reactions are on, a 'replied'
    // emoji is configured, and we threaded to an originating message. In the
    // normal path `replyToMessageId` comes from the registry's owes-reply
    // marker, which is set only for delivered inbounds that got the 👀, so
    // 🤷/🤔 messages never get swapped. (A spoke could in theory pass an
    // explicit reply_to_message_id that bypasses the marker — the current
    // belfry-mcp never does; if one did, the swap would land on whatever it
    // named.) Fire-and-forget: a failed swap must never affect the reply that
    // already went out.
    if (firstMessageId !== null && reactEmoji?.replied && typeof replyToMessageId === 'number' && replyToMessageId > 0) {
      setMessageReaction({ botToken, chatId, messageId: replyToMessageId, emoji: reactEmoji.replied })
        .catch((err) => log(`reaction swap failed (msg ${replyToMessageId}): ${err.message}`));
    }
    // If this reply answers an in-flight broadcast (its originating message is
    // the broadcast anchor), record it toward the completion roll-up. The
    // individual reply still goes out — the summary is additive, not a
    // replacement. record() is a cheap no-op for non-broadcast replies.
    if (typeof replyToMessageId === 'number' && replyToMessageId > 0) {
      broadcastTracker.record(replyToMessageId, slug, text);
    }
    return { message_id: result?.message_id };
  };

  // /full expansion. When the user quote-replies "full" on a stashed
  // oversized message, redeliver the original chunked into Telegram-
  // sized messages (paragraph-aware splits). First chunk threads as a
  // reply to the user's "full" message so the conversation stays linked;
  // subsequent chunks thread under the previously-sent chunk so they
  // arrive in order without spamming reply-icons.
  const fullExpandHandler = async ({ targetMessageId, messageId }) => {
    const entry = oversizeCache.get(targetMessageId);
    if (!entry) {
      log(`full-expand: no stash for msg ${targetMessageId} (already expanded or expired)`);
      return;
    }
    const chunks = chunkParagraphAware(entry.text, TELEGRAM_TEXT_CAP);
    let prevId = messageId;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const result = await sendMessage({
          botToken,
          chatId,
          text: chunk,
          forumTopicId: topicForSlug(entry.slug),
          replyToMessageId: prevId,
        });
        if (result?.message_id) {
          recordReplyAnchor(result.message_id, entry.slug);
          prevId = result.message_id;
        }
      } catch (err) {
        log(`full-expand: chunk ${i + 1}/${chunks.length} for msg ${targetMessageId} failed: ${err.message}`);
        return;
      }
    }
    oversizeCache.delete(targetMessageId);
    log(`full-expand: sent ${chunks.length} chunk(s) for msg ${targetMessageId} (${entry.text.length} chars total)`);
  };

  // Agent-to-agent relay flood/loop guard (#36): bounds runaway session↔session
  // ping-pong from the daemon side, independent of the models.
  const relayGuard = new AgentRelayGuard();
  // Local /broadcast policy (2026-07-08): closed unless explicitly reopened.
  // Broadcast is a Wintermute-only capability on the mesh (/fed/broadcast +
  // broadcastHosts allowlist); the human's /all is unaffected (chat-ID gated).
  const allowLocalBroadcast = /^(1|true|yes|on)$/i.test((process.env.BELFRY_BROADCAST_LOCAL ?? '').trim());
  if (allowLocalBroadcast) log('local /broadcast route ENABLED (BELFRY_BROADCAST_LOCAL) — the belfry-broadcast CLI works on this host');
  const registry = new Registry({ port: mcpPort, log, authToken, onSend: sendOutbound, relayGuard, allowLocalBroadcast });
  if (tap) registry.setTap(tap);
  await registry.start();

  // Broadcast orchestrator (#30). Shared by the Telegram `/all` path (poller)
  // and the local CLI (`POST /broadcast` → bin/belfry-broadcast.js). Fans the
  // text out to every registered session, threads each session's reply under a
  // single anchor message, seeds the completion tracker, and posts a
  // confirmation. Returns { count, slugs } for the caller.
  //
  // The anchor is the user's `/all` message for the Telegram path; CLI
  // broadcasts have no originating message, so we send a placeholder
  // confirmation first and use its id as the anchor (edited with the real
  // count after fan-out). broadcast() + markOwesReply + tracker.start run
  // synchronously after any anchor-establishing await, so no session reply can
  // be processed before the threading + tracker are in place.
  const onBroadcast = async ({ text, targetSlugs = null, excludeSlugs = null, messageId = null, source = 'telegram', quiet = false }) => {
    let anchorId = messageId;
    let cliPlaceholder = false;
    // Anchorless (CLI/script) broadcast with nobody to reach: answer in the
    // HTTP response + log only — no placeholder, no "no sessions registered"
    // on the human's phone. Headless agents ping /broadcast for progress (and
    // sometimes target a slug that lives on another host, where the filter
    // matches nothing); each such no-op was two Telegram messages of pure
    // noise (2026-07-08: an Erebus driver produced 13 in 20 minutes). A human
    // /all keeps its in-chat confirmation even at 0 — they asked in the chat.
    // Precount, not reorder: the anchor must still exist before fan-out so no
    // session reply can beat the threading + tracker setup.
    if (!anchorId && registry.matchBroadcast({ targetSlugs, excludeSlugs }) === 0) {
      const { count, slugs } = registry.broadcast(text, { targetSlugs, excludeSlugs });
      log(`broadcast (${source}) → ${count} session(s) — no recipients, Telegram confirmation suppressed`);
      return { count, slugs };
    }
    if (!anchorId) {
      try {
        const r = await sendMessage({ botToken, chatId, text: '📡 broadcasting…', forumTopicId: forumTopicId || null });
        anchorId = r?.message_id ?? null;
        cliPlaceholder = true;
      } catch (err) {
        log(`broadcast: placeholder send failed: ${err.message}`);
      }
    }
    const { count, slugs } = registry.broadcast(text, { targetSlugs, excludeSlugs });
    // Fire-and-forget (`/all!`): fan the command out but DON'T mark every
    // session as owing a reply or seed the completion tracker. A command-
    // broadcast (e.g. compress) otherwise makes all N sessions auto-reply at
    // once → the chat 429s. Quiet mode trades the per-session replies + roll-up
    // for a single confirmation. (The fresher-inbound-supersedes note below
    // applies to the normal, reply-collecting path.)
    if (anchorId && count > 0 && !quiet) {
      // markOwesReply overwrites any prior pending marker for the slug, so a
      // session mid-directed-turn that's caught in a broadcast will thread its
      // next reply under the broadcast anchor (the "fresher inbound supersedes"
      // contract). Acceptable: the broadcast is the newest inbound.
      for (const slug of slugs) registry.markOwesReply(slug, anchorId);
      broadcastTracker.start(anchorId, { expectedSlugs: slugs, timeoutMs: BROADCAST_TIMEOUT_MS });
    }
    const confirm = count > 0
      ? `📡 broadcast${quiet ? ' (fire-and-forget)' : ''} to ${count} session(s): ${slugs.join(', ')}`
      : '📡 broadcast — no sessions registered';
    try {
      if (cliPlaceholder && anchorId) {
        await editMessageText({ botToken, chatId, messageId: anchorId, text: confirm });
      } else {
        await sendMessage({ botToken, chatId, text: confirm, forumTopicId: forumTopicId || null, replyToMessageId: anchorId ?? undefined });
      }
    } catch (err) {
      log(`broadcast: confirmation failed: ${err.message}`);
    }
    log(`broadcast (${source}) → ${count} session(s): ${slugs.join(', ') || '—'}${anchorId ? `, anchor ${anchorId}` : ''}`);
    return { count, slugs };
  };
  registry.setBroadcastHandler(onBroadcast);

  // Federation (#29): the cross-machine agent mesh. OFF unless a host letter is
  // configured (env BELFRY_HOST_LETTER or the belfry.jsonc `federation` block),
  // so every single-host deployment is byte-for-byte unchanged. When on, we
  // start a fail-closed /fed/* listener on the tailnet interface, attach the
  // remote-`send_to` router to the registry, gossip our local slug set to peers,
  // and run the floating Telegram-owner election in the poller (a 409 standby
  // instead of one daemon hogging the bot). A bad config or a failed listener
  // start is logged and swallowed — the daemon keeps serving locally.
  let federation = null;
  let telegramOwner = null;
  let fedConfig = { enabled: false };
  // The local identity the bot wears on the mesh for human→federated-session DMs
  // (#44). A peer reply addressed to this slug is posted to the chat rather than
  // injected into a (nonexistent) local session. Configurable; default "telegram".
  const fedBridgeSlug = (config.federation && typeof config.federation.telegramBridgeSlug === 'string'
    && config.federation.telegramBridgeSlug.trim()) || 'telegram';
  try {
    fedConfig = parseFederationConfig({ env: process.env, file: config.federation });
  } catch (err) {
    log(`federation: invalid config (${err.message}) — federation disabled`);
  }
  if (fedConfig.enabled && !fedConfig.token) {
    log('federation: host letter set but BELFRY_FED_TOKEN missing — refusing an unauthenticated mesh listener; federation disabled');
  } else if (fedConfig.enabled) {
    const fedBind = (process.env.BELFRY_FED_BIND ?? '').trim() || '127.0.0.1';
    const fedPortEnv = Number(process.env.BELFRY_FED_PORT);
    const fedPort = fedPortEnv > 0 ? fedPortEnv : DEFAULT_FED_PORT;
    // Webhook bridges (#29 Phase C): map a slug to a headless agent's HTTP
    // endpoint so the mesh can deliver to it (and route its replies back).
    let bridges = new Map();
    try {
      bridges = parseBridges({ env: process.env, file: config.bridges });
      if (bridges.size) log(`federation: ${bridges.size} webhook bridge(s): ${[...bridges.keys()].join(', ')}`);
    } catch (err) {
      log(`federation: invalid bridge config (${err.message}) — bridges disabled`);
    }
    try {
      // The owner state machine is created BEFORE wireFederation so the gossip
      // loop can advertise its `reachableAt` and the priority gate can read it
      // (#38). The same instance is handed to the Poller below.
      telegramOwner = new TelegramOwner();
      federation = await wireFederation({
        registry,
        fedConfig,
        relayGuard,
        bridges,
        // Return leg of a human→federated-session DM (#44): a peer reply to the
        // bridge slug is posted to the chat via the normal outbound path, which
        // records the reply-tracker mapping so a quote-reply continues the thread.
        telegramBridge: {
          slug: fedBridgeSlug,
          deliver: async (fromQualified, text) => {
            await sendOutbound({ slug: fromQualified, text, replyToMessageId: null });
            return { delivered: 1 };
          },
        },
        owner: telegramOwner,
        // #38 Fornax-flip prerequisite — record a peer's gossiped reply-tracker
        // anchor host-qualified, so a quote-reply to a remote session's ping
        // that lands on this (bot-owning) host resolves and forwards back.
        recordReplyMap: (msgId, qualifiedSlug) => replyTracker.record(msgId, qualifiedSlug),
        // Fleet fan-out from an authorized mesh agent (wintermute-only policy).
        // Allowlist gate runs in the federation daemon; by the time this fires
        // the requester is authorized. source carries the requesting identity
        // so the log + confirmation say who broadcast.
        onFedBroadcast: ({ text, targetSlugs, excludeSlugs, from }) =>
          onBroadcast({ text, targetSlugs, excludeSlugs, messageId: null, source: `fed:${from}` }),
        // Inbound-attachment leg (#41 across the mesh): a forwarded photo or
        // document arrives as a Telegram file_id; download it locally with
        // this host's own bot token (file access is not owner-exclusive) so
        // the session gets a path on this disk. Cred-less nodes leave it null.
        downloadAttachment: (botToken && chatId)
          ? ({ fileId, kind, name }) => downloadFile({
              botToken,
              fileId,
              destDir: attachmentDir,
              destName: `${kind === 'photo' ? 'photo' : 'doc'}-fed-${Date.now()}${name ? `-${name.replace(/[^\w.-]/g, '_').replace(/\.[^.]*$/, '').slice(0, 60)}` : ''}`,
            })
          : null,
        bind: fedBind,
        port: fedPort,
        log,
        tap,
      });
      federation.startGossip();
      const prio = fedConfig.priority == null ? 'unprioritized' : `priority ${fedConfig.priority}`;
      log(`federation: enabled as host "${fedConfig.hostName}" (${fedConfig.hostLetter}); telegram-owner election active (${prio})`);
    } catch (err) {
      log(`federation: failed to start (${err.message}) — continuing without the mesh`);
      federation = null;
      telegramOwner = null;
    }
  }

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

  // /watch control panel (#40): manage proactive-ping subscriptions from
  // Telegram — a tap-toggle keyboard + /watch /unwatch /watching commands,
  // applied live via subscriptionsStore. Menu lists every known slug (dashboard
  // ∪ registry) plus anything currently watched. answerCallbackQuery is called
  // direct (not paced) so the button's spinner dismisses promptly; the in-place
  // keyboard re-render goes through the paced editMessageText.
  const watchHandler = makeWatchHandler({
    store: subscriptionsStore,
    getSlugs: () => {
      const s = new Set();
      if (watcher) for (const x of watcher.getActiveSlugs()) s.add(x);
      for (const x of registry.knownSlugs()) s.add(x);
      // Fleet-wide discovery (#47 Tier 1): list peer-owned sessions as
      // `<letter>/<slug>` so they appear in the /watch menu alongside local ones.
      if (federation) for (const x of federation.remoteSlugs()) s.add(x);
      return s;
    },
    send: ({ text, replyToMessageId, replyMarkup }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId, replyMarkup }),
    editMessage: ({ messageId, text, replyMarkup }) =>
      editMessageText({ botToken, chatId, messageId, text, replyMarkup }),
    answerCallback: ({ callbackQueryId, text }) =>
      rawAnswerCallbackQuery({ botToken, callbackQueryId, text }),
    log,
  });

  // Brain-backed summarizers. Constructed here so statusHandler can reference
  // them; they close over the `brain` variable (which is constructed below)
  // and use it lazily — every call resolves brain.isAlive() fresh.
  const brainSummarizers = { summarize: async () => null, summarizeBatch: async () => null };
  const maybeSummarize = (args) => brainSummarizers.summarize(args);
  const maybeSummarizeBatch = (args) => brainSummarizers.summarizeBatch(args);
  const statusHandler = makeStatusHandler({
    summarizeFn: maybeSummarize,
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    // For single-slug /status, record the digest message_id against the
    // slug so a follow-up quote-reply lands on the same session.
    // All-slugs digests pass slug=null inside the handler and skip recording.
    recordReply: (msgId, slug) => recordReplyAnchor(msgId, slug),
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

  // /resume — lists recent sessions per slug; for /resume <slug> <uuid>,
  // emits a copyable launch command (or executes BELFRY_RESUME_LAUNCHER
  // if configured — opt-in, lets users wire tmux automation themselves).
  const resumeHandler = makeResumeHandler({
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    resolveNickname: (token) => nicknames.resolve(token),
    launcherCmd: (process.env.BELFRY_RESUME_LAUNCHER ?? '').trim() || null,
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
  //
  // Brain subprocess: spawned at startup, owns all language work. The
  // agent handler simply forwards CLASSIFY prompts to the brain and falls
  // back to "language layer is down" when isAlive() is false. The brain
  // takes user-visible actions (reply / deliver / decline) via its MCP
  // tools, dispatching through the daemon's /brain/* endpoints.
  const brainDir = join(stateDir, 'brain');
  mkdirSync(brainDir, { recursive: true, mode: 0o700 });
  const brainMcpConfigPath = join(brainDir, '.mcp.json');
  writeFileSync(
    brainMcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          // Server name is flat-alphanumeric ("belfrybrain") so the tool
          // names register as mcp__belfrybrain__* without claude's
          // hyphen→underscore transform — keeps the --allowedTools list
          // in lib/brain.js straightforward to maintain.
          belfrybrain: {
            command: 'node',
            args: [join(dirname(fileURLToPath(import.meta.url)), 'belfry-brain-mcp.js')],
            env: {
              BELFRY_MCP_BASE: `http://127.0.0.1:${mcpPort}`,
              BELFRY_BRAIN_TOKEN_PATH: tokenPath,
            },
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  brain = new BrainSupervisor({
    workdir: brainDir,
    mcpConfigPath: brainMcpConfigPath,
    systemPrompt: BRAIN_SYSTEM_PROMPT,
    log,
  });
  if (!fedOnly) {
    brain.start();
    log(`brain: spawned (cwd ${brainDir})`);
  }

  // Bind the brain-backed summarizers now that brain exists. The
  // closure-captured object reference threaded into statusHandler /
  // throttle / digestFlush above gets its methods replaced, so callers
  // see the live functions on first use.
  const realSummarizers = makeBrainSummarizers({ brain, log });
  brainSummarizers.summarize = realSummarizers.summarize;
  brainSummarizers.summarizeBatch = realSummarizers.summarizeBatch;

  // Wire the brain MCP plugin's tool handlers. The watcher is built later
  // in this main() — handlers receive a getter so they read it fresh each
  // call. Until the watcher is up, list_sessions / get_session return
  // empty (the brain handles that gracefully via its `recent_messages`
  // tool which uses the in-memory ring instead).
  const brainHandlers = makeBrainHandlers({
    getWatcher: () => watcher,
    getFederation: () => federation,
    recentMessages,
    nicknames,
    registry,
    sendTelegram: ({ text, replyToMessageId }) =>
      sendMessage({
        botToken,
        chatId,
        text: `${replyHeader(null)}${text}`,
        forumTopicId,
        replyToMessageId,
      }),
    // #34: when the brain routes a message the deterministic router marked 🤔,
    // upgrade the originating reaction to reflect the real outcome. Mirrors the
    // poller's reactToRouting — fire-and-forget, no-op when reactions are off.
    reactRouting: reactEmoji
      ? (messageId, outcome) => {
          const emoji = reactEmoji[outcome];
          if (!emoji || typeof messageId !== 'number' || messageId <= 0) return;
          setMessageReaction({ botToken, chatId, messageId, emoji })
            .catch((err) => log(`brain reaction upgrade failed (msg ${messageId}): ${err.message}`));
        }
      : null,
    log,
  });
  registry.setBrainHandlers(brainHandlers);

  const agentHandler = makeAgentHandler({
    brain,
    brainHandlers,
    send: ({ text, replyToMessageId }) =>
      sendMessage({ botToken, chatId, text, forumTopicId, replyToMessageId }),
    log,
  });

  // Forum-topic routing (#15). Per-slug topic IDs in subscriptions[slug].topic
  // get inverted at startup so the inbound poller can resolve a Telegram
  // message_thread_id back to the slug it belongs to in O(1).
  const topicMap = topicSlugMap(config);
  if (topicMap.size > 0) {
    log(`forum topics: ${topicMap.size} slug(s) bound to topic IDs`);
  }

  // Inbound voice notes (#19): when BELFRY_TRANSCRIBE_KEY is set, hand the
  // Telegram voice file to a Whisper-compatible provider (Groq by default)
  // and re-route the transcript as a normal text message. Without a key the
  // handler still runs — it replies once per voice note to say so, then
  // drops, so the user knows why nothing happened.
  const handleVoice = makeVoiceHandler({
    apiKey: transcribeKey,
    provider: transcribeProvider,
    botToken,
    attachmentDir,
    log,
  });
  const sendVoiceReply = async ({ text, replyToMessageId }) => {
    try {
      await sendMessage({
        botToken,
        chatId,
        text,
        forumTopicId,
        replyToMessageId,
      });
    } catch (err) {
      log(`voice reply failed: ${err.message}`);
    }
  };
  if (transcribeKey) {
    log(`voice transcription enabled (provider=${transcribeProvider ?? 'groq'})`);
  } else {
    log('voice transcription disabled (BELFRY_TRANSCRIBE_KEY not set) — voice notes will be acknowledged but dropped');
  }

  // Federation-aware delivery target (#44): a routed slug carrying a host prefix
  // (`<letter>/<slug>`) is a session on a peer host — forward it over the mesh
  // from the Telegram bridge identity so the reply routes back to this chat.
  // Bare slugs deliver locally exactly as before. The wrapper proxies the full
  // Poller `target` interface (deliver + hasSlug + knownSlugs); see
  // lib/delivery-target.js.
  const deliveryTarget = makeDeliveryTarget({ registry, federation, fedBridgeSlug, chatId: Number(chatId), log });

  // #38 Phase 2 return leg: when a remote session answers a HUMAN message that
  // was forwarded here, its /send routes through this handler. sendMessage is
  // non-exclusive, so this host sends the reply to the owner's chat directly
  // (no need to own the bot). Reuse sendOutbound — same chat (one bot, one
  // chat), so it quote-replies the owner's originating message, packs, swaps the
  // 👀→🫡 reaction, and records the reply-tracker, all for free.
  // Only wire it on a host that actually has Telegram creds: a sessionful
  // BELFRY_FED_ONLY mesh node (no bot token/chat) would otherwise sendMessage
  // with an undefined token and fail permanently. With the handler unset, /send
  // falls through to the safe local path.
  if (botToken && chatId) {
    const localChatId = Number(chatId);
    registry.setRemoteReplyHandler(async ({ slug, text, remote, files }) => {
      // The originatingMessageId is a message id in the OWNER's chat, quote-
      // replied here in THIS host's chat — correct only under the single-chat
      // fleet invariant (one bot, one chat). Guard it so a divergent-chat
      // misconfig fails loud (drops the quote) instead of silently misthreading.
      if (Number.isInteger(remote?.chatId) && remote.chatId !== localChatId) {
        log(`remote return-leg: forwarded chatId ${remote.chatId} != local ${localChatId} — sending unthreaded (fleet must share one chat)`);
        return sendOutbound({ slug, text, replyToMessageId: null, files });
      }
      return sendOutbound({ slug, text, replyToMessageId: remote.originatingMessageId, files });
    });

    // Same-host Telegram bridge (#44 completion): let a LOCAL session (or a
    // single-host deployment) send_to the bridge slug ("telegram" by default)
    // to deliberately message the human — the same address a federated peer
    // already reaches via send_to("<letter>/telegram"). Headered with the
    // sender's slug and reply-anchored, so a quote-reply routes back to it.
    registry.setHumanTarget({
      slug: fedBridgeSlug,
      deliver: (fromSlug, text) => sendOutbound({ slug: fromSlug, text, replyToMessageId: null }),
    });

    // Mesh mirror (#39, scoped): surface selected agent-to-agent traffic on
    // Telegram. Default is 'none' — the mesh stays off the phone — with
    // per-slug jsonc overrides (mesh.telegramOverrides) for agents the user
    // wants to see, e.g. wintermute. Fires receiver-side only (see
    // relayAgentMessage), so a fleet-wide deploy never double-mirrors a
    // cross-host message. The mirrored send records a reply anchor under the
    // source slug, so quote-replying a mirror messages that agent back.
    if (config.mesh) {
      registry.setAgentRelayObserver(({ from, to, text, delivered }) => {
        if (meshTelegramMode(config, from, to) !== 'full') return;
        const note = delivered === 0 ? '\n\n⚠ not delivered (no live session)' : '';
        sendOutbound({ slug: from, text: `→ ${to}\n\n${text}${note}`, replyToMessageId: null })
          .catch((err) => log(`mesh mirror ${from}→${to} failed: ${err.message}`));
      });
      log('mesh mirror on (telegram default=' + config.mesh.telegram + ', overrides=' + Object.keys(config.mesh.telegramOverrides).length + ')');
    }
  }

  const poller = new Poller({
    botToken,
    expectedChatId: Number(chatId),
    replyTracker,
    target: deliveryTarget,
    reactEmoji,
    react: setMessageReaction, // paced wrapper (#35) — inbound ack shares the send queue
    owner: telegramOwner, // floating Telegram-owner election (#29); null when federation is off
    isPreempted: federation?.isPreempted ?? null, // priority gate (#38); null when federation/priority off

    onStatusRequest: statusHandler,
    onNickRequest: nickHandler,
    onHelpRequest: helpHandler,
    onApproval: approvalHandler,
    onResumeRequest: resumeHandler,
    onWatchRequest: watchHandler.onRequest,
    onWatchToggle: watchHandler.onToggle,
    onUnmatched: agentHandler,
    onFullExpand: fullExpandHandler,
    onBroadcast,
    resolveNickname: (token) => nicknames.resolve(token),
    // Resolve a bare remote slug against the gossip ownership map so a peer
    // session routes by its real name, not only its nickname (#44). Null when
    // federation is off, the slug is local (hasSlug owns it), unknown, or
    // ambiguous across hosts — qualify with `<letter>/<slug>` in those cases.
    resolveFederated: (token) => {
      if (!federation) return null;
      const r = federation.resolveAddress(token);
      return r.kind === 'resolved' && !r.local ? `${r.hostLetter}/${r.slug}` : null;
    },
    resolveTopic: (id) => topicMap.get(id) ?? null,
    hasFullStash: (msgId) => oversizeCache.has(msgId),
    attachmentDir,
    handleVoice,
    sendVoiceReply,
    log,
  });
  if (!fedOnly) {
    poller.start();
    log(`poller started (chat ${chatId})`);
  }

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
          parseMode: 'HTML',
        });
        if (result?.message_id) {
          recordReplyAnchor(result.message_id, slug);
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
    summarizeBatchFn: maybeSummarizeBatch,
    send: ({ slug, text }) => sendMessage({ botToken, chatId, text, forumTopicId: topicForSlug(slug), parseMode: 'HTML' }),
    recordReply: (msgId, slug) => recordReplyAnchor(msgId, slug),
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

      // Dedup: skip if this is a ready ping AND either (a) the muzzle is
      // armed (an outbound send for this slug fired recently — the ping is
      // the echo of that send), or (b) `last_response` matches the body
      // of the last ready ping we sent for this slug (/loop watchdog).
      // Errors and waiting events always fire — they're rare and represent
      // state the user must see.
      if (newStatus === 'ready' && pingDedup.shouldSkip(slug, statusFile?.last_response)) {
        const len = typeof statusFile?.last_response === 'string' ? statusFile.last_response.length : 0;
        log(`dedup: skipped ${slug} ready ping (${len} chars)`);
        return;
      }

      const event = { status: newStatus, event: statusFile.event, statusFile };
      if (isDigested(config, slug)) {
        digest.enqueue(slug, event);
      } else {
        throttle.enqueue(slug, event);
      }
    },
    log,
  });
  if (!fedOnly) watcher.start();
  log(fedOnly ? 'belfry up (federation-only)' : 'belfry up');

  const shutdown = async (signal) => {
    log(`received ${signal} — shutting down`);
    throttle.clearAll();
    await digest.flushAll();
    await poller.stop();
    await brain.stop();
    if (federation) await federation.stop();
    await registry.stop();
    await watcher.stop();
    replyTracker.flush(); // sync flush of any debounced setImmediate save
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // SIGHUP arrives when the controlling terminal/PTY goes away — a normal
  // event in a devcontainer where VS Code terminals come and go. Default
  // node behavior is to terminate, which would crash the daemon every time
  // the user closes the terminal that started the supervisor. We install a
  // no-op handler so node keeps running; the supervisor itself also ignores
  // SIGHUP (see belfry-launch.sh).
  process.on('SIGHUP', () => log('SIGHUP received — ignoring (daemon stays up)'));
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
  // Last-ditch crash diagnostics. Without these, an unhandled rejection or
  // a throw inside a sync HTTP callback terminates the daemon with whatever
  // stderr write the runtime happens to make — empirically observed to
  // leave belfry.log truncated mid-line or empty. Log the stack to stderr
  // (which the launcher pipes to belfry.log) before letting the runtime
  // terminate normally.
  process.on('uncaughtException', (err, origin) => {
    log(`uncaughtException (${origin}): ${err?.stack ?? err}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const stack = reason instanceof Error ? reason.stack : String(reason);
    log(`unhandledRejection: ${stack}`);
    process.exit(1);
  });
  main().catch((err) => {
    log(`fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
