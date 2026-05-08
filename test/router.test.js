import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../lib/router.js';
import { ReplyTracker } from '../lib/reply-tracker.js';

const CHAT = 12345;

function ctx({ tracked = [], knownSlugs = ['life-planner', 'belfry'] } = {}) {
  const replyTracker = new ReplyTracker();
  for (const [id, slug] of tracked) replyTracker.record(id, slug);
  return {
    expectedChatId: CHAT,
    replyTracker,
    knownSlugs: new Set(knownSlugs),
  };
}

function update({ chatId = CHAT, text, replyToId } = {}) {
  const message = { message_id: 99, chat: { id: chatId }, text };
  if (replyToId !== undefined) {
    message.reply_to_message = { message_id: replyToId };
  }
  return { message };
}

test('drops messages from unexpected chat', () => {
  const r = route({ update: update({ chatId: 99999, text: 'hi' }), ...ctx() });
  assert.equal(r, null);
});

test('drops updates with no message', () => {
  const r = route({ update: { edited_message: {} }, ...ctx() });
  assert.equal(r, null);
});

test('drops messages with no text', () => {
  const r = route({ update: update({ text: undefined }), ...ctx() });
  assert.equal(r, null);
});

test('quote-reply routes to tracked slug', () => {
  const r = route({
    update: update({ text: 'do the thing', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'life-planner']] }),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'life-planner', text: 'do the thing', messageId: 99 });
});

test('quote-reply with untracked id falls through to prefix path', () => {
  const r = route({
    update: update({ text: '/belfry restart', replyToId: 999 }),
    ...ctx(),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'belfry', text: 'restart', messageId: 99 });
});

test('quote-reply with untracked id and no prefix → null', () => {
  const r = route({ update: update({ text: 'just a reply', replyToId: 999 }), ...ctx() });
  assert.equal(r, null);
});

test('prefix path with known slug routes', () => {
  const r = route({ update: update({ text: '/life-planner do X' }), ...ctx() });
  assert.deepEqual(r, { action: 'deliver', slug: 'life-planner', text: 'do X', messageId: 99 });
});

test('prefix path with unknown slug → null', () => {
  const r = route({ update: update({ text: '/unknown-slug do X' }), ...ctx() });
  assert.equal(r, null);
});

test('prefix path with no body → null (empty message)', () => {
  const r = route({ update: update({ text: '/life-planner' }), ...ctx() });
  assert.equal(r, null);
});

test('quote-reply takes precedence over prefix when both present', () => {
  const r = route({
    update: update({ text: '/belfry doing belfry stuff', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'life-planner']] }),
  });
  assert.equal(r.slug, 'life-planner', 'quote-reply wins');
  assert.equal(r.text, '/belfry doing belfry stuff', 'full text preserved on quote-reply');
});

test('plain text with no reply and no prefix → null', () => {
  const r = route({ update: update({ text: 'just chatting' }), ...ctx() });
  assert.equal(r, null);
});

test('/status with no slug returns action=status with slug=null', () => {
  const r = route({ update: update({ text: '/status' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: null, messageId: 99 });
});

test('/status <slug> returns action=status with that slug', () => {
  const r = route({ update: update({ text: '/status belfry' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: 'belfry', messageId: 99 });
});

test('/status takes precedence over slug-prefix routing', () => {
  // Even if a slug were named "status", the reserved command wins.
  const r = route({
    update: update({ text: '/status' }),
    ...ctx({ knownSlugs: ['status'] }),
  });
  assert.equal(r.action, 'status');
});

test('/status with trailing whitespace still routes', () => {
  const r = route({ update: update({ text: '/status  ' }), ...ctx() });
  assert.equal(r.action, 'status');
  assert.equal(r.slug, null);
});

test('/status with extra args after slug → null (rejected, not a delivery)', () => {
  // /status takes only an optional slug — anything else is malformed.
  const r = route({ update: update({ text: '/status belfry now' }), ...ctx() });
  assert.equal(r, null);
});
