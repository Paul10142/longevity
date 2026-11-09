/**
 * The transcript excerpt on a fidelity card, shaped for reading.
 *
 * The judge reads one chunk of flat text. Deepgram transcripts are stored with
 * speaker labels ("Peter Attia: …") and a start time on every sentence, so the same
 * passage can be shown one speaker turn per line, each with its time, the quote
 * highlighted, and the quote's own time worked out for the video link.
 *
 * Method: rebuild the flat text of the episode from its turns (label + text, joined
 * by a space) and find the chunk inside it:
 *   1. exact match (whitespace-insensitive);
 *   2. else word matching: the chunk of an older extraction came from a differently
 *      transcribed copy of the episode (caption text), so most words still line up
 *      even though the punctuation and a few words do not. Four-word runs "vote" for
 *      where the chunk sits.
 * Inside that passage the quote is found the same two ways. The quote's start time
 * is the start of the sentence (stored segment) that contains it.
 *
 * With no timed transcript the turns have no times; with no speaker labels anywhere
 * the caller shows the chunk as plain text.
 *
 * Pure: no I/O. Tested in tests/fidelityExcerpt.test.ts.
 */

import { findSpan, videoLinkBefore, youtubeVideoId } from './flagReview'
import { publicArticleUrl, publicVideoUrl, type SourceLinkInput } from './sourceLinks'
import {
  buildTranscriptView,
  normalizeTimedSegments,
  turnsFromPlainText,
  type TranscriptTurn,
} from './transcriptView'

export type ExcerptTurn = {
  speaker: string | null
  start_ms: number | null
  text: string
  /** Character range of the quote inside `text`, or null. */
  hit: [number, number] | null
  clippedStart: boolean
  clippedEnd: boolean
}

export type Excerpt = {
  /** `timed`: turns carry timestamps. `labelled`: speaker names only. */
  mode: 'timed' | 'labelled'
  turns: ExcerptTurn[]
  /** At least one turn holds (part of) the quote. */
  quoteFound: boolean
  /**
   * Where the quote starts in the recording, from the sentence times in the stored
   * transcript (`quote`), or, when the quote itself could not be placed, where the
   * passage the judge read starts (`passage`). Null with no timed transcript.
   */
  startMs: number | null
  startFrom: 'quote' | 'passage' | null
  /** The passage was found by word matching, not an exact match (older transcription of the episode). */
  fuzzy: boolean
}

const MIN_UNTIMED_SPEAKER_TURNS = 10

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const labelOf = (t: TranscriptTurn) => (t.speaker ? `${t.speaker}: ` : '')

// ── Word matching ───────────────────────────────────────────

type W = { w: string; s: number; e: number }

