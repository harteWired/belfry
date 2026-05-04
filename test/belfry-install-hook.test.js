import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectExistingWriter, buildSettingsWithBelfryHook, looksLikeJsonc } from '../bin/belfry-install-hook.js';

test('detectExistingWriter finds belfry-hook in any event slot', () => {
  const settings = {
    hooks: {
      Notification: [{ hooks: [{ type: 'command', command: 'belfry-hook' }] }],
    },
  };
  const detected = detectExistingWriter(settings);
  assert.deepEqual(detected, { writer: 'belfry-hook', event: 'Notification', command: 'belfry-hook' });
});

test('detectExistingWriter finds claudelike-bar by substring match', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node /opt/claudelike-bar/hooks/dashboard-status.js' }] }],
    },
  };
  const detected = detectExistingWriter(settings);
  assert.equal(detected?.writer, 'claudelike-bar');
  assert.equal(detected?.event, 'Stop');
});

test('detectExistingWriter returns null when no convention writer is present', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo "totally unrelated"' }] }],
    },
  };
  assert.equal(detectExistingWriter(settings), null);
});

test('detectExistingWriter handles empty / missing hooks gracefully', () => {
  assert.equal(detectExistingWriter(null), null);
  assert.equal(detectExistingWriter({}), null);
  assert.equal(detectExistingWriter({ hooks: null }), null);
  assert.equal(detectExistingWriter({ hooks: { Stop: 'not an array' } }), null);
});

test('buildSettingsWithBelfryHook adds belfry-hook to all relevant events', () => {
  const updated = buildSettingsWithBelfryHook(null, 'belfry-hook');
  assert.ok(Array.isArray(updated.hooks.Stop));
  assert.ok(Array.isArray(updated.hooks.Notification));
  const stopHook = updated.hooks.Stop[0].hooks[0];
  assert.equal(stopHook.type, 'command');
  assert.equal(stopHook.command, 'belfry-hook');
});

test('buildSettingsWithBelfryHook preserves existing settings and appends', () => {
  const existing = {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'unrelated-prefix-tool' }] }],
    },
  };
  const updated = buildSettingsWithBelfryHook(existing, 'belfry-hook');
  assert.deepEqual(updated.permissions, existing.permissions);
  assert.equal(updated.hooks.Stop.length, 2, 'unrelated entry stays, ours is appended');
  assert.equal(updated.hooks.Stop[0].hooks[0].command, 'unrelated-prefix-tool');
  assert.equal(updated.hooks.Stop[1].hooks[0].command, 'belfry-hook');
});

test('buildSettingsWithBelfryHook is idempotent — repeated runs do not duplicate entries', () => {
  let settings = buildSettingsWithBelfryHook(null, 'belfry-hook');
  // Run again on the result of the first install (simulates --force re-run).
  settings = buildSettingsWithBelfryHook(settings, 'belfry-hook');
  settings = buildSettingsWithBelfryHook(settings, 'belfry-hook');
  for (const event of ['Stop', 'SubagentStop', 'Notification', 'SessionStart', 'SessionEnd']) {
    const matches = settings.hooks[event].filter((entry) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === 'belfry-hook'),
    );
    assert.equal(matches.length, 1, `event ${event} has exactly one belfry-hook entry`);
  }
});

test('looksLikeJsonc detects // and /* markers', () => {
  assert.equal(looksLikeJsonc('{"a": 1} // trailing comment'), true);
  assert.equal(looksLikeJsonc('{\n  /* block */\n  "a": 1\n}'), true);
  assert.equal(looksLikeJsonc('{"a": 1}'), false);
  assert.equal(looksLikeJsonc(''), false);
  assert.equal(looksLikeJsonc(null), false);
});
