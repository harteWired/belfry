/**
 * deliveryTarget — the Poller's injected delivery `target` (#44).
 *
 * The Poller routes an inbound Telegram message to a session by calling its
 * `target`. That contract is THREE methods (see lib/poller.js): `deliver`,
 * `hasSlug`, and `knownSlugs`. This wrapper sits in front of the loopback
 * Registry to add ONE behaviour: a host-qualified `<letter>/<slug>` target
 * (#44) is a session on a peer host, so it forwards over the federation mesh
 * from the Telegram bridge identity (the reply then threads back to this chat)
 * instead of delivering locally. Everything else delegates straight to the
 * registry.
 *
 * History: an earlier inline version implemented only `deliver()`. The Poller's
 * `hasSlug` accessor falls back to `target.knownSlugs().has(s)`, so every
 * `/<slug> body` prefix route and nickname route threw
 * `this.target.knownSlugs is not a function` and was silently dropped. Proxying
 * the full interface (and extracting to this testable module) is the fix.
 */

// A host-qualified federation address: `<one-char-host>/<slug>` (#44). A bare
// slug never contains a slash, so this test is unambiguous.
export const FED_SLUG_RE = /^[a-z0-9]\/[a-z0-9][a-z0-9._-]*$/i;

/**
 * @param {object}   opts
 * @param {object}   opts.registry        the loopback Registry (deliver/hasSlug/knownSlugs)
 * @param {object|null} opts.federation   wireFederation() result (relayRemote), or null when federation is off
 * @param {string}   [opts.fedBridgeSlug] the bridge identity used as the relay's from-slug (default "telegram")
 * @param {Function} [opts.log]
 */
export function makeDeliveryTarget({ registry, federation = null, fedBridgeSlug = 'telegram', chatId = null, log = () => {} }) {
  // Fall back to the agent-relay path for a federated slug (the #44 bridge,
  // origin="agent"). Used when there's no Telegram context to forward a HUMAN
  // inbound, and as the local-self redeliver.
  const agentRelay = (slug, text, originatingMessageId, attachment) => {
    federation.relayRemote(fedBridgeSlug, slug, text)
      .then((r) => {
        if (r && r.handled && !r.ok) {
          log(`deliver: federated relay to ${slug} failed: ${r.reason}`);
        } else if (r && !r.handled) {
          // A qualified target always resolves; relayRemote only returns
          // handled:false when it resolved to THIS host — i.e. a local session
          // addressed by its own `<selfLetter>/<slug>` form. Strip the prefix
          // and deliver locally rather than dropping it.
          const bare = slug.slice(slug.indexOf('/') + 1);
          registry.deliver(bare, text, originatingMessageId, attachment);
        }
      })
      .catch((err) => log(`deliver: federated relay to ${slug} threw: ${err.message}`));
  };

  return {
    // Proxy the registry's slug-membership surface so the Poller's router
    // predicate (`hasSlug ? hasSlug(s) : knownSlugs().has(s)`) works.
    hasSlug: (slug) => registry.hasSlug(slug),
    knownSlugs: () => registry.knownSlugs(),

    deliver(slug, text, originatingMessageId = null, attachment = null) {
      if (FED_SLUG_RE.test(slug)) {
        if (!federation) {
          log(`deliver: "${slug}" is a federated address but federation is off — dropping`);
          return 0;
        }
        if (attachment) log(`deliver: dropping attachment for federated "${slug}" (text-only over the bridge)`);
        // #38 Phase 2: a HUMAN Telegram message (has the originating message id +
        // chat) forwards as an INBOUND so the remote session sees belfry
        // provenance (reply tool valid) and direct-sends its reply back. Without
        // a Telegram context (a cold/agent-initiated send), fall back to the
        // agent-relay bridge (#44, origin="agent").
        if (Number.isInteger(originatingMessageId) && Number.isInteger(chatId)) {
          federation.forwardInbound(slug, text, { chatId, originatingMessageId })
            .then((r) => {
              if (!r || !r.forwarded) {
                // Owner resolved to self, peer unreachable, or no live session —
                // fall back to the agent relay (also covers local-self redeliver).
                agentRelay(slug, text, originatingMessageId, attachment);
              }
            })
            .catch((err) => log(`deliver: forwardInbound to ${slug} threw: ${err.message}`));
        } else {
          agentRelay(slug, text, originatingMessageId, attachment);
        }
        return 1; // optimistic — the async forward / relay logs any failure
      }
      return registry.deliver(slug, text, originatingMessageId, attachment);
    },
  };
}
