import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../lib/router.js';
import { ReplyTracker } from '../lib/reply-tracker.js';

const CHAT = 12345;

function ctx({
  tracked = [],
  knownSlugs = ['life-planner', 'belfry'],
  nicknames = {},
} = {}) {
  const replyTracker = new ReplyTracker();
  for (const [id, slug] of tracked) replyTracker.record(id, slug);
  const slugSet = new Set(knownSlugs);
  return {
    expectedChatId: CHAT,
    replyTracker,
    hasSlug: (s) => slugSet.has(s),
    resolveNickname: (token) => nicknames[token?.toLowerCase()] ?? null,
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

test('quote-reply with untracked id and no prefix → unmatched', () => {
  const r = route({ update: update({ text: 'just a reply', replyToId: 999 }), ...ctx() });
  assert.deepEqual(r, { action: 'unmatched', text: 'just a reply', messageId: 99 });
});

test('prefix path with known slug routes', () => {
  const r = route({ update: update({ text: '/life-planner do X' }), ...ctx() });
  assert.deepEqual(r, { action: 'deliver', slug: 'life-planner', text: 'do X', messageId: 99 });
});

test('prefix path with unknown slug → unmatched', () => {
  const r = route({ update: update({ text: '/unknown-slug do X' }), ...ctx() });
  assert.deepEqual(r, { action: 'unmatched', text: '/unknown-slug do X', messageId: 99 });
});

test('prefix path with no body → unmatched (empty message)', () => {
  const r = route({ update: update({ text: '/life-planner' }), ...ctx() });
  assert.deepEqual(r, { action: 'unmatched', text: '/life-planner', messageId: 99 });
});

test('quote-reply takes precedence over prefix when both present', () => {
  const r = route({
    update: update({ text: '/belfry doing belfry stuff', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'life-planner']] }),
  });
  assert.equal(r.slug, 'life-planner', 'quote-reply wins');
  assert.equal(r.text, '/belfry doing belfry stuff', 'full text preserved on quote-reply');
});

test('plain text with no reply and no prefix → unmatched', () => {
  const r = route({ update: update({ text: 'just chatting' }), ...ctx() });
  assert.deepEqual(r, { action: 'unmatched', text: 'just chatting', messageId: 99 });
});

