/**
 * Canonical reference text for belfry's commands and concepts. Single source
 * of truth — both the `/help [topic]` reserved command and the conversational
 * agent's `get_help_text` tool read from here so a question and a command
 * yield identical text.
 *
 * Mobile-friendly: plain text, no markdown tables, soft line breaks. Each
 * topic is bounded so /help returns a single Telegram message that fits in
 * one screen on a phone.
 */

export const HELP_TOPICS = ['all', 'routing', 'nicknames', 'status', 'agent', 'broadcast'];

const HELP = {
  all: `belfry — Telegram for your Claude Code sessions. Commands (the leading slash is optional):

• status — list every active session, one line each
• status <slug> — recent activity for one session
• nick <name> <slug> — alias a long slug to a short name
• unnick <name> — remove an alias
• nicks — list all aliases
• /all <message> — broadcast to every session at once (see /help broadcast)
• help [topic] — this text. Topics: routing, nicknames, status, agent, broadcast

Routing inbound messages: quote-reply on any belfry message to talk to that session. Or "/<slug> body". Or just describe what you want — the conversational layer figures it out.

Try /help nicknames for examples.`,

  routing: `Four ways to talk to a session:

1. Quote-reply. Tap any message belfry sent and reply — your text goes back into that session.
2. Prefix. "/belfry restart the daemon" forwards "restart the daemon" into the belfry session.
3. Nickname. If you "/nick b belfry", then "/b restart" works the same way. See /help nicknames.
4. Conversation. Just type — "ask life-planner what's next on the roadmap". The agent picks the slug.

Quote-reply wins when both a quote and a slug-prefix are present (the quote is more specific).`,

  nicknames: `Nicknames are short aliases for slugs. Useful when slugs are awkward to type on a phone.

  /nick ob obsidian-vault     set
  /unnick ob                  remove
  /nicks                      list

After /nick ob obsidian-vault:
  "/ob run intake"  ≡  "/obsidian-vault run intake"

Rules:
• Names: lowercase letters/numbers/dashes, max 32 chars
• Slug must be active in the dashboard at set-time
• Slugs always win on collisions (a session named "ob" beats a nickname "ob")
• Reserved names: status, nick, unnick, nicks, help

Persisted at ~/.local/state/belfry/nicknames.json.`,

  status: `/status — list every active session, one line each.
/status <slug> — Haiku-summarized digest of recent activity for one session.

The slug arg accepts nicknames too: "/status ob" works if you've nicked ob → obsidian-vault.

If you have an ANTHROPIC_API_KEY in the daemon's env, single-slug /status digests get summarized; otherwise it falls back to the raw status JSON.`,

  agent: `When you type something that doesn't match an explicit route, the conversational layer takes over. It picks one of four intents:

• ask — answers a question about belfry / sessions / state ("what's life-planner doing?")
• route — forwards a message to a specific session ("ask belfry to retry the deploy")
• ambiguous — asks you which session you meant when several plausibly fit
• decline — politely punts when the request is genuinely off-topic

It has read-only access to active sessions, recent messages, and nicknames. It can't run code or set nicknames itself — those use explicit /nick.

Without ANTHROPIC_API_KEY in the daemon env, the agent falls back to a polite decline pointing at /help.`,

  broadcast: `/all <message> — fan one message out to EVERY registered session at once.

  /all wrap up and commit what you have

The leading slash is required (bare "all" is too common in prose). A quote-reply "/all x" is NOT a broadcast — it talks to the quoted session.

What each session gets is TEXT it interprets, not a slash command: "/all /compress" sends the literal text "/compress", it doesn't run the command. Phrase it as an instruction.

Each session is asked to reply succinctly. The daemon threads every reply under your /all message and posts one roll-up when all sessions answer or a 2-minute timeout fires: "📋 Broadcast complete (3/3): …".

From a terminal: belfry-broadcast "message" (with --only a,b or --except c to filter). A session opts out with BELFRY_BROADCAST=false in its env.`,
};

/**
 * Canonical text for a topic. Returns null for unknown topics so the caller
 * can decide whether to render an error or paraphrase.
 */
export function getHelpText(topic = 'all') {
  if (typeof topic !== 'string') return null;
  const normalized = topic.toLowerCase();
  return HELP[normalized] ?? null;
}
