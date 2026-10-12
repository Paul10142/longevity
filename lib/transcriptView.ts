/**
 * Turn a stored transcript into something a person can read.
 *
 * Three shapes come in:
 *
 *   - Deepgram / published transcripts: `timed_transcript` segments whose text
 *     STARTS with a speaker label (`Peter Attia: …`, `Dr. Patrick: …`,
 *     `Speaker 2: …`) wherever the speaker changes. A labelled segment begins a
 *     turn; an unlabelled one continues the current turn. The label is stripped
 *     from the text and becomes the turn's speaker.
 *   - YouTube captions: thousands of short unlabelled segments. These are
 *     grouped into paragraphs of about a minute, each stamped with the time of
 *     its first caption.
 *   - Pasted transcripts with no timing: the plain `transcript` text, split on
 *     the same label pattern, with no timestamps.
 *
 * A label only counts at the START of a segment (or, for plain text, at the
 * start of the text or after whitespace). "…as Peter Attia: put it" mid-segment
 * is dialogue, not a speaker change.
 *
 * Pure: no React, no I/O. Tested in tests/transcriptView.test.ts.
 */

import { isPrivateFeedUrl } from './sourceLinks'

export type TimedSegment = { text: string; start_ms: number; end_ms: number }

export type TranscriptTurn = {
  /** Who is speaking, when the transcript says. Null for captions and lead-ins. */
  speaker: string | null
  /** Where this turn starts in the recording. Null when the transcript has no timing. */
  start_ms: number | null
  text: string
}

export type TranscriptView = {
  turns: TranscriptTurn[]
  /** True when the turns carry timestamps. */
  timed: boolean
  /** True when at least one turn has a speaker name. */
  labelled: boolean
}

/** One to three capitalised words, or `Speaker N`, followed by `: `. */
export const SPEAKER_LABEL_RE = /^((?:[A-Z][\w'.-]+(?: [A-Z][\w'.-]+){0,2})|Speaker \d+): /

/** Captions are grouped into paragraphs of roughly this long. */
export const CAPTION_PARAGRAPH_MS = 60_000

