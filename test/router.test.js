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

test('/resume routes to action=resume with no slug or uuid', () => {
  const r = route({ update: update({ text: '/resume' }), ...ctx() });
  assert.deepEqual(r, { action: 'resume', slug: null, uuid: null, messageId: 99 });
});

test('/resume <slug> sets slug only', () => {
  const r = route({ update: update({ text: '/resume belfry' }), ...ctx() });
  assert.deepEqual(r, { action: 'resume', slug: 'belfry', uuid: null, messageId: 99 });
});

test('/resume <slug> <uuid-prefix> sets both', () => {
  const r = route({ update: update({ text: '/resume belfry abc12345' }), ...ctx() });
  assert.deepEqual(r, { action: 'resume', slug: 'belfry', uuid: 'abc12345', messageId: 99 });
});

test('resume accepts no-slash form: "resume" / "resume belfry"', () => {
  const r1 = route({ update: update({ text: 'resume' }), ...ctx() });
  assert.equal(r1.action, 'resume');
  const r2 = route({ update: update({ text: 'resume belfry' }), ...ctx() });
  assert.equal(r2.action, 'resume');
  assert.equal(r2.slug, 'belfry');
});

test('resume rejects invalid uuid shape (non-hex)', () => {
  const r = route({ update: update({ text: '/resume belfry not-a-uuid' }), ...ctx() });
  assert.notEqual(r.action, 'resume');
});

test('forum topic: message in a topic mapped to a slug routes to that slug', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      message_thread_id: 5001,
      text: 'just a status update',
    },
  };
  const r = route({
    update: u,
    ...ctx(),
    resolveTopic: (id) => (id === 5001 ? 'belfry' : null),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'belfry', text: 'just a status update', messageId: 99 });
});

test('forum topic: explicit /<slug> prefix inside a topic overrides topic routing', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      message_thread_id: 5001, // bound to belfry
      text: '/life-planner do the thing',
    },
  };
  const r = route({
    update: u,
    ...ctx(),
    resolveTopic: (id) => (id === 5001 ? 'belfry' : null),
  });
  // Explicit prefix wins — body without the /life-planner is delivered.
  assert.deepEqual(r, { action: 'deliver', slug: 'life-planner', text: 'do the thing', messageId: 99 });
});

test('forum topic: reserved /status inside a topic still hits /status', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      message_thread_id: 5001,
      text: '/status',
    },
  };
  const r = route({
    update: u,
    ...ctx(),
    resolveTopic: (id) => (id === 5001 ? 'belfry' : null),
  });
  assert.equal(r.action, 'status');
});

test('forum topic: empty-text photo into a bound topic still routes (no caption needed)', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      message_thread_id: 5001,
      photo: [{ file_id: 'abc' }],
      // no caption, no text
    },
  };
  const r = route({
    update: u,
    ...ctx(),
    resolveTopic: (id) => (id === 5001 ? 'belfry' : null),
  });
  // Topic binding is the routing intent — body is empty but goes to belfry.
  assert.equal(r.action, 'deliver');
  assert.equal(r.slug, 'belfry');
});

test('forum topic: unmapped topic id falls through to existing routes', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      message_thread_id: 9999,
      text: 'just chatter',
    },
  };
  const r = route({
    update: u,
    ...ctx(),
    resolveTopic: () => null,
  });
  // No topic match, no quote-reply, no prefix → unmatched
  assert.equal(r.action, 'unmatched');
});

test('caption is used as routing text when text is empty (photo with caption)', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      photo: [{ file_id: 'abc' }],
      caption: '/belfry restart',
    },
  };
  const r = route({ update: u, ...ctx() });
  assert.deepEqual(r, { action: 'deliver', slug: 'belfry', text: 'restart', messageId: 99 });
});

test('photo with no caption + quote-reply still routes via quote-reply', () => {
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      photo: [{ file_id: 'abc' }],
      reply_to_message: { message_id: 42 },
    },
  };
  const r = route({ update: u, ...ctx({ tracked: [[42, 'life-planner']] }) });
  assert.equal(r.action, 'deliver');
  assert.equal(r.slug, 'life-planner');
});

