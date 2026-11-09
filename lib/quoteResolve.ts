/**
 * Quote verification — split out of lib/extraction.ts so the extraction gate
 * (lib/extractionGate.ts) can use it without importing the database client.
 * lib/extraction.ts re-exports `resolveQuote`, so existing imports are unchanged.
 */

/**
 * Resolve the model's `direct_quote` against the chunk it came from, and keep
 * ONLY what is genuinely verbatim.
 *
 * The Evidence panel presents `direct_quote` to a clinician as the source's own
 * words, so an unverified quote is the system asserting substance it cannot
 * trace — principle 1. Measured on the 2026-07-24 corpus (`eval:extraction
 * verify`), **27% of stored quotes could not be found in their chunk**, and the
 * old code stored them anyway with null offsets. They were not fabrications:
 * 89% *started* in the chunk and 41% contained ellipses — the model stitching
 * two non-contiguous spans, which the prompt explicitly forbids.
 *
 * So, in order:
 *   1. exact hit — the normal case;
 *   2. an ellipsis-joined quote whose fragments are each verbatim — a real
 *      multi-span quote, kept as the model wrote it, anchored at fragment one;
 *   3. otherwise the longest verbatim PREFIX (down to a floor, so a stray
 *      three-word match never passes as a citation);
 *   4. nothing verifiable → drop the quote. A missing quote degrades the
 *      Evidence panel; a wrong one misleads it.
 *
 * Matching normalises whitespace and smart punctuation, since a curly apostrophe
 * against a straight one is a transcription artefact, not a fidelity failure.
 */
export function resolveQuote(
  content: string,
  raw: string | null | undefined
): { text: string | null; start: number | null; end: number | null } {
  const quote = raw?.trim()
  if (!quote) return { text: null, start: null, end: null }

  const exact = content.indexOf(quote)
  if (exact >= 0) return { text: quote, start: exact, end: exact + quote.length }

  // Normalised search: fold whitespace runs and unify smart punctuation, then map
  // the hit back to an offset in the ORIGINAL content (offsets are what the UI
  // highlights, so they must index the real text).
  const fold = (s: string) =>
    s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
     .replace(/[–—]/g, '-').replace(/\s+/g, ' ')
  const foldedContent = fold(content)

  /** Offset in `content` of the nth char of `foldedContent`, walking both. */
  const mapBack = (foldedIdx: number): number => {
    let ci = 0, fi = 0
    while (fi < foldedIdx && ci < content.length) {
      const isWs = /\s/.test(content[ci])
      if (isWs) {
        while (ci < content.length && /\s/.test(content[ci])) ci++
        fi++ // the whole run folded to one space
      } else {
        ci++; fi++
      }
    }
    return ci
  }

  const findFolded = (needle: string): { start: number; end: number } | null => {
    const f = fold(needle).trim()
    if (!f) return null
    const at = foldedContent.indexOf(f)
    if (at < 0) return null
    return { start: mapBack(at), end: mapBack(at + f.length) }
  }

  const hit = findFolded(quote)
  if (hit) return { text: quote, start: hit.start, end: hit.end }

  // Ellipsis-joined multi-span quote: legitimate only if EVERY fragment is
  // verbatim. One unverifiable fragment invalidates the whole citation.
  const fragments = quote.split(/\s*(?:\.\.\.|…)\s*/).map(f => f.trim()).filter(f => f.length > 0)
  if (fragments.length > 1) {
    const hits = fragments.map(findFolded)
    if (hits.every(Boolean)) {
      const first = hits[0] as { start: number; end: number }
      const last = hits[hits.length - 1] as { start: number; end: number }
      return { text: quote, start: first.start, end: Math.max(first.end, last.end) }
    }
  }

  // Longest verbatim prefix, trimmed at a word boundary. The floor keeps a
  // fragment too short to be evidence from being presented as a citation.
  const MIN_QUOTE_CHARS = 40
  let lo = MIN_QUOTE_CHARS
  let best: { text: string; start: number; end: number } | null = null
  for (let hi = quote.length; lo <= hi; ) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const candidate = quote.slice(0, mid).replace(/\s+\S*$/, '')
    const found = candidate.length >= MIN_QUOTE_CHARS ? findFolded(candidate) : null
    if (found) {
      best = { text: candidate, start: found.start, end: found.end }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best) return { text: best.text, start: best.start, end: best.end }

  return { text: null, start: null, end: null }
}
