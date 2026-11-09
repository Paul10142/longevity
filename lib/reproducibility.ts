/**
 * Extraction reproducibility: pure helpers (2026-11-08). No database, no model calls.
 *
 * Used by scripts/evalReproducibility.ts. Plan: docs/plans/extraction-reproducibility.md
 * (section 3.1 for the metrics, appendix B for matching, appendix C for the context call shape).
 *
 * Four pieces:
 *   1. Documents and offsets: a chunked text ("doc") plus a table that maps a doc offset back to the
 *      copy's raw transcript, so a quote from any pass can be placed in the transcript it came from.
 *   2. Chunkers: `chars` (the production splitter) and `turns` (whole speaker turns, no overlap) and the
 *      CONTEXT BEFORE / CONTEXT AFTER window around a chunk.
 *   3. Matching between two passes: tier 1 (same quoted words), tier 2 (same passage, same meaning).
 *   4. Metrics: pass-specific rate, same-passage miss, boundary share, coverage disagreement,
 *      within-pass duplicates.
 */

import { splitIntoChunks } from './extraction'

// ── 1. Documents and offsets ────────────────────────────────

/** A run of the doc that is a verbatim run of the raw transcript. */
export type Piece = { docStart: number; rawStart: number; len: number }
export type Doc = { text: string; pieces: Piece[] }
export type RemovedRange = { start: number; end: number; kind?: string; preview?: string }

/** Where a doc offset sits in the raw transcript. Offsets inside the single space that joins two pieces map to the end of the earlier piece. */
export function docToRaw(doc: Doc, d: number): number {
  const p = doc.pieces
  if (p.length === 0) return d
  let lo = 0
  let hi = p.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (p[mid].docStart <= d) lo = mid
    else hi = mid - 1
  }
  const piece = p[lo]
  return piece.rawStart + Math.min(Math.max(0, d - piece.docStart), piece.len)
}

/** The doc for a text nothing was removed from: offsets are the same. */
export function identityDoc(raw: string): Doc {
  return { text: raw, pieces: [{ docStart: 0, rawStart: 0, len: raw.length }] }
}

/**
 * Remove ranges from a transcript exactly the way lib/transcriptHygiene.ts does
 * (merge overlaps, replace each range with one space, collapse runs of spaces, trim), and keep a table
 * from the result back to the raw text so offsets can be mapped.
 */
export function applyRemovals(raw: string, ranges: RemovedRange[]): Doc {
  if (ranges.length === 0) return identityDoc(raw)
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ start: r.start, end: r.end })
  }
  let cleaned = raw
  for (let i = merged.length - 1; i >= 0; i--) cleaned = cleaned.slice(0, merged[i].start) + ' ' + cleaned.slice(merged[i].end)
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').trim()

  // The pieces between the removed ranges, each located in `cleaned` by its first 40 characters.
  const pieces: Piece[] = []
  let rawPos = 0
  let cursor = 0
  const add = (rs: number, re: number) => {
    // Skip leading whitespace the trim/collapse removed from the cleaned text.
    while (rs < re && /\s/.test(raw[rs])) rs++
    if (re <= rs) return
    const anchor = raw.slice(rs, Math.min(re, rs + 40))
    const at = cleaned.indexOf(anchor, cursor)
    if (at < 0) return
    pieces.push({ docStart: at, rawStart: rs, len: re - rs })
    cursor = at + 1
  }
  for (const m of merged) { add(rawPos, m.start); rawPos = m.end }
  add(rawPos, raw.length)
  if (pieces.length === 0) pieces.push({ docStart: 0, rawStart: 0, len: 0 })
  return { text: cleaned, pieces }
}

// ── 2. Chunkers ─────────────────────────────────────────────

export type ChunkSpan = { start: number; end: number }

/** The production splitter, then each chunk located in the doc (chunks are trimmed substrings of it). */
export function chunkChars(doc: Doc, chunkSize = 2400, overlap = 200): ChunkSpan[] {
  const texts = splitIntoChunks(doc.text, chunkSize, overlap)
  const out: ChunkSpan[] = []
  let cursor = 0
  for (const t of texts) {
    let at = doc.text.indexOf(t, cursor)
    if (at < 0) at = doc.text.indexOf(t)
    if (at < 0) throw new Error('chunkChars: a chunk is not a substring of the doc')
    out.push({ start: at, end: at + t.length })
    cursor = at + 1
  }
  return out
}

