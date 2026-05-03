#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadConfig, isSubscribed } from '../lib/config.js';
import { StatusWatcher } from '../lib/watcher.js';
import { Throttle } from '../lib/throttle.js';
import { compose } from '../lib/composer.js';
import { sendMessage } from '../lib/telegram.js';

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
  if (!botToken || !chatId) {
    log('missing BELFRY_TOKEN and/or BELFRY_CHAT_ID env vars — relay disabled');
    log('see README.md for setup. Common pattern: a launcher script reads from your secret store and exec-s belfry with the env vars set.');
    process.exit(1);
  }
  log(`telegram bot configured (chat ${chatId}${forumTopicId ? `, topic ${forumTopicId}` : ''})`);

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
      });
      try {
        await sendMessage({ botToken, chatId, text, forumTopicId });
        log(`sent ${slug}: ${event.status} (${text.length} chars)`);
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
