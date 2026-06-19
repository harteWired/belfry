/**
 * /watch handler + keyboard (#40).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatchHandler, watchKeyboard } from '../lib/watch-handler.js';

function fakeStore(initial = {}) {
  const subs = { ...initial };
  const off = new Set();
  return {
    isWatched: (s) => Boolean(subs[s]),
    watch: (s, ev) => { off.delete(s); return (subs[s] = { events: ev }); },
    unwatch: (s) => { delete subs[s]; off.add(s); },
    toggle(s) { if (subs[s]) { delete subs[s]; off.add(s); return false; } off.delete(s); subs[s] = { events: ['ready', 'error'] }; return true; },
    list: () => Object.keys(subs).filter((k) => subs[k]).sort(),
    managedSlugs: () => [...new Set([...Object.keys(subs).filter((k) => subs[k]), ...off])],
  };
}

function harness(store, slugs = ['api', 'health-dash']) {
  const sent = [], edited = [], answered = [];
  const h = makeWatchHandler({
    store,
    getSlugs: () => slugs,
    send: async (a) => { sent.push(a); },
    editMessage: async (a) => { edited.push(a); },
    answerCallback: async (a) => { answered.push(a); },
  });
  return { h, sent, edited, answered };
}

test('watch-menu sends a keyboard listing every known slug + a Done row', async () => {
  const { h, sent } = harness(fakeStore({ api: { events: ['ready'] } }));
  await h.onRequest({ action: 'watch-menu', messageId: 1 });
  assert.equal(sent.length, 1);
  const kb = sent[0].replyMarkup.inline_keyboard;
  assert.equal(kb.length, 3, 'api + health-dash + Done');
  assert.match(kb[0][0].text, /👁 api/, 'watched slug shows the eye, sorted first');
  assert.equal(kb[0][0].callback_data, 'belfry:watch:api');
  assert.equal(kb[2][0].callback_data, 'belfry:watch:__done__');
});

test('watch-menu includes a watched slug that is not currently live', async () => {
  const { h, sent } = harness(fakeStore({ offline: { events: ['ready'] } }), ['api']);
  await h.onRequest({ action: 'watch-menu', messageId: 1 });
  const labels = sent[0].replyMarkup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((t) => t.includes('offline')), 'watched-but-offline slug still appears');
});

test('watch-set watches and confirms', async () => {
  const store = fakeStore();
  const { h, sent } = harness(store);
  await h.onRequest({ action: 'watch-set', slug: 'api', events: ['ready', 'error'], messageId: 1 });
  assert.equal(store.isWatched('api'), true);
  assert.match(sent[0].text, /Watching "api"/);
});

test('watch-unset unwatches and confirms', async () => {
  const store = fakeStore({ api: { events: ['ready'] } });
  const { h, sent } = harness(store);
  await h.onRequest({ action: 'watch-unset', slug: 'api', messageId: 1 });
  assert.equal(store.isWatched('api'), false);
  assert.match(sent[0].text, /Unwatched "api"/);
});

test('watch-list reports the watched set', async () => {
  const { h, sent } = harness(fakeStore({ api: { events: ['ready'] } }));
  await h.onRequest({ action: 'watch-list', messageId: 1 });
  assert.match(sent[0].text, /Watching \(1\): api/);
});

test('toggle flips state, re-renders the keyboard in place, answers the callback', async () => {
  const store = fakeStore();
  const { h, edited, answered } = harness(store);
  await h.onToggle({ callbackQueryId: 'c1', slug: 'api', messageId: 5 });
  assert.equal(store.isWatched('api'), true);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].messageId, 5);
  assert.ok(edited[0].replyMarkup.inline_keyboard, 'keyboard re-rendered');
  assert.match(answered[0].text, /Watching api/);
});

test('Done closes the menu (clears the keyboard)', async () => {
  const { h, edited, answered } = harness(fakeStore({ api: { events: ['ready'] } }));
  await h.onToggle({ callbackQueryId: 'c1', slug: '__done__', messageId: 5 });
  assert.deepEqual(edited[0].replyMarkup, { inline_keyboard: [] });
  assert.match(answered[0].text, /Done/);
});

test('an unwatched project stays in the menu so it can be re-watched', async () => {
  // git is watched but NOT a live/known slug (getSlugs is just ['api']).
  const store = fakeStore({ git: { events: ['ready'] } });
  const { h, edited } = harness(store, ['api']);
  await h.onToggle({ callbackQueryId: 'c1', slug: 'git', messageId: 5 });
  assert.equal(store.isWatched('git'), false, 'unwatched');
  const cbs = edited[0].replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('belfry:watch:git'), 'unwatched project still in the re-rendered menu (was vanishing before)');
});

test('watchKeyboard uses stable alphabetical order regardless of watch state', () => {
  const kb = watchKeyboard(['zeta', 'alpha', 'mid'], (s) => s === 'zeta');
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'belfry:watch:alpha');
  assert.equal(kb.inline_keyboard[1][0].callback_data, 'belfry:watch:mid');
  assert.equal(kb.inline_keyboard[2][0].callback_data, 'belfry:watch:zeta');
});
