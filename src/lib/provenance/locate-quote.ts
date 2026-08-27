/**
 * One ordered slice of a source entry's content. `match` slices are exact,
 * verbatim occurrences of the Highlight's quotedText; the rest is context.
 */
export type QuoteSegment = { text: string; match: boolean };

/**
 * Split `content` into ordered segments, marking every EXACT (verbatim,
 * case-sensitive) occurrence of `quotedText`.
 *
 * Matching semantics are deliberately identical to the server's
 * `countOccurrences` in the highlights route: plain `String.indexOf`, no
 * normalisation, no regex, non-overlapping. `locateQuote` therefore never
 * finds a match the API reported as absent, and
 * `countMatches(locateQuote(content, q))` always equals the API's
 * `occurrenceCount`.
 *
 * Render-only: concatenating every returned segment's `text` reproduces
 * `content` byte-for-byte. Nothing is mutated.
 *
 *   quotedText === ""      → [{ text: content, match: false }]  (no anchor)
 *   no occurrence          → [{ text: content, match: false }]
 *   whole content matches  → [{ text: content, match: true }]
 */
export function locateQuote(content: string, quotedText: string): QuoteSegment[] {
  if (quotedText.length === 0) {
    return [{ text: content, match: false }];
  }

  const segments: QuoteSegment[] = [];
  let position = 0;

  while (true) {
    const index = content.indexOf(quotedText, position);
    if (index === -1) break;

    if (index > position) {
      segments.push({ text: content.slice(position, index), match: false });
    }
    segments.push({ text: quotedText, match: true });
    position = index + quotedText.length;
  }

  if (position < content.length) {
    segments.push({ text: content.slice(position), match: false });
  }

  // No occurrence at all (or empty content): still return one truthful,
  // non-matching segment so callers never render an empty box.
  if (segments.length === 0) {
    segments.push({ text: content, match: false });
  }

  return segments;
}

/** Number of exact-match segments — mirrors the API's occurrenceCount. */
export function countMatches(segments: QuoteSegment[]): number {
  return segments.reduce((n, s) => n + (s.match ? 1 : 0), 0);
}
