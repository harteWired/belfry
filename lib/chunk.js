/**
 * Paragraph-aware text chunking for Telegram. Mirrors the splitting
 * algorithm used by the official telegram plugin: prefer to break on a
 * blank line (`\n\n`), then a line break, then a space, falling back to a
 * hard cut only when there's no breath in sight. Each chunk is at most
 * `limit` chars.
 *
 * Returns at least one chunk. An empty input yields an empty array.
 */
export function chunkParagraphAware(text, limit) {
  if (typeof text !== 'string') throw new TypeError('chunkParagraphAware: text must be a string');
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('chunkParagraphAware: limit must be a positive integer');
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const out = [];
  let rest = text;
  // Require the break to land in the second half of the allowed window —
  // otherwise an unlucky paragraph break near the start would produce a
  // tiny chunk and re-split the long tail aggressively. Matches the
  // official plugin's heuristic.
  const minCut = Math.floor(limit / 2);
  while (rest.length > limit) {
    let cut = limit;
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    if (para > minCut) cut = para;
    else if (line > minCut) cut = line;
    else if (space > 0) cut = space;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
