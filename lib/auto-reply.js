/**
 * Auto-reply: when a Telegram message has been routed into a session and the
 * session next produces a fresh `last_response`, quote-reply that response
 * back to Telegram on behalf of the model.
 *
 * Pure function over four injectables — no module-level state, fully testable
 * without spinning up the daemon. The owes-reply marker store lives on the
 * Registry; this module reads it via callbacks rather than reaching into the
 * Registry directly so the dependency direction is one-way.
 *
 * The decision rules, in order:
 *   1. The slug must have a pending owes-reply marker.
 *   2. The new status must be `ready` — partial transitions (working → idle,
 *      etc.) shouldn't drain the marker on a still-in-progress turn.
 *   3. statusFile.last_response must be a non-empty string.
 *   4. last_response must differ from prevStatusFile?.last_response — guards
 *      against duplicate chokidar events that re-emit the same content.
 *
 * If all hold, the marker is cleared synchronously *before* the network call
 * so concurrent watcher events for the same slug can't race two sends to the
 * same originating message.
 */

const RESPONSE_CAP = 4000;

export function maybeAutoReply({
  slug,
  statusFile,
  prevStatusFile,
  newStatus,
  getOwesReply,
  clearOwesReply,
  sendOutbound,
  log = () => {},
}) {
  const pending = getOwesReply(slug);
  if (!pending) return false;
  if (newStatus !== 'ready') return false;
  const response = typeof statusFile?.last_response === 'string' ? statusFile.last_response : '';
  if (response.length === 0) return false;
  if (response === (prevStatusFile?.last_response ?? '')) return false;

  // Synchronous claim: clearing before await prevents a second concurrent
  // watcher event from observing the same un-cleared marker and double-sending.
  clearOwesReply(slug);

  const text = response.length > RESPONSE_CAP ? response.slice(0, RESPONSE_CAP - 1) + '…' : response;
  Promise.resolve(sendOutbound({ slug, text, replyToMessageId: pending }))
    .catch((err) => log(`auto-reply failed for ${slug}: ${err.message}`));
  return true;
}
