import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadConfig, isSubscribed, isSummarized, topicFor, topicSlugMap, meshTelegramMode } from '../lib/config.js';

function tmp(content) {
  const p = path.join(os.tmpdir(), `belfry-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonc`);
  fs.writeFileSync(p, content);
  return p;
}

test('returns missing=true when config file does not exist', () => {
  const cfg = loadConfig('/nonexistent/path.jsonc');
  assert.equal(cfg.missing, true);
  assert.deepEqual(cfg.subscriptions, {});
});

test('parses subscriptions and applies defaults', () => {
  const p = tmp(`{
    // comment
    "subscriptions": {
      "life-planner": { "events": ["ready", "error"] },
      "financial-planner": {}  // empty events → default ["ready"]
    }
  }`);
  const cfg = loadConfig(p);
  assert.equal(cfg.missing, false);
  assert.deepEqual(cfg.subscriptions['life-planner'].events, ['ready', 'error']);
  assert.deepEqual(cfg.subscriptions['financial-planner'].events, ['ready']);
  fs.unlinkSync(p);
});

test('strips // line comments and /* block */ comments', () => {
  const p = tmp(`{
    /* block
       comment */
    "subscriptions": {
      "x": { "events": ["ready"] } // trailing
    },
    "throttleMs": 12345 // override
  }`);
  const cfg = loadConfig(p);
  assert.equal(cfg.throttleMs, 12345);
  assert.deepEqual(cfg.subscriptions.x.events, ['ready']);
  fs.unlinkSync(p);
});

test('drops invalid event names', () => {
  const p = tmp(`{
    "subscriptions": {
      "x": { "events": ["ready", "bogus", "error"] }
    }
  }`);
  const cfg = loadConfig(p);
  assert.deepEqual(cfg.subscriptions.x.events, ['ready', 'error']);
  fs.unlinkSync(p);
});

test('isSubscribed matches slug + event', () => {
  const cfg = {
    subscriptions: { 'a': { events: ['ready', 'error'] } },
  };
  assert.equal(isSubscribed(cfg, 'a', 'ready'), true);
  assert.equal(isSubscribed(cfg, 'a', 'error'), true);
  assert.equal(isSubscribed(cfg, 'a', 'waiting'), false);
  assert.equal(isSubscribed(cfg, 'b', 'ready'), false);
});

test('summarize defaults to false and only true when explicitly set', () => {
  const p = tmp(`{
    "subscriptions": {
      "a": { "events": ["ready"], "summarize": true },
      "b": { "events": ["ready"] },
      "c": { "events": ["ready"], "summarize": "yes" }
    }
  }`);
  const cfg = loadConfig(p);
  assert.equal(isSummarized(cfg, 'a'), true);
  assert.equal(isSummarized(cfg, 'b'), false);
  assert.equal(isSummarized(cfg, 'c'), false, 'non-boolean summarize is rejected');
  assert.equal(isSummarized(cfg, 'unknown'), false);
  fs.unlinkSync(p);
});

test('topicFor: returns per-slug topic, null when unset', () => {
  const cfg = {
    subscriptions: {
      a: { events: ['ready'], topic: 1234 },
      b: { events: ['ready'] },
    },
  };
  assert.equal(topicFor(cfg, 'a'), 1234);
  assert.equal(topicFor(cfg, 'b'), null);
  assert.equal(topicFor(cfg, 'unknown'), null);
});

test('topicSlugMap: inverts to topic→slug, ignoring slugs without topics', () => {
  const cfg = {
    subscriptions: {
      a: { events: ['ready'], topic: 1 },
      b: { events: ['ready'], topic: 2 },
      c: { events: ['ready'] },
    },
  };
  const m = topicSlugMap(cfg);
  assert.equal(m.size, 2);
  assert.equal(m.get(1), 'a');
  assert.equal(m.get(2), 'b');
});

test('loadConfig: rejects non-positive / non-numeric topic values', () => {
  const p = tmp(`{
    "subscriptions": {
      "good": { "events": ["ready"], "topic": 42 },
      "stringTopic": { "events": ["ready"], "topic": "42" },
      "zeroTopic": { "events": ["ready"], "topic": 0 },
      "negTopic": { "events": ["ready"], "topic": -1 }
    }
  }`);
  const cfg = loadConfig(p);
  assert.equal(cfg.subscriptions.good.topic, 42);
  assert.equal(cfg.subscriptions.stringTopic.topic, null);
  assert.equal(cfg.subscriptions.zeroTopic.topic, null);
  assert.equal(cfg.subscriptions.negTopic.topic, null);
  fs.unlinkSync(p);
});

test('mesh block absent → mesh null and meshTelegramMode returns none (#39)', () => {
  const p = tmp(`{ "subscriptions": {} }`);
  const cfg = loadConfig(p);
  assert.equal(cfg.mesh, null);
  assert.equal(meshTelegramMode(cfg, 'w/wintermute', 'life-planner'), 'none');
  fs.unlinkSync(p);
});

test('mesh block parses default + overrides, dropping invalid modes (#39)', () => {
  const p = tmp(`{
    "mesh": {
      "telegram": "none",
      "telegramOverrides": {
        "wintermute": "full",
        "noisy-agent": "summary"  // not implemented → dropped
      }
    }
  }`);
  const cfg = loadConfig(p);
  assert.equal(cfg.mesh.telegram, 'none');
  assert.deepEqual(cfg.mesh.telegramOverrides, { wintermute: 'full' });
  fs.unlinkSync(p);
});

test('meshTelegramMode: bare override key matches host-qualified endpoints, either direction (#39)', () => {
  const p = tmp(`{ "mesh": { "telegramOverrides": { "wintermute": "full" } } }`);
  const cfg = loadConfig(p);
  // Source match, qualified and bare.
  assert.equal(meshTelegramMode(cfg, 'w/wintermute', 'life-planner'), 'full');
  assert.equal(meshTelegramMode(cfg, 'wintermute', 'life-planner'), 'full');
  // Destination match — messages TO the agent surface too.
  assert.equal(meshTelegramMode(cfg, 'belfry', 'w/wintermute'), 'full');
  // No endpoint matches → default none.
  assert.equal(meshTelegramMode(cfg, 'belfry', 'computer-use'), 'none');
  fs.unlinkSync(p);
});

test('meshTelegramMode: qualified override key outranks the default but only for that host (#39)', () => {
  const p = tmp(`{ "mesh": { "telegram": "none", "telegramOverrides": { "w/wintermute": "full" } } }`);
  const cfg = loadConfig(p);
  assert.equal(meshTelegramMode(cfg, 'w/wintermute', 'x'), 'full');
  assert.equal(meshTelegramMode(cfg, 'e/wintermute', 'x'), 'none');
  fs.unlinkSync(p);
});

test('meshTelegramMode: override can silence one agent under a full default (#39)', () => {
  const p = tmp(`{ "mesh": { "telegram": "full", "telegramOverrides": { "chatterbox": "none" } } }`);
  const cfg = loadConfig(p);
  assert.equal(meshTelegramMode(cfg, 'chatterbox', 'x'), 'none');
  assert.equal(meshTelegramMode(cfg, 'quiet-one', 'x'), 'full');
  fs.unlinkSync(p);
});