test('photo with no caption and no quote-reply → null (drops)', () => {
  // Routing intent must come from somewhere — caption or quote-reply. v1
  // doesn't auto-route bare photos via the agent.
  const u = {
    message: {
      message_id: 99,
      chat: { id: CHAT },
      photo: [{ file_id: 'abc' }],
    },
  };
  const r = route({ update: u, ...ctx() });
  assert.equal(r, null);
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

test('quote-reply with "full" + stash → full-expand action', () => {
  const r = route({
    update: update({ text: 'full', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'belfry']] }),
    hasFullStash: (id) => id === 42,
  });
  assert.deepEqual(r, { action: 'full-expand', targetMessageId: 42, messageId: 99 });
});

test('"full" case-insensitive, slash-optional, whitespace-tolerant', () => {
  const variations = ['full', 'FULL', 'Full', ' full ', '/full'];
  for (const text of variations) {
    const r = route({
      update: update({ text, replyToId: 7 }),
      ...ctx({ tracked: [[7, 'belfry']] }),
      hasFullStash: (id) => id === 7,
    });
    assert.equal(r.action, 'full-expand', `text=${JSON.stringify(text)} should trigger full-expand`);
  }
});

test('quote-reply with "full" but no stash → falls through to deliver', () => {
  // Stash expired or never existed; the body should land in the session
  // like any other quote-reply so the user isn't silently dropped.
  const r = route({
    update: update({ text: 'full', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'belfry']] }),
    hasFullStash: () => false,
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'belfry', text: 'full', messageId: 99 });
});

test('"full" without quote-reply → unmatched (no implicit slug)', () => {
  // Without a reply_to, we don't know which stash to expand. Drop to the
  // conversational agent rather than guessing.
  const r = route({
    update: update({ text: 'full' }),
    ...ctx(),
    hasFullStash: () => true,
  });
  assert.equal(r.action, 'unmatched');
});

test('"full me" (extra word) is NOT a full-expand trigger', () => {
  const r = route({
    update: update({ text: 'full me', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'belfry']] }),
    hasFullStash: () => true,
  });
  // Should route to deliver, not full-expand.
  assert.equal(r.action, 'deliver');
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

// ── Broadcast /all (#30) ──────────────────────────────────────────────────

test('/all <body> routes to a broadcast action', () => {
  const r = route({ update: update({ text: '/all wrap up and commit' }), ...ctx() });
  assert.deepEqual(r, { action: 'broadcast', text: 'wrap up and commit', messageId: 99 });
});

test('/all is case-insensitive and trims the body', () => {
  const r = route({ update: update({ text: '/ALL   status check  ' }), ...ctx() });
  assert.deepEqual(r, { action: 'broadcast', text: 'status check', messageId: 99 });
});

test('bare "all" without a slash is NOT a broadcast (too common in prose)', () => {
  const r = route({ update: update({ text: 'all good here' }), ...ctx() });
  assert.notEqual(r?.action, 'broadcast');
});

test('bare "/all" with no body falls through (not a broadcast)', () => {
  const r = route({ update: update({ text: '/all' }), ...ctx() });
  assert.notEqual(r?.action, 'broadcast');
});

test('a quote-reply "/all x" is NOT a broadcast — it talks to the quoted slug', () => {
  const r = route({
    update: update({ text: '/all keep going', replyToId: 42 }),
    ...ctx({ tracked: [[42, 'life-planner']] }),
  });
  assert.deepEqual(r, { action: 'deliver', slug: 'life-planner', text: '/all keep going', messageId: 99 });
});

test('"all" is reserved on the prefix path (never delivers to a session named all)', () => {
  // /all with a body but NOT matched as broadcast would only happen if ALL_RE
  // failed; ensure a session literally named "all" can't be hit via prefix.
  const r = route({ update: update({ text: '/all do thing' }), ...ctx({ knownSlugs: ['all'] }) });
  assert.equal(r.action, 'broadcast', 'still a broadcast, never a deliver to slug "all"');
});
