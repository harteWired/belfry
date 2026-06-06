<!-- title: Optional forum-topic routing per slug -->
## Motivation

Belfry currently routes inbound replies via two mechanisms: quote-reply on a specific outbound message, or `/<slug-name> body` prefix. Both work, but they share a property: there's no persistent visual binding between a slug and a chat surface. Every message about every slug lives in the same flat chat thread, distinguished only by the outbound message's display name.

Telegram Forum groups (groups with topics enabled) provide a natural mapping: **one topic per slug**. Users see "obsidian-vault", "belfry", "life-planner" as separate tabs in the group. Outbound pings post to the matching topic; inbound replies in a topic auto-route to that slug without needing quote-reply or prefix.

This isn't a replacement for the existing routing — it's a layered add. Some slugs deserve their own topic (the noisy ones, the ones you triage actively); others are happy in the main chat.

## Shape

### Mapping

Already partially supported: `BELFRY_FORUM_TOPIC_ID` env var posts every message to one fixed topic of a forum group. Generalize to per-slug:

```jsonc
{
  "subscriptions": {
    "obsidian-vault": {
      "events": ["ready", "error", "waiting"],
      "topic": "obsidian"   // matches a topic name in the forum group
    }
  }
}
```

The daemon resolves topic names → topic IDs at startup via Telegram's `getForumTopicIconStickers` / `editForumTopic` machinery, or a one-time `BELFRY_FORUM_TOPIC_MAP` env override. (Telegram doesn't expose a clean "list all topics" call as of the last Bot API update — needs verifying. If topic-ID-only is the only path, the config takes IDs directly.)

### Outbound

`sendMessage` already accepts `message_thread_id`. Wire the per-slug topic id into outbound:

```js
sendMessage({ botToken, chatId, text, forumTopicId: subscription.topicId, ... })
```

If a slug has no `topic`, fall back to the existing `BELFRY_FORUM_TOPIC_ID` (single-topic mode) or main chat.

### Inbound

Telegram delivers `message_thread_id` on inbound messages. Add a third routing path before the existing prefix and quote-reply:

```
1. /status, /nick, etc. — reserved commands (existing)
2. message.message_thread_id matches a topic mapped to slug X → action='deliver' to X (new)
3. quote-reply (existing)
4. /<slug> prefix (existing)
5. unmatched → agent (existing)
```

Topic-binding wins over prefix-and-body (because the topic is unambiguous about target slug), but loses to quote-reply within a topic (because the user explicitly named a different message).

### Auto-create topics?

Out of scope for v1. Topic creation requires admin rights on the forum group, and managing topic lifecycle from the daemon would introduce state synchronization between the daemon and the chat. v1 assumes topics already exist; v2 can revisit.

## Inspiration

[six-ddc/ccbot](https://github.com/six-ddc/ccbot) (MIT) and [kidandcat/ccc](https://github.com/kidandcat/ccc) (MIT) both use Telegram forum topics as their primary multi-session routing primitive (one topic = one session). They lean harder on it (no quote-reply / prefix paths to compete with) which is a more rigid model than belfry's. The takeaway is the *option* of topic-as-routing, not the exclusive mechanism.

## Open questions

- **Topic enumeration via Bot API.** As of mid-2025, Telegram bots cannot list a forum group's topics; they have to be told the IDs out-of-band (or be the creator of the topic via `createForumTopic`, which requires admin rights). For a single-user setup this is fine — paste the IDs in the config once. Worth confirming the API hasn't gained a list endpoint since.
- **Mixed-mode.** What if some slugs have topics and others don't? Outbound to topic-bound slugs goes to their topic; outbound to others goes to the main chat. Inbound from a topic routes to that slug; inbound from main chat routes via prefix/quote-reply/agent. Internally consistent but two separate cognitive surfaces — worth a doc.
- **Auto-reply to topic.** Auto-reply currently quote-replies the originating inbound message. With a topic-bound slug, it should post into the topic instead (no quote-reply needed since the topic is unambiguous). Small composer tweak.

## Non-goals

- Not auto-creating topics from belfry. Group admin only.
- Not migrating existing config. Existing single-topic and main-chat setups continue working unchanged; per-slug `topic` is opt-in.
- Not topic-per-message_id (Telegram has reply threads inside topics; we don't need a third level of nesting).
