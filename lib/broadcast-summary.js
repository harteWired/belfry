/**
 * Build the roll-up message the daemon posts when a `/all` broadcast completes
 * (#30) — every targeted session replied, or the timeout fired. Pure + tested;
 * the daemon (bin/belfry.js) just sends the returned string.
 *
 * The authoritative denominator is `expected` (the slugs the fan-out actually
 * reached), NOT the count of collected responses — a stray reply that threads
 * under the broadcast anchor without having been targeted (e.g. a directed
 * quote-reply to the /all message mid-flight) must not inflate "N/N". Summary
 * lines are likewise restricted to the expected set, in fan-out order.
 */

const DEFAULT_LINE_CAP = 220;

export function buildBroadcastSummary({ expected = [], responses = new Map(), missing = [], timedOut = false, lineCap = DEFAULT_LINE_CAP } = {}) {
  const total = expected.length;
  const repliedSlugs = expected.filter((s) => responses.has(s));
  const replied = repliedSlugs.length;
  const head = timedOut
    ? `⏱ Broadcast ${replied}/${total} replied${missing.length ? ` — no reply from: ${missing.join(', ')}` : ''}`
    : `📋 Broadcast complete (${replied}/${total})`;
  const lines = repliedSlugs.map((slug) => `• ${slug}: ${clipLine(responses.get(slug), lineCap)}`);
  return [head, ...lines].join('\n');
}

// Clip BEFORE collapsing whitespace so we don't scan a whole multi-KB reply to
// throw away all but the first ~220 chars. Slice with a small buffer, collapse,
// then hard-clip to the cap.
function clipLine(text, cap) {
  const slice = String(text ?? '').slice(0, cap + 40);
  const oneLine = slice.replace(/\s+/g, ' ').trim();
  return oneLine.length > cap ? oneLine.slice(0, cap - 1) + '…' : oneLine;
}
