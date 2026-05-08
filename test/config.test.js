import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadConfig, isSubscribed, isSummarized } from '../lib/config.js';

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
