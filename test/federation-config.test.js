import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFederationConfig } from '../lib/federation-config.js';

test('disabled when no host letter configured', () => {
  assert.deepEqual(parseFederationConfig({ env: {} }), { enabled: false });
  assert.deepEqual(parseFederationConfig({ env: {}, file: { peers: [] } }), { enabled: false });
});

test('parses host identity from env', () => {
  const c = parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'D', BELFRY_HOST_NAME: 'Daedalus', BELFRY_FED_TOKEN: 'sek' } });
  assert.equal(c.enabled, true);
  assert.equal(c.hostLetter, 'd'); // lowercased
  assert.equal(c.hostName, 'Daedalus');
  assert.equal(c.token, 'sek');
  assert.deepEqual(c.peers, []);
});

test('host name defaults to the letter', () => {
  const c = parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'e' } });
  assert.equal(c.hostName, 'e');
  assert.equal(c.token, null);
});

test('parses the compact peer env form (with and without names)', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'd', BELFRY_FED_PEERS: 'e,Erebus,http://erebus:49876; n,http://nas:49876' },
  });
  assert.deepEqual(c.peers, [
    { letter: 'e', name: 'Erebus', addr: 'http://erebus:49876', priority: null },
    { letter: 'n', name: 'n', addr: 'http://nas:49876', priority: null },
  ]);
});

test('reads peers from the file block when env peers unset', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'd' },
    file: { peers: [{ letter: 'e', name: 'Erebus', addr: 'http://erebus:49876' }] },
  });
  assert.deepEqual(c.peers, [{ letter: 'e', name: 'Erebus', addr: 'http://erebus:49876', priority: null }]);
});

test('env peer list overrides the file block wholesale', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'd', BELFRY_FED_PEERS: 'n,http://nas:49876' },
    file: { peers: [{ letter: 'e', addr: 'http://erebus:49876' }] },
  });
  assert.deepEqual(c.peers.map((p) => p.letter), ['n']);
});

// --- priority (#38) ---

test('priority is null when unset (no gating)', () => {
  const c = parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j' } });
  assert.equal(c.priority, null);
});

test('parses self priority from env and file block (env wins)', () => {
  assert.equal(parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j', BELFRY_HOST_PRIORITY: '1' } }).priority, 1);
  assert.equal(parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j' }, file: { priority: 2 } }).priority, 2);
  assert.equal(
    parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j', BELFRY_HOST_PRIORITY: '1' }, file: { priority: 9 } }).priority,
    1,
  );
});

test('parses peer priority from the 4-field compact env form', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'j', BELFRY_FED_PEERS: 'e,Erebus,http://erebus:49876,2; s,NAS,http://nas:49876,3' },
  });
  assert.deepEqual(c.peers, [
    { letter: 'e', name: 'Erebus', addr: 'http://erebus:49876', priority: 2 },
    { letter: 's', name: 'NAS', addr: 'http://nas:49876', priority: 3 },
  ]);
});

test('parses peer priority from the file block', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'j' },
    file: { peers: [{ letter: 'e', name: 'Erebus', addr: 'http://erebus:49876', priority: 2 }] },
  });
  assert.equal(c.peers[0].priority, 2);
});

test('rejects a non-integer / negative priority loudly', () => {
  assert.throws(() => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j', BELFRY_HOST_PRIORITY: 'high' } }), /priority/);
  assert.throws(() => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j', BELFRY_HOST_PRIORITY: '-1' } }), /priority/);
  assert.throws(
    () => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'j', BELFRY_FED_PEERS: 'e,Erebus,http://erebus:1,x' } }),
    /priority/,
  );
});

test('rejects a bad host letter', () => {
  assert.throws(() => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'xx' } }), /single \[a-z0-9\]/);
});

test('rejects a peer letter colliding with this host', () => {
  assert.throws(
    () => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'd', BELFRY_FED_PEERS: 'd,http://x:1' } }),
    /collides/,
  );
});

test('rejects duplicate peer letters', () => {
  assert.throws(
    () => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'd', BELFRY_FED_PEERS: 'e,http://x:1;e,http://y:2' } }),
    /duplicate/,
  );
});

test('rejects a peer missing an addr', () => {
  assert.throws(
    () => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'd' }, file: { peers: [{ letter: 'e' }] } }),
    /missing an addr/,
  );
});

test('rejects a malformed compact peer spec', () => {
  assert.throws(
    () => parseFederationConfig({ env: { BELFRY_HOST_LETTER: 'd', BELFRY_FED_PEERS: 'justletter' } }),
    /malformed peer spec/,
  );
});
