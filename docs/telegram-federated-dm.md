# Telegram → federated-session direct messaging (#44)

Lets the human direct-message a session living on a **federated peer host** from
Telegram — e.g. `/keeper hi` reaching `e/erebus-master` on Erebus, with the
reply coming back to the chat. Before this, Telegram inbound could only address
sessions in the **bot-owner's local registry**; a peer session was reachable
only agent-to-agent (`send_to`), so the human had to message a local session and
have it relay.

## Why it didn't work

1. **Local-only deliver.** The Telegram inbound path (`poller` → `router.route()`
   → `target.deliver(slug,…)`) calls `registry.deliver`, which injects into a
   locally-registered session. It never consults the federation router.
2. **No way to name a peer.** The `/<slug>` command grammar and `/nick` target
   are `[a-z0-9][a-z0-9._-]*` — no `/` — so the host-qualified federation
   address `e/erebus-master` couldn't even be typed.

(The mesh data plane itself already worked: `relayRemote` forwards a `message`
envelope to the owning host, and a reply is just another `message` envelope back
to the sender's host-qualified slug.)

## How it works now

A **Telegram bridge slug** (default `telegram`, configurable via
`federation.telegramBridgeSlug`) is the local identity the bot wears on the mesh.

```
/keeper hi                         (Telegram)
  → router resolves nick "keeper" → "e/erebus-master"
  → deliveryTarget sees a federated slug → federation.relayRemote("telegram", "e/erebus-master", "hi")
  → message envelope j/telegram → e/erebus-master           (over /fed)
erebus-master replies with send_to("j/telegram", "...")
  → message envelope e/erebus-master → j/telegram           (over /fed)
  → Jinn onMessage sees to.slug == bridge slug → telegramBridge.deliver("e/erebus-master", "...")
  → sendOutbound posts it to the chat + records message_id → "e/erebus-master"
  → a quote-reply to that message routes back to e/erebus-master (the loop continues)
```

No correlation id is needed: the round-trip rides ordinary `message` envelopes,
exactly like session↔session relay. Quote-reply continuation works because the
posted reply is recorded in the reply-tracker against the federated address, and
`deliveryTarget` routes a federated slug over the mesh.

## The pieces

| File | Change |
|------|--------|
| `lib/router.js` | `NICK_SET_RE` accepts an optional `<letter>/` host prefix on the target, so `/nick keeper e/erebus-master` parses. |
| `lib/nicknames.js` | `set()` accepts a federated target (`<letter>/<slug>`) and skips the active-local-session check for it; bare-slug behavior unchanged. |
| `lib/federation-daemon.js` | New injected `telegramBridge { slug, deliver(fromQualified, text) }`. `onMessage` routes a message addressed to the bridge slug to `deliver` instead of the local registry. |
| `bin/belfry.js` | Defines the bridge slug; wraps the poller's delivery target so a federated routed slug forwards via `relayRemote` from the bridge; wires `telegramBridge.deliver` to `sendOutbound` (which records the reply-tracker mapping for quote-reply). |

## Usage

```
/nick keeper e/erebus-master      # one-time, from Telegram
/nick plex   e/plex-manager
/keeper what's the plex-manager status?
/plex resume the approved grabs
```

Replies thread into the chat; quote-reply to continue without retyping the nick.

## Notes & limits

- **Text only** across the bridge (no attachment forwarding to a federated
  session yet).
- The remote session sees the human as `origin="agent" from="j/telegram"`. Agent
  charters on peer hosts should note that `j/telegram` is the human via Telegram
  (reply normally), not a peer agent.
- Federated nicks are set via `/nick` (self-serve) or the `nicknames` config
  block (`bootstrap`), which already accepts host-qualified targets.
- The deterministic `/keeper` path and quote-reply are covered; the brain's
  conversational deliver path stays local-only for now.