/** One timed segment (an utterance) placed in the raw transcript. */
export type Unit = { text: string; rawStart: number; rawEnd: number; turnStart: boolean }

/** A speaker label at the start of a segment: `Peter Attia: ...`. Only the first utterance of a turn carries it. */
export const TURN_LABEL = /^([A-Z][A-Za-z.'’-]*(?: [A-Z][A-Za-z.'’-]*)*): /

/** Segments placed in the transcript they join to (single-space join, as buildTranscriptFromSegments). */
export function segmentUnits(segments: { text: string }[], raw: string): Unit[] {
  const joined = segments.map(s => s.text).join(' ').trim()
  if (joined !== raw) throw new Error('segmentUnits: the timed segments do not join to the stored transcript')
  const units: Unit[] = []
  let pos = 0
  segments.forEach((s, i) => {
    if (i > 0) pos++
    units.push({ text: s.text, rawStart: pos, rawEnd: pos + s.text.length, turnStart: i === 0 || TURN_LABEL.test(s.text) })
    pos += s.text.length
  })
  return units
}

const SENTENCE_END = /[.?!]["'’”)\]]*$/

/**
 * Units that survive hygiene: a unit is dropped when at least half of it lies inside a removed range.
 * (Hygiene marks arbitrary character spans; chunking by whole utterances needs a whole-unit rule.)
 */
export function keepUnits(units: Unit[], ranges: RemovedRange[]): Unit[] {
  if (ranges.length === 0) return units
  return units.filter(u => {
    let covered = 0
    for (const r of ranges) covered += Math.max(0, Math.min(u.rawEnd, r.end) - Math.max(u.rawStart, r.start))
    return covered * 2 < Math.max(1, u.rawEnd - u.rawStart)
  })
}

/** A doc built from kept units (single-space join) with an exact table back to the raw transcript. */
export function docFromUnits(units: Unit[]): { doc: Doc; unitDocStart: number[] } {
  let text = ''
  const pieces: Piece[] = []
  const unitDocStart: number[] = []
  units.forEach((u, i) => {
    if (i > 0) text += ' '
    unitDocStart.push(text.length)
    pieces.push({ docStart: text.length, rawStart: u.rawStart, len: u.text.length })
    text += u.text
  })
  return { doc: { text, pieces }, unitDocStart }
}

/**
 * Speaker-turn chunks (plan fix B2): whole turns packed up to `target` characters, no overlap;
 * a turn longer than `target` is split at an utterance end that is also a sentence end (falling back to
 * any utterance end), within the last `sentenceWindow` characters of what fits. Depends only on the
 * segment texts and the speaker labels, never on time, so near-identical transcripts chunk alike.
 * Returns inclusive unit-index ranges.
 */
export function chunkTurns(units: Unit[], target = 2400, sentenceWindow = 600): { first: number; last: number }[] {
  if (units.length === 0) return []
  const size = (a: number, b: number) => {
    let n = 0
    for (let i = a; i <= b; i++) n += units[i].text.length
    return n + (b - a)
  }
  // 1. turns
  const turns: { first: number; last: number }[] = []
  let first = 0
  for (let i = 1; i < units.length; i++) {
    if (units[i].turnStart) { turns.push({ first, last: i - 1 }); first = i }
  }
  turns.push({ first, last: units.length - 1 })
  // 2. split over-long turns
  const pieces: { first: number; last: number }[] = []
  for (const t of turns) {
    let i = t.first
    while (i <= t.last) {
      let j = i
      let n = units[i].text.length
      while (j < t.last && n + 1 + units[j + 1].text.length <= target) { j++; n += 1 + units[j].text.length }
      if (j < t.last) {
        // Cut here, preferably at a sentence end near the limit.
        let k = j
        while (k > i && size(k + 1, j) <= sentenceWindow && !SENTENCE_END.test(units[k].text.trimEnd())) k--
        if (k > i && SENTENCE_END.test(units[k].text.trimEnd())) j = k
      }
      pieces.push({ first: i, last: j })
      i = j + 1
    }
  }
  // 3. pack
  const chunks: { first: number; last: number }[] = []
  let cur: { first: number; last: number } | null = null
  for (const p of pieces) {
    if (cur && size(cur.first, p.last) <= target) cur.last = p.last
    else { if (cur) chunks.push(cur); cur = { ...p } }
  }
  if (cur) chunks.push(cur)
  return chunks
}

/**
 * The window around a chunk (plan appendix C): about `ctx` characters before and after, trimmed to word
 * boundaries so no word is cut. Returns doc offsets of the window; the chunk is [start, end) inside it.
 */
export function contextWindow(doc: string, start: number, end: number, ctx: number): { from: number; to: number } {
  if (ctx <= 0) return { from: start, to: end }
  let from = Math.max(0, start - ctx)
  if (from > 0 && doc[from - 1] !== ' ') {
    const sp = doc.indexOf(' ', from)
    from = sp >= 0 && sp < start ? sp + 1 : start
  }
  let to = Math.min(doc.length, end + ctx)
  if (to < doc.length && doc[to] !== ' ') {
    const sp = doc.lastIndexOf(' ', to)
    to = sp > end ? sp : end
  }
  return { from, to }
}

// ── 3. Matching ─────────────────────────────────────────────

/** One insight as the matcher sees it. `span` is in the raw transcript of the copy the pass ran over. */
export type MatchInsight = {
  id: string
  chunk: number
  statement: string
  quote: string | null
  span: [number, number] | null
  /** Quote start/end relative to the start of its chunk's text (negative or past the end when it runs into context). */
  relStart: number | null
  relEnd: number | null
  chunkLen: number
  /** insight_type, when the pass records it; 'Anecdote' rows are left out of the rate reported without anecdotes. */
  kind?: string | null
}

/** Fold a quote for comparison: lower case, no punctuation, single spaces. */
export function foldQuote(q: string): string {
  return q.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s]/g, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim()
}