test('/status with no slug returns action=status with slug=null', () => {
  const r = route({ update: update({ text: '/status' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: null, messageId: 99 });
});

test('/status <slug> returns action=status with that slug', () => {
  const r = route({ update: update({ text: '/status belfry' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: 'belfry', messageId: 99 });
});

test('/status <nickname> resolves nickname to slug', () => {
  const r = route({
    update: update({ text: '/status ob' }),
    ...ctx({ nicknames: { ob: 'obsidian-vault' } }),
  });
  assert.deepEqual(r, { action: 'status', slug: 'obsidian-vault', messageId: 99 });
});

test('/status <unknown-token> passes raw token through', () => {
  // Status handler will emit "no such session" — router doesn't second-guess.
  const r = route({ update: update({ text: '/status missing' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: 'missing', messageId: 99 });
});

test('/status takes precedence over slug-prefix routing', () => {
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

test('/status with extra args after slug → unmatched', () => {
  const r = route({ update: update({ text: '/status belfry now' }), ...ctx() });
  assert.deepEqual(r, { action: 'unmatched', text: '/status belfry now', messageId: 99 });
});

test('/nick <nick> <slug> returns nick-set', () => {
  const r = route({ update: update({ text: '/nick ob obsidian-vault' }), ...ctx() });
  assert.deepEqual(r, { action: 'nick-set', nickname: 'ob', slug: 'obsidian-vault', messageId: 99 });
});

test('/unnick <nick> returns nick-unset', () => {
  const r = route({ update: update({ text: '/unnick ob' }), ...ctx() });
  assert.deepEqual(r, { action: 'nick-unset', nickname: 'ob', messageId: 99 });
});

test('/nicks returns nick-list', () => {
  const r = route({ update: update({ text: '/nicks' }), ...ctx() });
  assert.deepEqual(r, { action: 'nick-list', messageId: 99 });
});

test('/nick with malformed args → unmatched', () => {
  // Missing slug
  const r = route({ update: update({ text: '/nick ob' }), ...ctx() });
  assert.equal(r.action, 'unmatched');
});

test('prefix path resolves nickname when token is not a slug', () => {
  const r = route({
    update: update({ text: '/ob do something' }),
    ...ctx({ nicknames: { ob: 'obsidian-vault' } }),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'obsidian-vault', text: 'do something', messageId: 99 });
});

test('prefix path: slug wins over nickname on collision', () => {
  // 'foo' is both an active slug and a nickname pointing elsewhere.
  // Slug must always win.
  const r = route({
    update: update({ text: '/foo body' }),
    ...ctx({ knownSlugs: ['foo'], nicknames: { foo: 'somewhere-else' } }),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'foo', text: 'body', messageId: 99 });
});

test('prefix path: unknown token (neither slug nor nickname) → unmatched', () => {
  const r = route({
    update: update({ text: '/totally-unknown body' }),
    ...ctx({ nicknames: { ob: 'obsidian-vault' } }),
  });
  assert.deepEqual(r, { action: 'unmatched', text: '/totally-unknown body', messageId: 99 });
});

test('reserved tokens never deliver via prefix path even if a slug literally matches', () => {
  // A session named exactly the reserved token exists. Malformed reserved
  // commands that don't match the strict reserved-command regex must not
  // fall through and deliver to a hypothetical session of the same name.
  // Inputs chosen to *not* match NICK_SET_RE / UNNICK_RE / NICKS_LIST_RE /
  // STATUS_RE — i.e. extra/invalid args.
  const malformed = [
    { text: '/nick body content', knownSlugs: ['nick'] }, // nickname & slug shape clash; well-formed-looking but the slug body has spaces
    { text: '/unnick foo extra', knownSlugs: ['unnick'] }, // /unnick takes one arg only
    { text: '/nicks junk here', knownSlugs: ['nicks'] }, // /nicks takes no args
    { text: '/status one two three', knownSlugs: ['status'] }, // /status takes one arg max
  ];
  for (const { text, knownSlugs } of malformed) {
    const r = route({ update: update({ text }), ...ctx({ knownSlugs }) });
    // Must not be a 'deliver' to the reserved-named slug.
    assert.notEqual(r?.action, 'deliver', `${text} must not deliver to /${knownSlugs[0]}`);
  }
});

test('reserved commands accept no-slash prefix: status, nicks, help', () => {
  // /status equivalent
  let r = route({ update: update({ text: 'status' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: null, messageId: 99 });

  r = route({ update: update({ text: 'status belfry' }), ...ctx() });
  assert.deepEqual(r, { action: 'status', slug: 'belfry', messageId: 99 });

  // /nicks equivalent
  r = route({ update: update({ text: 'nicks' }), ...ctx() });
  assert.deepEqual(r, { action: 'nick-list', messageId: 99 });

  // /help (new) — slashed and bare
  r = route({ update: update({ text: 'help' }), ...ctx() });
  assert.deepEqual(r, { action: 'help', topic: null, messageId: 99 });

  r = route({ update: update({ text: '/help nicknames' }), ...ctx() });
  assert.deepEqual(r, { action: 'help', topic: 'nicknames', messageId: 99 });

  r = route({ update: update({ text: 'help routing' }), ...ctx() });
  assert.deepEqual(r, { action: 'help', topic: 'routing', messageId: 99 });
});

test('reserved commands no-slash: nick set + unset (strict shape)', () => {
  // Two-arg shape
  let r = route({ update: update({ text: 'nick lp life-planner' }), ...ctx() });
  assert.deepEqual(r, { action: 'nick-set', nickname: 'lp', slug: 'life-planner', messageId: 99 });

  // One-arg unset shape
  r = route({ update: update({ text: 'unnick lp' }), ...ctx() });
  assert.deepEqual(r, { action: 'nick-unset', nickname: 'lp', messageId: 99 });

  // Conversational "nick the variable was renamed" doesn't match (3+ tokens)
  r = route({ update: update({ text: 'nick the variable was renamed' }), ...ctx() });
  assert.equal(r.action, 'unmatched');

  // Conversational "unnick someone" with arbitrary trailing text doesn't match
  r = route({ update: update({ text: 'unnick all of them please' }), ...ctx() });
  assert.equal(r.action, 'unmatched');
});

test('/help with unknown topic falls through to action=help with topic preserved', () => {
  // Router doesn't validate the topic — that's the help handler's job. We
  // just confirm any [a-z0-9-]+ word makes it through.
  const r = route({ update: update({ text: 'help mystery' }), ...ctx() });
  assert.deepEqual(r, { action: 'help', topic: 'mystery', messageId: 99 });
});

test('backwards compat: knownSlugs Set still works without hasSlug', () => {
  const replyTracker = new ReplyTracker();
  const r = route({
    update: update({ text: '/belfry x' }),
    expectedChatId: CHAT,
    replyTracker,
    knownSlugs: new Set(['belfry']),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'belfry', text: 'x', messageId: 99 });
});