/** Lower-cased words with their character offsets; punctuation, ">>" and apostrophes are ignored. */
export function wordsOf(text: string): W[] {
  const out: W[] = []
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)) {
    out.push({ w: m[0].toLowerCase().replace(/['’]/g, ''), s: m.index ?? 0, e: (m.index ?? 0) + m[0].length })
  }
  return out
}

/**
 * Where `needle` sits among the words of `hay` (restricted to hay[lo, hi)), by voting:
 * every k-word run of the needle that also occurs in the hay votes for the shift
 * between the two; the best-supported shift wins. Returns the first/last matched word
 * indexes, or null when too few runs agree.
 */
export function alignWords(
  hay: W[],
  needle: W[],
  k = 4,
  lo = 0,
  hi = hay.length
): { w0: number; w1: number; votes: number } | null {
  const grams = needle.length - k + 1
  if (grams < 3) return null
  const index = new Map<string, number[]>()
  for (let i = lo; i + k <= hi; i++) {
    const key = hay.slice(i, i + k).map(x => x.w).join(' ')
    const list = index.get(key)
    if (list) list.push(i)
    else index.set(key, [i])
  }
  const hits: { p: number; d: number }[] = []
  for (let q = 0; q < grams; q++) {
    const list = index.get(needle.slice(q, q + k).map(x => x.w).join(' '))
    if (!list || list.length > 6) continue // a phrase said many times says nothing about where
    for (const p of list) hits.push({ p, d: p - q })
  }
  if (hits.length === 0) return null
  // Best shift: the one whose neighbourhood (±12 words) holds the most votes.
  let best = { d: 0, votes: 0 }
  const ds = [...new Set(hits.map(h => h.d))]
  for (const d of ds) {
    const votes = hits.filter(h => Math.abs(h.d - d) <= 12).length
    if (votes > best.votes) best = { d, votes }
  }
  if (best.votes < Math.max(3, Math.ceil(grams * 0.2))) return null
  const agreeing = hits.filter(h => Math.abs(h.d - best.d) <= 12)
  return {
    w0: Math.min(...agreeing.map(h => h.p)),
    w1: Math.max(...agreeing.map(h => h.p)) + k,
    votes: best.votes,
  }
}

// ── Quote marking in plain (chunk-only) turns ───────────────

/** The first and last `n` words of the quote, for a quote that straddles two turns. */
function quoteEnds(quote: string, n = 6): { head: string; tail: string } | null {
  const words = quote.trim().split(/\s+/).filter(Boolean)
  if (words.length < n * 2) return null
  return { head: words.slice(0, n).join(' '), tail: words.slice(-n).join(' ') }
}

function markQuoteInTurns(turns: ExcerptTurn[], quote: string | null | undefined): boolean {
  if (!quote || !quote.trim()) return false
  let found = false
  for (const t of turns) {
    const s = findSpan(t.text, quote)
    if (s) {
      t.hit = [s.start, s.end]
      found = true
    }
  }
  if (found) return true
  const ends = quoteEnds(quote)
  if (!ends) return false
  for (let i = 0; i < turns.length; i++) {
    const a = findSpan(turns[i].text, ends.head)
    if (!a) continue
    for (let j = i + 1; j < Math.min(turns.length, i + 5); j++) {
      const b = findSpan(turns[j].text, ends.tail)
      if (!b) continue
      turns[i].hit = [a.start, turns[i].text.length]
      for (let k = i + 1; k < j; k++) turns[k].hit = [0, turns[k].text.length]
      turns[j].hit = [0, b.end]
      return true
    }
  }
  return false
}

// ── The episode as flat text ────────────────────────────────

type Flat = {
  text: string
  /** Where each turn's body starts and ends in `text` (the label sits before `textStart`). */
  spans: { start: number; textStart: number; end: number }[]
  /** Start time of each stored sentence, by character offset in `text`; null when the episode is untimed or the two texts disagree. */
  segStarts: { at: number; ms: number }[] | null
  words: W[]
}

function buildFlat(turns: TranscriptTurn[], timedTranscript: unknown): Flat {
  let text = ''
  const spans: Flat['spans'] = []
  for (const t of turns) {
    const body = norm(t.text)
    if (text) text += ' '
    const start = text.length
    text += labelOf(t) + body
    spans.push({ start, textStart: start + labelOf(t).length, end: text.length })
  }

  // Sentence times: the same text built from the stored segments must equal the turn text.
  let segStarts: Flat['segStarts'] = null
  const segments = normalizeTimedSegments(timedTranscript)
  if (segments.length) {
    let seg = ''
    const starts: { at: number; ms: number }[] = []
    for (const s of segments) {
      const piece = norm(s.text)
      if (!piece) continue
      if (seg) seg += ' '
      starts.push({ at: seg.length, ms: s.start_ms })
      seg += piece
    }
    if (seg === text) segStarts = starts
  }
  return { text, spans, segStarts, words: wordsOf(text) }
}

/** Start time of the stored sentence holding character `at`, else of the turn holding it. */
function timeAt(flat: Flat, turns: TranscriptTurn[], at: number): number | null {
  if (flat.segStarts) {
    let lo = 0
    let hi = flat.segStarts.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (flat.segStarts[mid].at <= at) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found >= 0 ? flat.segStarts[found].ms : null
  }
  const i = flat.spans.findIndex(s => at >= s.start && at < s.end + 1)
  return i >= 0 ? turns[i].start_ms : null
}

/** Find where `chunk` sits in the flat text: exact, else by word voting. */
function locate(flat: Flat, chunk: string): { cs: number; ce: number; fuzzy: boolean } | null {
  const c = norm(chunk)
  if (!c) return null
  let cs = flat.text.indexOf(c)
  if (cs !== -1) return { cs, ce: cs + c.length, fuzzy: false }
  cs = flat.text.indexOf(c.slice(0, 160))
  if (cs !== -1) return { cs, ce: Math.min(flat.text.length, cs + c.length), fuzzy: false }
  const a = alignWords(flat.words, wordsOf(c))
  if (!a) return null
  return { cs: flat.words[a.w0].s, ce: flat.words[a.w1 - 1].e, fuzzy: true }
}

/** Find the quote inside the passage [cs, ce): exact (case/quote/dash tolerant), else by word voting. */
function locateQuote(flat: Flat, quote: string | null | undefined, cs: number, ce: number): [number, number] | null {
  if (!quote || !quote.trim()) return null
  const span = findSpan(flat.text.slice(cs, ce), quote)
  if (span) return [cs + span.start, cs + span.end]
  const lo = flat.words.findIndex(w => w.s >= cs)
  if (lo === -1) return null
  let hi = flat.words.findIndex(w => w.s >= ce)
  if (hi === -1) hi = flat.words.length
  const a = alignWords(flat.words, wordsOf(quote), 3, lo, hi)
  return a ? [flat.words[a.w0].s, flat.words[a.w1 - 1].e] : null
}

/**
 * Speaker turns for the chunk the judge read.
 * @param timedTranscript the source's stored `timed_transcript` (any shape; bad shapes yield no turns)
 * @param transcript the source's flat transcript text, used when there is no timed one
 */
export function buildExcerpt(
  chunkText: string,
  timedTranscript: unknown,
  transcript: string | null | undefined,
  quote: string | null | undefined
): Excerpt | null {
  if (!chunkText || !chunkText.trim()) return null

  const view = buildTranscriptView({ transcript, timed_transcript: timedTranscript })
  // An untimed text with only a couple of "Name:" patterns is an article ("By: …", "Disclaimer: …"),
  // not a conversation: leave it as plain text.
  const looksLikeConversation = view.timed || view.turns.filter(t => t.speaker).length >= MIN_UNTIMED_SPEAKER_TURNS

  if (looksLikeConversation && view.turns.length) {
    const flat = buildFlat(view.turns, timedTranscript)
    const where = locate(flat, chunkText)
    if (where) {
      const q = locateQuote(flat, quote, where.cs, where.ce)
      const turns: ExcerptTurn[] = []
      view.turns.forEach((t, i) => {
        const sp = flat.spans[i]
        if (sp.end <= where.cs || sp.start >= where.ce) return
        const from = Math.max(0, where.cs - sp.textStart)
        const to = Math.min(sp.end - sp.textStart, where.ce - sp.textStart)
        if (to <= from) return
        const body = flat.text.slice(sp.textStart, sp.end)
        let hit: [number, number] | null = null
        if (q) {
          const a = Math.max(q[0], sp.textStart + from) - (sp.textStart + from)
          const b = Math.min(q[1], sp.textStart + to) - (sp.textStart + from)
          if (b > a) hit = [a, b]
        }
        turns.push({
          speaker: t.speaker,
          start_ms: t.start_ms,
          text: body.slice(from, to),
          hit,
          clippedStart: from > 0,
          clippedEnd: to < body.length,
        })
      })
      if (turns.length && turns.some(t => t.speaker || t.start_ms !== null)) {
        const timed = turns.some(t => t.start_ms !== null)
        const quoteMs = q && timed ? timeAt(flat, view.turns, q[0]) : null
        const passageMs = timed ? timeAt(flat, view.turns, where.cs) : null
        return {
          mode: timed ? 'timed' : 'labelled',
          turns,
          quoteFound: q !== null,
          startMs: quoteMs ?? passageMs,
          startFrom: quoteMs !== null ? 'quote' : passageMs !== null ? 'passage' : null,
          fuzzy: where.fuzzy,
        }
      }
    }
  }

  // The chunk is not in the stored transcript: split the chunk on its own labels (no times).
  const plain = turnsFromPlainText(chunkText)
  if (looksLikeConversation && plain.some(t => t.speaker)) {
    const turns: ExcerptTurn[] = plain.map(t => ({
      speaker: t.speaker, start_ms: null, text: t.text, hit: null, clippedStart: false, clippedEnd: false,
    }))
    return {
      mode: 'labelled', turns, quoteFound: markQuoteInTurns(turns, quote),
      startMs: null, startFrom: null, fuzzy: false,
    }
  }
  return null
}

// ── Link to the source ──────────────────────────────────────

export type ExcerptLink = {
  href: string
  /** `video-at-time`: YouTube ~30 s before the quote. `video`: YouTube from the start. `episode`: the public episode page. */
  kind: 'video-at-time' | 'video' | 'episode'
}

/**
 * Where "Transcript Excerpt" should point: the YouTube video 30 seconds before the
 * quote; the video without a time when the quote's time is unknown; else the
 * episode's public page; else nothing. Private feed URLs are never returned.
 */
export function excerptLink(source: SourceLinkInput | null, startMs: number | null | undefined): ExcerptLink | null {
  if (!source) return null
  const at = videoLinkBefore(source, startMs)
  if (at) return { href: at, kind: 'video-at-time' }
  const id = youtubeVideoId(publicVideoUrl(source))
  if (id) return { href: `https://www.youtube.com/watch?v=${id}`, kind: 'video' }
  const page = publicArticleUrl(source)
  return page ? { href: page, kind: 'episode' } : null
}

/** Match a pair's stored episode title to a source row: the same text ignoring dash style, case and a trailing "|". */
export function sameEpisodeTitle(pairTitle: string, sourceTitle: string | null | undefined): boolean {
  const n = (s: string) =>
    s.replace(/[‒–—−]/g, '-').replace(/\s+/g, ' ').replace(/[\s|]+$/, '').trim().toLowerCase()
  const a = n(pairTitle)
  const b = n(sourceTitle ?? '')
  return a.length > 0 && (a === b || b.startsWith(a))
}
