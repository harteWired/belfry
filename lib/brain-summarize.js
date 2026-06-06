/**
 * Brain-backed summarization — replaces lib/summarizer.js's raw-fetch-to-
 * Anthropic-Messages-API path with a brain.send() call. Same return shape
 * as before so callers (throttle dispatch, digest flush, /status handler)
 * don't change.
 *
 * Two functions:
 *   summarize({prompt, response}) → {prompt: string|null, response: string|null} | null
 *   summarizeBatch({events})      → string | null
 *
 * Both return null on any failure (brain down, parse failure, empty text)
 * — caller falls back to the existing truncate / raw-text path.
 *
 * The brain shares one process across summarize calls AND across the
 * agent (classify) calls. We tell it explicitly that summarize prompts
 * are stateless work and to ignore prior turn context. Haiku largely
 * complies; if context bleed becomes a real problem, we can spawn a
 * second brain dedicated to summarization.
 */

const SUMMARIZE_PROMPT_PREAMBLE = [
  'SUMMARIZE — independent task, ignore prior context.',
  'Compress one Claude Code session ping into two short lines suitable for a phone lock-screen preview.',
  'Each summary line ≤100 chars, plain text, no markdown, no quotes.',
  'Capture intent, not literal phrasing — paraphrase aggressively.',
  '',
  'Output exactly:',
  'USER: <one-line summary of what the user asked, or - if nothing>',
  'CLAUDE: <one-line summary of what Claude did or said, or - if nothing>',
  '',
  'Do not call any MCP tools. Reply with the two lines only.',
].join('\n');

const DIGEST_PROMPT_PREAMBLE = [
  'SUMMARIZE BATCH — independent task, ignore prior context.',
  'Compress a burst of Claude Code session pings into a short digest for a phone lock-screen.',
  'Output 2–4 short lines, plain text, no markdown, no quotes.',
  'Each line is one fact or outcome — paraphrase aggressively, do not list every event verbatim.',
  'Lead with the most important state. If multiple statuses appeared, mention the trajectory (e.g. "errored then recovered").',
  'No preamble, no closing remarks — just the lines.',
  'Do not call any MCP tools. Reply with the digest body only.',
].join('\n');

function parseModelOutput(text) {
  const out = { prompt: null, response: null };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(/^(USER|CLAUDE):\s*(.*)$/i);
    if (!m) continue;
    const value = m[2].trim();
    if (!value || value === '-') continue;
    if (m[1].toUpperCase() === 'USER') out.prompt = value;
    else out.response = value;
  }
  return out;
}

function buildSummarizeUser(prompt, response) {
  return `User said:\n${prompt || '(none)'}\n\nClaude said:\n${response || '(none)'}`;
}

function buildBatchUser(events) {
  const parts = [];
  parts.push(`The session produced ${events.length} event(s) in this burst:\n`);
  events.forEach((e, i) => {
    parts.push(`#${i + 1} [${e.status ?? '?'}] ${e.statusLabel ? `(${e.statusLabel}) ` : ''}`);
    if (e.prompt) parts.push(`  user: ${e.prompt}`);
    if (e.response) parts.push(`  claude: ${e.response}`);
  });
  return parts.join('\n');
}

export function makeBrainSummarizers({ brain, log = () => {} }) {
  const summarize = async ({ prompt, response }) => {
    if (!brain || !brain.isAlive()) return null;
    const hasPrompt = typeof prompt === 'string' && prompt.length > 0;
    const hasResponse = typeof response === 'string' && response.length > 0;
    if (!hasPrompt && !hasResponse) return null;
    try {
      const text = await brain.send(`${SUMMARIZE_PROMPT_PREAMBLE}\n\n${buildSummarizeUser(prompt, response)}`);
      if (!text) return null;
      const parsed = parseModelOutput(text);
      if (parsed.prompt === null && parsed.response === null) return null;
      return parsed;
    } catch (err) {
      log(`brain-summarize: ${err.message}`);
      return null;
    }
  };

  const summarizeBatch = async ({ events }) => {
    if (!brain || !brain.isAlive()) return null;
    if (!Array.isArray(events) || events.length === 0) return null;
    try {
      const text = await brain.send(`${DIGEST_PROMPT_PREAMBLE}\n\n${buildBatchUser(events)}`);
      if (!text) return null;
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      log(`brain-summarize batch: ${err.message}`);
      return null;
    }
  };

  return { summarize, summarizeBatch };
}

export const _internals = { parseModelOutput, buildSummarizeUser, buildBatchUser, SUMMARIZE_PROMPT_PREAMBLE, DIGEST_PROMPT_PREAMBLE };
