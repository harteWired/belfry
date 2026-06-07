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
    { letter: 'e', name: 'Erebus', addr: 'http://erebus:49876' },
    { letter: 'n', name: 'n', addr: 'http://nas:49876' },
  ]);
});

test('reads peers from the file block when env peers unset', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'd' },
    file: { peers: [{ letter: 'e', name: 'Erebus', addr: 'http://erebus:49876' }] },
  });
  assert.deepEqual(c.peers, [{ letter: 'e', name: 'Erebus', addr: 'http://erebus:49876' }]);
});

test('env peer list overrides the file block wholesale', () => {
  const c = parseFederationConfig({
    env: { BELFRY_HOST_LETTER: 'd', BELFRY_FED_PEERS: 'n,http://nas:49876' },
    file: { peers: [{ letter: 'e', addr: 'http://erebus:49876' }] },
  });
  assert.deepEqual(c.peers.map((p) => p.letter), ['n']);
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
