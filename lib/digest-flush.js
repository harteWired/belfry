/**
 * Digest flush body, extracted from `bin/belfry.js` so it's unit-testable
 * without spinning up timers, network, or chokidar. Same factory shape as
 * `makeStatusHandler`: take dependencies via injection, return a closure
 * that matches the `Digest` constructor's `flush` callback contract.
 *
 * Responsibilities:
 *   1. Truncate each event's prompt/response (so a chatty burst doesn't
 *      send tens of KB to Haiku — `summarizeBatch` already has its own
 *      timeout, but bandwidth and context are cheaper to bound here).
 *   2. Call `summarizeBatch` if available; fall back to a `Latest:`
 *      summary inside `composeDigest` if the model call returns null.
 *   3. Send via Telegram and record the outbound message_id against the
 *      slug in the reply-tracker so quote-replies route correctly.
 *
 * Anything beyond these three steps is the daemon's job, not this module's.
 */

import { composeDigest } from './composer.js';

function cap(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function makeDigestFlush({
  promptCap,
  responseCap,
  summarizeBatchFn = null,
  send,
  recordReply = null,
  log = () => {},
}) {
  return async (slug, events) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const latest = events[events.length - 1];
    const truncated = events.map((e) => ({
      status: e.status,
      statusLabel: e.statusFile?.statusLabel,
      prompt: cap(e.statusFile?.last_prompt, promptCap),
      response: cap(e.statusFile?.last_response, responseCap),
    }));
    const summary = summarizeBatchFn ? await summarizeBatchFn({ events: truncated }) : null;
    const text = composeDigest({
      slug,
      displayName: latest?.statusFile?.displayName ?? slug,
      count: events.length,
      summary,
      latestStatus: latest?.status,
      replyFooter: true,
    });
    try {
      const result = await send({ slug, text });
      if (recordReply && result?.message_id) recordReply(result.message_id, slug);
      log(`sent ${slug}: digest ${events.length} events (${text.length} chars, msg ${result?.message_id})`);
    } catch (err) {
      log(`digest send failed for ${slug}: ${err.message}`);
    }
  };
}
