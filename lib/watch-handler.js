/**
 * Telegram /watch control panel (#40). Lets the user manage which projects get
 * proactive pings entirely from the phone — no belfry.jsonc editing, no daemon
 * restart. Backed by lib/subscriptions-store.js (live mutate + persist).
 *
 * Surfaces:
 *   - /watch            → inline-keyboard menu, one tappable toggle per project
 *   - /watch <slug>     → watch (ready+error)
 *   - /watch <slug> ready,error → watch with explicit events
 *   - /unwatch <slug>   → unwatch
 *   - /watching         → list currently-watched
 *   - keyboard tap      → flip a slug + re-render the menu in place
 *
 * Mirrors the approval-button pattern (inline keyboard + callback_query).
 */

import { DEFAULT_WATCH_EVENTS } from './subscriptions-store.js';

const DONE = '__done__';

/**
 * Inline keyboard for the /watch menu: watched-first, 👁 = watched / ◻️ = not,
 * one toggle per row. callback_data = `belfry:watch:<slug>`.
 */
export function watchKeyboard(slugs, isWatched) {
  const sorted = [...slugs].sort((a, b) => {
    const aw = isWatched(a) ? 0 : 1;
    const bw = isWatched(b) ? 0 : 1;
    return aw !== bw ? aw - bw : a.localeCompare(b);
  });
  const rows = sorted.map((slug) => [{
    text: `${isWatched(slug) ? '👁' : '◻️'} ${slug}`,
    callback_data: `belfry:watch:${slug}`,
  }]);
  rows.push([{ text: '✓ Done', callback_data: `belfry:watch:${DONE}` }]);
  return { inline_keyboard: rows };
}

function menuText(store, total) {
  return `👁 Watch menu — tap to toggle (${store.list().length}/${total} watched).\nWatched projects ping you on ready/error.`;
}

function watchingText(store) {
  const w = store.list();
  return w.length ? `👁 Watching (${w.length}): ${w.join(', ')}` : 'Not watching any projects. Send /watch to pick some.';
}

/**
 * @param {object}   opts
 * @param {object}   opts.store          SubscriptionsStore
 * @param {Function} opts.getSlugs       () → iterable of all known slugs (dashboard ∪ registry)
 * @param {Function} opts.send           ({text, replyToMessageId, replyMarkup}) → Promise
 * @param {Function} opts.editMessage    ({messageId, text, replyMarkup}) → Promise
 * @param {Function} opts.answerCallback ({callbackQueryId, text}) → Promise
 * @param {Function} [opts.log]
 */
export function makeWatchHandler({ store, getSlugs, send, editMessage, answerCallback, log = () => {} }) {
  // All slugs the menu should show: everything known PLUS anything currently
  // watched (so a watched project that isn't live right now still appears and
  // can be toggled off).
  const allSlugs = () => {
    const set = new Set(getSlugs());
    for (const s of store.list()) set.add(s);
    return [...set];
  };

  const onRequest = async ({ action, slug, events, messageId }) => {
    if (action === 'watch-menu') {
      const slugs = allSlugs();
      if (slugs.length === 0) {
        await send({ text: 'No projects known yet — open a session (it needs a dashboard file or a live spoke).', replyToMessageId: messageId });
        return;
      }
      await send({ text: menuText(store, slugs.length), replyToMessageId: messageId, replyMarkup: watchKeyboard(slugs, (s) => store.isWatched(s)) });
      return;
    }
    if (action === 'watch-list') {
      await send({ text: watchingText(store), replyToMessageId: messageId });
      return;
    }
    if (action === 'watch-set') {
      const sub = store.watch(slug, events && events.length ? events : DEFAULT_WATCH_EVENTS);
      await send({ text: `👁 Watching "${slug}" (${sub.events.join(', ')}).`, replyToMessageId: messageId });
      log(`watch: ${slug} → ${sub.events.join(',')}`);
      return;
    }
    if (action === 'watch-unset') {
      const was = store.isWatched(slug);
      store.unwatch(slug);
      await send({ text: was ? `🔕 Unwatched "${slug}".` : `"${slug}" wasn't being watched.`, replyToMessageId: messageId });
      if (was) log(`unwatch: ${slug}`);
      return;
    }
  };

  const onToggle = async ({ callbackQueryId, slug, messageId }) => {
    if (slug === DONE) {
      await editMessage({ messageId, text: watchingText(store), replyMarkup: { inline_keyboard: [] } })
        .catch((err) => log(`watch done-edit failed: ${err.message}`));
      await answerCallback({ callbackQueryId, text: 'Done' }).catch(() => {});
      return;
    }
    const nowWatched = store.toggle(slug);
    const slugs = allSlugs();
    await editMessage({ messageId, text: menuText(store, slugs.length), replyMarkup: watchKeyboard(slugs, (s) => store.isWatched(s)) })
      .catch((err) => log(`watch toggle-edit failed: ${err.message}`));
    await answerCallback({ callbackQueryId, text: nowWatched ? `👁 Watching ${slug}` : `🔕 Unwatched ${slug}` }).catch(() => {});
    log(`watch toggle: ${slug} → ${nowWatched ? 'watched' : 'unwatched'}`);
  };

  return { onRequest, onToggle };
}
