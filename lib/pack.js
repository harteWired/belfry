/**
 * Pack an oversized outbound reply down to a Telegram-fit chunk.
 *
 * Strategy:
 *   1. Try the brain — give it the original text and ask for a compressed
 *      version that preserves substance. Bounded by `brainTimeoutMs`.
 *   2. On brain miss (down, slow, throws, or returns oversized text),
 *      fall back to paragraph-aware truncation of the original.
 *
 * Always returns a string that fits within `limit` chars. The caller
 * appends its own "Reply 'full' for the complete response" footer; pack()
 * leaves room for it by accepting a `reservedFooterChars` budget.
 */

import { chunkParagraphAware } from './chunk.js';
import { PACK_PROMPT_PREFIX } from './brain-prompt.js';

const DEFAULT_BRAIN_TIMEOUT_MS = 5_000;

export async function packForTelegram(text, {
  brain = null,
  limit,
  reservedFooterChars = 0,
  brainTimeoutMs = DEFAULT_BRAIN_TIMEOUT_MS,
  log = () => {},
} = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('packForTelegram: text must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('packForTelegram: limit must be a positive integer');
  }
  const target = Math.max(1, limit - reservedFooterChars);

  // If the brain is wired and alive, give it a shot. The system prompt
  // teaches the brain to recognize a PACK request and respond with a
  // single text body, no tools.
  if (brain && typeof brain.isAlive === 'function' && brain.isAlive() && typeof brain.send === 'function') {
    try {
      const packed = await withTimeout(
        brain.send(`${PACK_PROMPT_PREFIX(target)}\n\n${text}`),
        brainTimeoutMs,
      );
      if (typeof packed === 'string') {
        const trimmed = packed.trim();
        if (trimmed.length > 0 && trimmed.length <= target) {
          return { text: trimmed, mode: 'brain' };
        }
        // Brain returned something that didn't actually fit. Fall through
        // to the deterministic truncate path — keeps the contract clean.
        log(`pack: brain returned ${trimmed.length} chars over budget of ${target}, falling back`);
      }
    } catch (err) {
      log(`pack: brain failed (${err.message}), falling back to truncate`);
    }
  }

  // Deterministic fallback: take the first paragraph-aligned chunk that
  // fits, then mark the rest as elided. The user can still recover the
  // full text via "full".
  const chunks = chunkParagraphAware(text, target);
  const head = chunks[0] ?? text.slice(0, target);
  return { text: head.trimEnd(), mode: 'truncate' };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
