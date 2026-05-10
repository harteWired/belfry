/**
 * Telegram message composer. Output is HTML — every consumer must pair
 * compose() / composeDigest() with `parseMode: 'HTML'` on sendMessage.
 *
 * Format (status ping with both prompt + response):
 *
 *   <i>🔔 <project> — <status label></i>
 *
 *   <response, HTML-escaped, full content up to responseCap>
 *
 *   <blockquote expandable>You: <prompt, escaped></blockquote>
 *   <i>↩ Reply to drive</i>
 *
 * Design notes:
 *   - Italic header keeps the "what project / what state" triage info
 *     visible on lock-screen previews but de-emphasizes it visually so
 *     the body is the dominant content.
 *   - Response sits above the prompt: the prompt is context the user
 *     already typed; the response is the new information that drove the
 *     ping. Putting the response first means the lock-screen preview is
 *     showing the value, not what the user already knows.
 *   - Prompt lives in an `<blockquote expandable>` so it's one tap away
 *     when wanted but doesn't consume real estate by default.
 *   - When response is absent (e.g. `waiting` state), the prompt becomes
 *     primary content and we render it inline (non-expandable quote) so
 *     it isn't hidden behind a tap.
 *   - HTML escape is mandatory on any user-supplied substring: prompt,
 *     response, displayName, statusLabel. Header literals are safe.
 */

const STATUS_EMOJI = {
  ready: '🔔',
  error: '🚨',
  waiting: '⏳',
};

// Telegram's per-message hard cap. We don't chunk: bumped per-field caps
// usually keep the composed message well under this. If the composed output
// would exceed it, we truncate the response section with a visible suffix.
const TELEGRAM_TEXT_CAP = 4096;
const TRUNCATION_SUFFIX = '\n…[truncated; full text in terminal]';

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncate(text, cap) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (text.length <= cap) return text;
  return text.slice(0, cap - 1) + '…';
}

function statusLabel(status, event, statusFile) {
  if (typeof statusFile?.statusLabel === 'string' && statusFile.statusLabel.length > 0) {
    return statusFile.statusLabel;
  }
  return status;
}

function fitToTelegramCap(text) {
  if (text.length <= TELEGRAM_TEXT_CAP) return text;
  return text.slice(0, TELEGRAM_TEXT_CAP - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

export function compose({
  slug,
  status,
  event,
  statusFile,
  displayName,
  promptCap,
  responseCap,
  replyFooter = false,
}) {
  const emoji = STATUS_EMOJI[status] ?? '🔔';
  const label = statusLabel(status, event, statusFile);
  const project = displayName || slug;
  const headerLine = `<i>${escapeHtml(`${emoji} ${project} — ${label}`)}</i>`;

  const prompt = truncate(statusFile?.last_prompt, promptCap);
  const response = truncate(statusFile?.last_response, responseCap);

  const lines = [headerLine];

  if (response) {
    lines.push('');
    lines.push(escapeHtml(response));
  }

  if (prompt) {
    lines.push('');
    // Collapse the prompt only when it's supporting context (response present).
    // When there's no response yet, the prompt IS the content — render inline.
    if (response) {
      lines.push(`<blockquote expandable>You: ${escapeHtml(prompt)}</blockquote>`);
    } else {
      lines.push(`<blockquote>You: ${escapeHtml(prompt)}</blockquote>`);
    }
  }

  if (replyFooter) {
    lines.push('');
    lines.push('<i>↩ Reply to drive</i>');
  }
  return fitToTelegramCap(lines.join('\n'));
}

/**
 * Digest message for #11 — multiple events rolled into one ping.
 */
export function composeDigest({ slug, displayName, count, summary, latestStatus, replyFooter = false }) {
  const project = displayName || slug;
  const headerLine = `<i>${escapeHtml(`📋 ${project} — ${count} event${count === 1 ? '' : 's'}`)}</i>`;
  const lines = [headerLine];
  if (summary && summary.length > 0) {
    lines.push('');
    lines.push(escapeHtml(summary));
  } else if (latestStatus) {
    lines.push('');
    lines.push(`<i>Latest: ${escapeHtml(latestStatus)}</i>`);
  }
  if (replyFooter) {
    lines.push('');
    lines.push('<i>↩ Reply to drive</i>');
  }
  return fitToTelegramCap(lines.join('\n'));
}
