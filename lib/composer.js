/**
 * Three-line mobile-friendly message composer.
 *
 * Format:
 *   🔔 <project> — <status label>
 *
 *   You: <last user prompt, truncated>
 *   Claude: <last assistant response, truncated>
 *
 * No markdown tables, no nesting, no ASCII art. Optimized for lock-screen
 * preview density. The user should be able to triage at a glance.
 */

const STATUS_EMOJI = {
  ready: '🔔',
  error: '🚨',
  waiting: '⏳',
};

function truncate(text, cap) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (text.length <= cap) return text;
  return text.slice(0, cap - 1) + '…';
}

function statusLabel(status, event, statusFile) {
  // Prefer the existing label if claudelike-bar already composed one
  // (e.g. "Working (3 agents)", "Needs permission", "Done"). Fall back to
  // the raw status code if not.
  if (typeof statusFile?.statusLabel === 'string' && statusFile.statusLabel.length > 0) {
    return statusFile.statusLabel;
  }
  return status;
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
  const header = `${emoji} ${project} — ${label}`;

  const prompt = truncate(statusFile?.last_prompt, promptCap);
  const response = truncate(statusFile?.last_response, responseCap);

  const lines = [header];
  if (prompt || response) {
    lines.push('');
    if (prompt) lines.push(`You: ${prompt}`);
    if (response) lines.push(`Claude: ${response}`);
  }
  if (replyFooter) {
    lines.push('');
    lines.push('↩ Reply to drive');
  }
  return lines.join('\n');
}
