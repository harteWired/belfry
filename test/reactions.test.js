import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReactionConfig, DEFAULT_REACTIONS } from '../lib/reactions.js';

test('defaults to the three routing emoji when env is empty', () => {
  const cfg = resolveReactionConfig({});
  assert.deepEqual(cfg, {
    delivered: DEFAULT_REACTIONS.delivered,
    dropped: DEFAULT_REACTIONS.dropped,
    unmatched: DEFAULT_REACTIONS.unmatched,
  });
});

test('BELFRY_REACT falsy values disable the whole feature', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF', 'False', ' no ']) {
    assert.equal(resolveReactionConfig({ BELFRY_REACT: v }), null, `"${v}" should disable`);
  }
});

test('BELFRY_REACT truthy / unset leaves the feature on', () => {
  assert.ok(resolveReactionConfig({ BELFRY_REACT: 'on' }));
  assert.ok(resolveReactionConfig({ BELFRY_REACT: '1' }));
  assert.ok(resolveReactionConfig({}));
});

test('per-state env override replaces the default emoji', () => {
  const cfg = resolveReactionConfig({ BELFRY_REACT_DELIVERED: '✍️' });
  assert.equal(cfg.delivered, '✍️');
  assert.equal(cfg.dropped, DEFAULT_REACTIONS.dropped); // others untouched
});

test('per-state empty string disables just that state', () => {
  const cfg = resolveReactionConfig({ BELFRY_REACT_DROPPED: '' });
  assert.equal(cfg.dropped, null);
  assert.equal(cfg.delivered, DEFAULT_REACTIONS.delivered);
  assert.equal(cfg.unmatched, DEFAULT_REACTIONS.unmatched);
});

test('whitespace-only override disables that state', () => {
  const cfg = resolveReactionConfig({ BELFRY_REACT_UNMATCHED: '   ' });
  assert.equal(cfg.unmatched, null);
});

test('DEFAULT_REACTIONS is frozen', () => {
  assert.throws(() => { DEFAULT_REACTIONS.delivered = 'x'; });
});
