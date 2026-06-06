<!-- title: Inline approval buttons for permission prompts -->
## Motivation

When Claude Code blocks on a permission prompt (PreToolUse / Notification), belfry currently sends a `waiting` ping with the prompt text, and the user replies with free-form text — `/yes`, `allow`, "do it", whatever. The session has to interpret the reply as approval or denial.

Two costs on this path:

1. **Friction.** Three taps to type `yes`. On the lock screen, the difference between "tap the green button" and "open the app, focus the chat, type, send" is the difference between approving from a coffee shop and waiting until I'm at a desk.
2. **Ambiguity.** "ok" / "yeah" / "go ahead" / "no don't" all need the model to interpret intent, which is fine in conversation but unnecessarily expensive for the binary case.

Telegram natively supports inline keyboards on bot messages (`InlineKeyboardMarkup`). Tap a button → bot receives a `callback_query` with the user's choice. Belfry can render `[Allow] [Deny] [Always] [Defer]` directly into the `waiting` ping and resolve the prompt in one tap.

## Shape

### Detection

belfry-hook already classifies the event as `waiting` when Claude Code emits a `Notification` (the existing path). When the dashboard JSON's status flips to `waiting`, the composer adds the inline keyboard.

```
ready → status text only
error → status text only
waiting → status text + InlineKeyboardMarkup with 4 buttons
```

The four buttons:

- **Allow** — approve this single prompt
- **Deny** — reject this single prompt
- **Always** — approve and remember (when the session supports it; otherwise alias to Allow)
- **Defer** — dismiss without answering; the session keeps waiting for a manual reply

### Wire format

`callback_data` is the field Telegram delivers back when the user taps. It's capped at 64 bytes per button. Encode `<slug>:<verb>:<message_id>`:

```
belfry:allow:1234
belfry:deny:1234
belfry:always:1234
belfry:defer:1234
```

`message_id` is the id of the outbound waiting-ping message that owns the buttons. The poller's `getUpdates` already includes `callback_query` updates if we add `callback_query` to `allowed_updates`.

### Routing inbound

Add a fourth router action: `{ action: 'approval', slug, verb, messageId }`. Daemon dispatches to `makeApprovalHandler` which:

1. Translates verb → text (`Allow` → `yes`, `Deny` → `no`, `Always` → `yes (always)`, `Defer` → bail).
2. Calls `registry.deliver(slug, text, messageId)` — same path quote-reply uses.
3. Edits the original waiting message to remove the buttons and append `→ Allowed (08:43)` so the user has visual confirmation and the buttons can't be tapped twice.
4. Sends `answerCallbackQuery` so Telegram dismisses the loading spinner on the user's tap.

### `Always` semantics

The session decides whether `always` is meaningful. For now, belfry forwards literal `yes (always)` and the model interprets it. Future: a small protocol where the spoke returns "I supported your `Always`, here's how it persists" via a structured channel notification, and belfry surfaces that in the edited message.

## Inspiration

The pattern is already shipped in [jsayubi/ccgram](https://github.com/jsayubi/ccgram) (MIT) — they wire `Allow / Deny / Always / Defer` against a blocking PreToolUse hook with the same callback-query shape. Belfry's existing channel-notification path means we don't need to block the hook; we forward the verb as injected user input.

## Open questions

- **Single-tap binding.** If two waiting prompts land in fast succession from the same slug, the second's keyboard overlaps the first. Probably fine — buttons live on the message they were sent with — but worth confirming Telegram doesn't dedupe identical keyboards.
- **Defer on auto-reply.** If the user picks `Defer`, the session is still in `waiting`. The auto-reply path won't fire until they explicitly reply. That's the correct behavior, but worth a doc note.
- **`Always` for permission-system slugs without that concept.** Most projects don't have a per-tool "remember" feature. We probably alias to `Allow` and live with it.

## Non-goals

- Not a permission-rule editor. The buttons answer the prompt at hand; managing the underlying allow/deny rules is a Claude Code concern, not belfry's.
- Not for non-`waiting` messages. Buttons attached to `ready`/`error` pings would be visual clutter for no benefit.
- Not for inline-keyboard-driven session control (no `[Restart] [Cancel]` buttons). Out of scope until there's a clear use case the existing `/<slug>` body path doesn't cover.