/** Honorifics that legitimately end a name-token with a period. */
const HONORIFICS = new Set(['dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'sr.', 'jr.', 'st.'])

const collapse = (s: string) => s.replace(/[ \t]+/g, ' ').trim()

/**
 * Split a leading speaker label off a piece of text. Returns the speaker and
 * the remaining text, or `speaker: null` with the text untouched when it does
 * not start with a label.
 */
export function splitLabel(text: string): { speaker: string | null; rest: string } {
  const trimmed = text.trimStart()
  const m = SPEAKER_LABEL_RE.exec(trimmed)
  if (!m) return { speaker: null, rest: text }
  return { speaker: m[1], rest: trimmed.slice(m[0].length) }
}

export function startsWithLabel(text: string): boolean {
  return SPEAKER_LABEL_RE.test(text.trimStart())
}

/**
 * Accept whatever JSON is in `timed_transcript` and keep only well-formed
 * segments. Anything that is not an array of `{ text, start_ms }` objects
 * yields `[]`, which sends the caller to the plain-text fallback.
 */
export function normalizeTimedSegments(raw: unknown): TimedSegment[] {
  if (!Array.isArray(raw)) return []
  const out: TimedSegment[] = []
  for (const seg of raw) {
    if (!seg || typeof seg !== 'object') continue
    const s = seg as Record<string, unknown>
    const text = typeof s.text === 'string' ? s.text : ''
    const start = Number(s.start_ms)
    if (!text.trim() || !Number.isFinite(start)) continue
    const end = Number(s.end_ms)
    const start_ms = Math.max(0, Math.round(start))
    out.push({ text, start_ms, end_ms: Number.isFinite(end) ? Math.max(start_ms, Math.round(end)) : start_ms })
  }
  return out
}

/**
 * Group unlabelled caption segments into paragraphs of about `windowMs`. A new
 * paragraph starts when a caption begins `windowMs` or more after the current
 * paragraph began. Each paragraph is stamped with its first caption's time.
 */
export function paragraphsFromCaptions(
  segments: TimedSegment[],
  windowMs: number = CAPTION_PARAGRAPH_MS
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let current: { start_ms: number; parts: string[] } | null = null
  for (const seg of segments) {
    const text = collapse(seg.text)
    if (!text) continue
    if (!current || seg.start_ms - current.start_ms >= windowMs) {
      if (current) turns.push({ speaker: null, start_ms: current.start_ms, text: current.parts.join(' ') })
      current = { start_ms: seg.start_ms, parts: [text] }
    } else {
      current.parts.push(text)
    }
  }
  if (current) turns.push({ speaker: null, start_ms: current.start_ms, text: current.parts.join(' ') })
  return turns
}

/**
 * Turns from timed segments. Labelled transcripts split on the labels; a
 * transcript with no labelled segment at all is treated as captions.
 */
export function turnsFromTimedSegments(segments: TimedSegment[]): TranscriptView {
  const labelled = segments.some(s => startsWithLabel(s.text))
  if (!labelled) {
    return { turns: paragraphsFromCaptions(segments), timed: true, labelled: false }
  }
  const turns: TranscriptTurn[] = []
  let current: { speaker: string | null; start_ms: number; parts: string[] } | null = null
  const flush = () => {
    if (!current) return
    const text = current.parts.join(' ').trim()
    if (text) turns.push({ speaker: current.speaker, start_ms: current.start_ms, text })
    current = null
  }
  for (const seg of segments) {
    const { speaker, rest } = splitLabel(seg.text)
    const text = collapse(rest)
    if (speaker !== null) {
      flush()
      current = { speaker, start_ms: seg.start_ms, parts: text ? [text] : [] }
    } else if (text) {
      // Continuation of the current turn — or a lead-in before the first label.
      if (!current) current = { speaker: null, start_ms: seg.start_ms, parts: [] }
      current.parts.push(text)
    }
  }
  flush()
  return { turns, timed: true, labelled: true }
}

/**
 * Plain-text fallback: split the flat transcript wherever a label appears at
 * the start of the text or after whitespace. Deepgram transcripts are stored
 * flat (turns joined with a single space), so the labels are mid-string.
 *
 * "So. Rhonda:" is the end of one sentence followed by a label, not a speaker
 * called "So. Rhonda" — a leading token ending in a period (other than an
 * honorific such as "Dr.") is returned to the previous turn's text.
 */
export function turnsFromPlainText(text: string): TranscriptTurn[] {
  const re = /(^|\s)((?:[A-Z][\w'.-]+(?: [A-Z][\w'.-]+){0,2})|Speaker \d+): /g
  const turns: TranscriptTurn[] = []
  let cursor = 0
  let speaker: string | null = null
  const push = (body: string) => {
    const t = body.trim()
    if (t) turns.push({ speaker, start_ms: null, text: t })
  }
  for (const m of text.matchAll(re)) {
    const index = m.index ?? 0
    // Trim a swallowed sentence-end off the front of the name.
    const words = m[2].split(' ')
    const lead: string[] = []
    while (words.length > 1 && words[0].endsWith('.') && !HONORIFICS.has(words[0].toLowerCase())) {
      lead.push(words.shift() as string)
    }
    push(text.slice(cursor, index) + (lead.length ? ' ' + lead.join(' ') : ''))
    speaker = words.join(' ')
    cursor = index + m[0].length
  }
  push(text.slice(cursor))
  return turns
}

/**
 * Break a turn at blank lines. A pasted transcript often arrives as one
 * unlabelled block with paragraph breaks in it; without this it renders as a
 * single 100k-character paragraph. The speaker (if any) stays on the first
 * piece; the rest are continuations. Single line breaks are left alone.
 */
export function splitParagraphs(turn: TranscriptTurn): TranscriptTurn[] {
  const pieces = turn.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  if (pieces.length <= 1) return [turn]
  return pieces.map((text, i) => ({
    speaker: i === 0 ? turn.speaker : null,
    start_ms: i === 0 ? turn.start_ms : null,
    text,
  }))
}

/** Build the readable view from a `sources` row (or any object shaped like one). */
export function buildTranscriptView(input: {
  transcript?: string | null
  timed_transcript?: unknown
}): TranscriptView {
  const segments = normalizeTimedSegments(input.timed_transcript)
  if (segments.length > 0) return turnsFromTimedSegments(segments)
  const text = (input.transcript ?? '').trim()
  if (!text) return { turns: [], timed: false, labelled: false }
  const turns = turnsFromPlainText(text).flatMap(splitParagraphs)
  return { turns, timed: false, labelled: turns.some(t => t.speaker !== null) }
}

/** `3735000` → `1:02:15`; `125000` → `2:05`. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/**
 * Deep-link to a moment in the video: `?t=<seconds>` (or `&t=` when the URL
 * already has a query). Null without a video, without a time, or — belt and
 * braces — for a private feed URL.
 */
export function timestampLink(videoUrl: string | null | undefined, ms: number | null | undefined): string | null {
  if (!videoUrl || typeof videoUrl !== 'string') return null
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null
  if (isPrivateFeedUrl(videoUrl)) return null
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const sep = videoUrl.includes('?') ? '&' : '?'
  return `${videoUrl}${sep}t=${seconds}`
}

/** A one-line, plain-language description of what kind of transcript this is. */
export function describeTranscriptView(view: TranscriptView): string {
  if (view.turns.length === 0) return 'No transcript yet.'
  if (view.timed && view.labelled) return 'Speaker-labelled transcript with timestamps.'
  if (view.timed) return 'Automatic captions, grouped into paragraphs of about a minute. No speaker names.'
  if (view.labelled) return 'Pasted transcript with speaker names. No timestamps.'
  return 'Pasted transcript. No speaker names or timestamps.'
}