/** Ellipsis-joined quotes are several fragments. */
export function quoteFragments(q: string): string[] {
  return q.split(/\s*(?:\.\.\.|…)\s*/).map(f => f.trim()).filter(Boolean)
}

export function quoteTokens(q: string | null): Set<string> {
  const out = new Set<string>()
  if (!q) return out
  for (const f of quoteFragments(q)) for (const w of foldQuote(f).split(' ')) if (w) out.add(w)
  return out
}

export const TIER1_CONTAINMENT = 0.5
export const TIER1_MIN_SHARED = 6
export const TIER2_COSINE = 0.7
export const TIER2_LEXICAL = 0.5
export const PASSAGE_GAP = 600

/** |A ∩ B| / min(|A|, |B|) and the shared count. */
export function containment(a: Set<string>, b: Set<string>): { ratio: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { ratio: 0, shared: 0 }
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const w of small) if (big.has(w)) shared++
  return { ratio: shared / small.size, shared }
}

export function tier1(x: MatchInsight, y: MatchInsight): { hit: boolean; ratio: number } {
  const { ratio, shared } = containment(quoteTokens(x.quote), quoteTokens(y.quote))
  return { hit: ratio >= TIER1_CONTAINMENT && shared >= TIER1_MIN_SHARED, ratio }
}

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the their this to was were which with ' +
  'can may more most not than then there these they those into about over also other such when who how what why').split(' '))
const contentTokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)))

