/**
 * The transcript excerpt on a fidelity card, shaped for reading.
 *
 * The judge reads one chunk of flat text. Deepgram transcripts are stored with
 * speaker labels ("Peter Attia: …") and timestamps on every turn, so the same
 * passage can be shown one speaker turn per line, each with its time, and the
 * turn(s) holding the quote can be highlighted.
 *
 * Method: rebuild the flat text from the turns (label + text, joined by a space),
 * find the chunk inside it, and keep the turns the chunk overlaps, clipped to the
 * chunk's edges. If the chunk cannot be found (a re-chunked or edited
 * transcript), fall back to splitting the chunk itself on its speaker labels
 * (no timestamps); with no labels at all the caller shows the plain text.
 *
 * Pure: no I/O. Tested in tests/fidelityExcerpt.test.ts.
 */

import { findSpan, videoLinkBefore, youtubeVideoId } from './flagReview'
import { publicArticleUrl, publicVideoUrl, type SourceLinkInput } from './sourceLinks'
import { buildTranscriptView, turnsFromPlainText, type TranscriptTurn } from './transcriptView'

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
  /** `timed`: turns carry timestamps. `labelled`: speaker names only (rebuilt from the chunk). */
  mode: 'timed' | 'labelled'
  turns: ExcerptTurn[]
  /** At least one turn holds (part of) the quote. */
  quoteFound: boolean
}

const MIN_UNTIMED_SPEAKER_TURNS = 10

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const labelOf = (t: TranscriptTurn) => (t.speaker ? `${t.speaker}: ` : '')

/** The first and last `n` words of the quote, for a quote that straddles two turns. */
function quoteEnds(quote: string, n = 6): { head: string; tail: string } | null {
  const words = quote.trim().split(/\s+/).filter(Boolean)
  if (words.length < n * 2) return null
  return { head: words.slice(0, n).join(' '), tail: words.slice(-n).join(' ') }
}

/** Mark the quote's span on each turn; returns whether anything was marked. */
function markQuote(turns: ExcerptTurn[], quote: string | null | undefined): boolean {
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
  // The quote runs across turns: mark from where it starts to where it ends.
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

function fromTimedTurns(turns: TranscriptTurn[], chunkText: string): ExcerptTurn[] | null {
  // Offsets of every turn inside the rebuilt flat text.
  let flat = ''
  const spans: { start: number; textStart: number; end: number }[] = []
  for (const t of turns) {
    const body = norm(t.text)
    if (flat) flat += ' '
    const start = flat.length
    flat += labelOf(t) + body
    spans.push({ start, textStart: start + labelOf(t).length, end: flat.length })
  }
  const chunk = norm(chunkText)
  if (!chunk) return null
  let cs = flat.indexOf(chunk)
  let ce = cs + chunk.length
  if (cs === -1) {
    // The chunk's edges can differ slightly: anchor on its first words, keep its length.
    cs = flat.indexOf(chunk.slice(0, 160))
    ce = cs + chunk.length
  }
  if (cs === -1) return null

  const out: ExcerptTurn[] = []
  turns.forEach((t, i) => {
    const sp = spans[i]
    if (sp.end <= cs || sp.start >= ce) return
    const body = flat.slice(sp.textStart, sp.end)
    const from = Math.max(0, cs - sp.textStart)
    const to = Math.min(body.length, ce - sp.textStart)
    if (to <= from) return
    out.push({
      speaker: t.speaker,
      start_ms: t.start_ms,
      text: body.slice(from, to),
      hit: null,
      clippedStart: from > 0,
      clippedEnd: to < body.length,
    })
  })
  return out.length ? out : null
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

  // The whole episode as turns (timed when the source has timing), then the chunk's slice of it.
  const view = buildTranscriptView({ transcript, timed_transcript: timedTranscript })
  // An untimed text with only a couple of "Name:" patterns is an article ("By: …", "Disclaimer: …"),
  // not a conversation: leave it as plain text.
  const looksLikeConversation = view.timed || view.turns.filter(t => t.speaker).length >= MIN_UNTIMED_SPEAKER_TURNS
  const sliced = looksLikeConversation ? fromTimedTurns(view.turns, chunkText) : null
  if (sliced && sliced.some(t => t.speaker || t.start_ms !== null)) {
    const timed = sliced.some(t => t.start_ms !== null)
    return { mode: timed ? 'timed' : 'labelled', turns: sliced, quoteFound: markQuote(sliced, quote) }
  }

  // The chunk is not in the stored transcript (re-chunked): split the chunk on its own labels.
  const plain = turnsFromPlainText(chunkText)
  if (looksLikeConversation && plain.some(t => t.speaker)) {
    const turns: ExcerptTurn[] = plain.map(t => ({
      speaker: t.speaker, start_ms: null, text: t.text, hit: null, clippedStart: false, clippedEnd: false,
    }))
    return { mode: 'labelled', turns, quoteFound: markQuote(turns, quote) }
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
