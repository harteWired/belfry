#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { loadConfig, isSubscribed } from '../lib/config.js';
import { StatusWatcher } from '../lib/watcher.js';
import { Throttle } from '../lib/throttle.js';
import { compose } from '../lib/composer.js';
import { sendMessage } from '../lib/telegram.js';
import { ReplyTracker } from '../lib/reply-tracker.js';
import { Registry } from '../lib/registry.js';
import { Poller } from '../lib/poller.js';

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
  const mcpPort = Number(process.env.BELFRY_MCP_PORT || 9876);
  if (!botToken || !chatId) {
    log('missing BELFRY_TOKEN and/or BELFRY_CHAT_ID env vars — relay disabled');
    log('see README.md for setup. Common pattern: a launcher script reads from your secret store and exec-s belfry with the env vars set.');
    process.exit(1);
  }
  log(`telegram bot configured (chat ${chatId}${forumTopicId ? `, topic ${forumTopicId}` : ''})`);

  // Inbound: per-session belfry-mcp plugins register here. The poller routes
  // each Telegram reply to the slug's registered plugin(s) which inject the
  // text via MCP `notifications/claude/channel` — same path plugin:telegram
  // uses, just with multi-session fan-out.
  const replyTracker = new ReplyTracker();
  const registry = new Registry({ port: mcpPort, log });
  await registry.start();

  const poller = new Poller({
    botToken,
    expectedChatId: Number(chatId),
    replyTracker,
    target: registry,
    log,
  });
  poller.start();
  log(`poller started (chat ${chatId})`);

  // Outbound: chokidar watcher → throttle → composer → Telegram.
  const throttle = new Throttle({
    coalesceMs: config.coalesceMs,
    throttleMs: config.throttleMs,
    dispatch: async (slug, event) => {
      const text = compose({
        slug,
        status: event.status,
        event: event.event,
        statusFile: event.statusFile,
        displayName: event.statusFile?.displayName ?? slug,
        promptCap: config.promptCap,
        responseCap: config.responseCap,
        replyFooter: true,
      });
      try {
        const result = await sendMessage({ botToken, chatId, text, forumTopicId });
        if (result?.message_id) replyTracker.record(result.message_id, slug);
        log(`sent ${slug}: ${event.status} (${text.length} chars, msg ${result?.message_id})`);
      } catch (err) {
        log(`send failed for ${slug}: ${err.message}`);
      }
    },
  });

  const watcher = new StatusWatcher({
    onUpdate: ({ slug, statusFile, prevStatusFile }) => {
      const newStatus = statusFile?.status;
      const prevStatus = prevStatusFile?.status;
      if (typeof newStatus !== 'string') return;
      if (!shouldFire(config, slug, prevStatus, newStatus)) return;
      throttle.enqueue(slug, { status: newStatus, event: statusFile.event, statusFile });
    },
    log,
  });
  watcher.start();
  log('belfry up');

  const shutdown = async (signal) => {
    log(`received ${signal} — shutting down`);
    throttle.clearAll();
    await poller.stop();
    await registry.stop();
    await watcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log(`fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  });
}