/** Offline stand-in for the embedding cosine: Jaccard overlap of content words. */
export function lexicalSim(a: string, b: string): number {
  const A = contentTokens(a), B = contentTokens(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Offset map from one copy's transcript to another's: a diff anchored on 40-character windows. */
export type AnchorMap = { at: number[]; delta: number[] }
export const IDENTITY_MAP: AnchorMap = { at: [0], delta: [0] }

export function buildAnchorMap(x: string, y: string, step = 100, win = 40): AnchorMap {
  if (x === y) return IDENTITY_MAP
  const at: number[] = []
  const delta: number[] = []
  let d = 0
  for (let p = 0; p + win <= x.length; p += step) {
    const w = x.slice(p, p + win)
    const expect = p + d
    const found = y.indexOf(w, Math.max(0, expect - 400))
    if (found < 0 || Math.abs(found - expect) > 1500) continue
    const again = y.indexOf(w, found + 1)
    if (again >= 0 && Math.abs(again - expect) <= 1500) continue // ambiguous window
    d = found - p
    at.push(p); delta.push(d)
  }
  if (at.length === 0) { at.push(0); delta.push(0) }
  return { at, delta }
}

export function mapOffset(m: AnchorMap, pos: number): number {
  let lo = 0, hi = m.at.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (m.at[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return pos + m.delta[lo]
}

export type MatchRow = {
  id: string
  matched: boolean
  tier: 0 | 1 | 2
  partner: string | null
  /** The other pass quotes the same passage (spans overlap or lie within PASSAGE_GAP), whatever the meaning. */
  samePassage: boolean
  /** Best statement similarity among same-passage partners. */
  bestSim: number | null
  /** The same-passage insight with that best similarity (the pair E6 replays through the judge when unmatched). */
  passagePartner: string | null
}

/**
 * For each insight in P: does Q hold a matching one? `qToP` maps an offset in Q's transcript to P's
 * (identity for two passes over the same copy). `sim` is the statement similarity (embedding cosine, or lexical offline).
 */
export function matchOneWay(
  P: MatchInsight[], Q: MatchInsight[],
  opt: { qToP: (n: number) => number; sim: (x: MatchInsight, y: MatchInsight) => number; simThreshold?: number }
): MatchRow[] {
  const thr = opt.simThreshold ?? TIER2_COSINE
  const qSpans = Q.map(y => (y.span ? [opt.qToP(y.span[0]), opt.qToP(y.span[1])] as [number, number] : null))
  const qTokens = Q.map(y => quoteTokens(y.quote))
  return P.map(x => {
    let best1: { id: string; ratio: number } | null = null
    let best2: { id: string; sim: number } | null = null
    let samePassage = false
    let bestSim: number | null = null
    let passagePartner: string | null = null
    const xt = quoteTokens(x.quote)
    for (let j = 0; j < Q.length; j++) {
      const y = Q[j]
      if (xt.size && qTokens[j].size) {
        const { ratio, shared } = containment(xt, qTokens[j])
        if (ratio >= TIER1_CONTAINMENT && shared >= TIER1_MIN_SHARED && (!best1 || ratio > best1.ratio)) best1 = { id: y.id, ratio }
      }
      const ys = qSpans[j]
      if (x.span && ys) {
        const gap = Math.max(x.span[0], ys[0]) - Math.min(x.span[1], ys[1])
        if (gap <= PASSAGE_GAP) {
          samePassage = true
          const s = opt.sim(x, y)
          if (bestSim === null || s > bestSim) { bestSim = s; passagePartner = y.id }
          if (s >= thr && (!best2 || s > best2.sim)) best2 = { id: y.id, sim: s }
        }
      }
    }
    if (best1) return { id: x.id, matched: true, tier: 1, partner: best1.id, samePassage, bestSim, passagePartner }
    if (best2) return { id: x.id, matched: true, tier: 2, partner: best2.id, samePassage, bestSim, passagePartner }
    return { id: x.id, matched: false, tier: 0, partner: null, samePassage, bestSim, passagePartner }
  })
}

/**
 * Insights that tier-1 match an EARLIER insight of the same pass, split by same chunk and different chunk;
 * `identical` counts those whose whole folded quote equals an earlier insight's (plan: "identical-quote splits").
 */
export function withinPassDuplicates(P: MatchInsight[]): { total: number; sameChunk: number; crossChunk: number; identical: number } {
  const toks = P.map(x => quoteTokens(x.quote))
  const seen = new Set<string>()
  let sameChunk = 0, crossChunk = 0, identical = 0
  for (let i = 0; i < P.length; i++) {
    const folded = P[i].quote ? foldQuote(P[i].quote!) : ''
    if (folded && toks[i].size >= TIER1_MIN_SHARED) {
      if (seen.has(folded)) identical++
      seen.add(folded)
    }
    for (let j = 0; j < i; j++) {
      if (!toks[i].size || !toks[j].size) continue
      const { ratio, shared } = containment(toks[i], toks[j])
      if (ratio >= TIER1_CONTAINMENT && shared >= TIER1_MIN_SHARED) {
        if (P[i].chunk === P[j].chunk) sameChunk++
        else crossChunk++
        break
      }
    }
  }
  return { total: sameChunk + crossChunk, sameChunk, crossChunk, identical }
}

// ── 4. Metrics ──────────────────────────────────────────────

export const EDGE_ZONE = 300

/** In the first or last EDGE_ZONE characters of its chunk (a quote that runs into context counts as at the edge). */
export function inEdgeZone(x: Pick<MatchInsight, 'relStart' | 'relEnd' | 'chunkLen'>): boolean | null {
  if (x.relStart === null || x.relEnd === null) return null
  return x.relStart < EDGE_ZONE || x.relEnd > x.chunkLen - EDGE_ZONE
}

export type Direction = {
  n: number
  matched: number
  tier1: number
  tier2: number
  passSpecific: number
  passSpecificRate: number
  /** The same rate over the insights that are not anecdotes (anecdotes still count in `n` and in the pool the other pass is matched against). */
  nExAnecdotes: number
  passSpecificExAnecdotes: number
  passSpecificRateExAnecdotes: number
  /** Unmatched, and the other pass quotes the same passage (consolidation-side misses). */
  samePassageMiss: number
  samePassageMissRate: number
  /** Unmatched with no quote located in the transcript. */
  unmatchedNoSpan: number
  boundary: { matched: number | null; unmatched: number | null; nMatched: number; nUnmatched: number }
}

export function summariseDirection(P: MatchInsight[], rows: MatchRow[]): Direction {
  const n = P.length
  const matched = rows.filter(r => r.matched).length
  const share = (sel: (r: MatchRow) => boolean) => {
    let hit = 0, tot = 0
    rows.forEach((r, i) => {
      if (!sel(r)) return
      const e = inEdgeZone(P[i])
      if (e === null) return
      tot++
      if (e) hit++
    })
    return { share: tot ? hit / tot : null, tot }
  }
  const bm = share(r => r.matched), bu = share(r => !r.matched)
  const miss = rows.filter(r => !r.matched && r.samePassage).length
  const exAnec = rows.filter((_, i) => P[i].kind !== 'Anecdote')
  const exAnecMissed = exAnec.filter(r => !r.matched).length
  return {
    n, matched,
    tier1: rows.filter(r => r.tier === 1).length,
    tier2: rows.filter(r => r.tier === 2).length,
    passSpecific: n - matched,
    passSpecificRate: n ? (n - matched) / n : 0,
    nExAnecdotes: exAnec.length,
    passSpecificExAnecdotes: exAnecMissed,
    passSpecificRateExAnecdotes: exAnec.length ? exAnecMissed / exAnec.length : 0,
    samePassageMiss: miss,
    samePassageMissRate: n ? miss / n : 0,
    unmatchedNoSpan: rows.filter((r, i) => !r.matched && !P[i].span).length,
    boundary: { matched: bm.share, unmatched: bu.share, nMatched: bm.tot, nUnmatched: bu.tot },
  }
}

/** Bins of a transcript: fixed windows, or the speaker turns (label to next label). */
export type Bin = [number, number]
export function fixedBins(len: number, size = 500): Bin[] {
  const out: Bin[] = []
  for (let s = 0; s < len; s += size) out.push([s, Math.min(len, s + size)])
  return out
}
export function turnBins(units: Unit[], len: number): Bin[] {
  const starts = units.filter(u => u.turnStart).map(u => u.rawStart)
  if (starts.length === 0) return fixedBins(len)
  if (starts[0] !== 0) starts.unshift(0)
  return starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : len] as Bin)
}

/** Bins any span of the pass touches. */
export function coverage(spans: ([number, number] | null)[], bins: Bin[]): Set<number> {
  const out = new Set<number>()
  for (const s of spans) {
    if (!s) continue
    for (let i = 0; i < bins.length; i++) {
      if (bins[i][0] < s[1] && s[0] < bins[i][1]) out.add(i)
      else if (bins[i][0] >= s[1]) break
    }
  }
  return out
}

/** Bins covered by exactly one pass over bins covered by either. */
export function disagreement(a: Set<number>, b: Set<number>): { onlyA: number; onlyB: number; union: number; rate: number } {
  let onlyA = 0, onlyB = 0
  for (const x of a) if (!b.has(x)) onlyA++
  for (const x of b) if (!a.has(x)) onlyB++
  const union = new Set([...a, ...b]).size
  return { onlyA, onlyB, union, rate: union ? (onlyA + onlyB) / union : 0 }
}
