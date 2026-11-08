/**
 * The pure half of the flagged-claim review screen (/admin/flags).
 *
 * Everything here is a function of plain data, so it is tested without a
 * database (tests/flagReview.test.ts). lib/flagContext.ts does the reads and
 * hands rows to `buildFlagContext`; the API route hands a reviewer's choice to
 * `planReviewAction`, which defers to lib/claimGate.ts for what a ruling does to
 * the claim.
 *
 * What a reviewer sees for each hidden claim:
 *   1. the claim and the judge's reason, with the offending phrase marked;
 *   2. the surrounding transcript with the claim's quoted span marked;
 *   3. a link that opens the episode's YouTube video 30 seconds BEFORE the claim
 *      (or, with no known video, the episode title and the timestamp).
 */

import { publicVideoUrl, episodeLinks, type EpisodeLink, type SourceLinkInput } from './sourceLinks'
import { statusAfterResolution } from './claimGate'
import { extractYouTubeVideoId } from './youtubeUtils'
import {
  normalizeTimedSegments,
  turnsFromTimedSegments,
  splitParagraphs,
  type TranscriptTurn,
} from './transcriptView'

// ── Text marking ────────────────────────────────────────────

export type Part = { text: string; hit: boolean }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One needle token as a pattern: straight and curly quotes/dashes are interchangeable. */
function tokenPattern(token: string): string {
  let out = ''
  for (const ch of token) {
    if (ch === "'" || ch === '’' || ch === '‘') out += `['’‘]`
    else if (ch === '"' || ch === '“' || ch === '”') out += `["“”]`
    else if (ch === '-' || ch === '–' || ch === '—') out += `[-–—]`
    else out += escapeRe(ch)
  }
  return out
}

/**
 * Find `needle` in `text`, ignoring case, differences in whitespace, and
 * straight-versus-curly punctuation. Returns the match span or null. A quote the
 * extractor copied "verbatim" still differs from the transcript in exactly these
 * ways (captions re-wrap lines; the model normalises quotes), so an exact
 * indexOf would miss real matches.
 */
export function findSpan(text: string, needle: string | null | undefined): { start: number; end: number } | null {
  const tokens = (needle ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || !text) return null
  const re = new RegExp(tokens.map(tokenPattern).join('\\s+'), 'i')
  const m = re.exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/** Split `text` into plain and marked parts around the first match of `needle`. */
export function markSpan(text: string, needle: string | null | undefined): Part[] {
  const span = findSpan(text, needle)
  if (!span) return [{ text, hit: false }]
  const parts: Part[] = []
  if (span.start > 0) parts.push({ text: text.slice(0, span.start), hit: false })
  parts.push({ text: text.slice(span.start, span.end), hit: true })
  if (span.end < text.length) parts.push({ text: text.slice(span.end), hit: false })
  return parts
}

// ── Video link ──────────────────────────────────────────────

/** How far before the claim the video link starts, so the reviewer hears the lead-in. */
export const VIDEO_LEAD_SECONDS = 30

/** The 11-character video id in any YouTube URL shape, or null (lib/youtubeUtils.ts). */
export function youtubeVideoId(url: string | null | undefined): string | null {
  return typeof url === 'string' ? extractYouTubeVideoId(url) : null
}

/** Seconds into the video the link should start: `startMs` minus the lead, never below 0. */
export function videoStartSeconds(startMs: number, leadSeconds: number = VIDEO_LEAD_SECONDS): number {
  return Math.max(0, Math.floor(startMs / 1000) - leadSeconds)
}

/**
 * `https://www.youtube.com/watch?v=<id>&t=<start>s`, about 30 seconds before the
 * claim. Null when the episode has no public YouTube video (a private feed URL
 * never counts — see lib/sourceLinks.ts) or the claim has no timestamp.
 */
export function videoLinkBefore(source: SourceLinkInput, startMs: number | null | undefined): string | null {
  if (startMs === null || startMs === undefined || !Number.isFinite(startMs)) return null
  const id = youtubeVideoId(publicVideoUrl(source))
  if (!id) return null
  return `https://www.youtube.com/watch?v=${id}&t=${videoStartSeconds(startMs)}s`
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ── Transcript context ──────────────────────────────────────

export type ContextTurn = {
  speaker: string | null
  start_ms: number | null
  parts: Part[]
  /** The text was cut at the start / end (shown as an ellipsis). */
  clippedStart: boolean
  clippedEnd: boolean
  role: 'before' | 'claim' | 'after'
}

export type ContextExcerpt = {
  kind: 'timed' | 'chunk' | 'none'
  turns: ContextTurn[]
  /** The claim's quoted span was found and marked in the text above. */
  quoteFound: boolean
}

const ANCHOR_MAX_CHARS = 2200
const NEIGHBOUR_MAX_CHARS = 700

/** Trim to a window, snapping to word boundaries. */
function clipWindow(text: string, from: number, to: number): { text: string; clippedStart: boolean; clippedEnd: boolean } {
  let start = Math.max(0, from)
  let end = Math.min(text.length, to)
  if (start > 0) {
    const sp = text.indexOf(' ', start)
    if (sp !== -1 && sp < start + 40) start = sp + 1
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end)
    if (sp > end - 40 && sp > start) end = sp
  }
  return { text: text.slice(start, end), clippedStart: start > 0, clippedEnd: end < text.length }
}

/** An excerpt of `text` around a span, or the head of it when there is no span. */
export function excerptAround(
  text: string,
  span: { start: number; end: number } | null,
  maxChars: number
): { text: string; clippedStart: boolean; clippedEnd: boolean } {
  if (text.length <= maxChars) return { text, clippedStart: false, clippedEnd: false }
  if (!span) return clipWindow(text, 0, maxChars)
  const mid = Math.floor((span.start + span.end) / 2)
  return clipWindow(text, mid - Math.floor(maxChars / 2), mid + Math.ceil(maxChars / 2))
}

/**
 * Pick the readable turns around a claim.
 *
 * `anchorMs` is the claim's timestamp. The turn that was being spoken then is the
 * starting guess; the extractor's timestamp can sit a little before the quote (it
 * is the chunk's clock), so the quote is searched for in the turns around it and
 * the nearest hit becomes the anchor. With no hit the guess stands and nothing is
 * marked, which the screen says plainly.
 */
export function contextFromTurns(
  turns: TranscriptTurn[],
  anchorMs: number | null,
  quote: string | null | undefined
): ContextExcerpt {
  if (turns.length === 0) return { kind: 'none', turns: [], quoteFound: false }

  let guess = -1
  if (anchorMs !== null) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i].start_ms
      if (t !== null && t <= anchorMs) guess = i
      else if (t !== null && t > anchorMs) break
    }
    if (guess === -1) guess = 0
  }

  let anchor = guess
  let span: { start: number; end: number } | null = null
  if (guess === -1) {
    // No timestamp: accept a quote that occurs in exactly one turn.
    const hits = turns.map((t, i) => ({ i, s: findSpan(t.text, quote) })).filter(h => h.s)
    if (hits.length === 1) {
      anchor = hits[0].i
      span = hits[0].s
    } else {
      return { kind: 'none', turns: [], quoteFound: false }
    }
  } else if (quote && quote.trim()) {
    const lo = Math.max(0, guess - 3)
    const hi = Math.min(turns.length - 1, guess + 12)
    let best = Infinity
    for (let i = lo; i <= hi; i++) {
      const s = findSpan(turns[i].text, quote)
      if (s && Math.abs(i - guess) < best) {
        best = Math.abs(i - guess)
        anchor = i
        span = s
      }
    }
  }

  const out: ContextTurn[] = []
  const make = (i: number, role: ContextTurn['role']): ContextTurn => {
    const turn = turns[i]
    let ex: ReturnType<typeof excerptAround>
    if (role === 'claim') ex = excerptAround(turn.text, span, ANCHOR_MAX_CHARS)
    else if (role === 'before') {
      ex = turn.text.length > NEIGHBOUR_MAX_CHARS
        ? clipWindow(turn.text, turn.text.length - NEIGHBOUR_MAX_CHARS, turn.text.length)
        : { text: turn.text, clippedStart: false, clippedEnd: false }
    } else {
      ex = excerptAround(turn.text, null, NEIGHBOUR_MAX_CHARS)
    }
    return {
      speaker: turn.speaker,
      start_ms: turn.start_ms,
      parts: role === 'claim' ? markSpan(ex.text, quote) : [{ text: ex.text, hit: false }],
      clippedStart: ex.clippedStart,
      clippedEnd: ex.clippedEnd,
      role,
    }
  }
  if (anchor > 0) out.push(make(anchor - 1, 'before'))
  out.push(make(anchor, 'claim'))
  if (anchor < turns.length - 1) out.push(make(anchor + 1, 'after'))
  return { kind: 'timed', turns: out, quoteFound: span !== null }
}

/** Turns for the whole episode from its stored timed transcript, long turns split at blank lines. */
export function turnsFromStoredTranscript(timedTranscript: unknown): TranscriptTurn[] {
  const segments = normalizeTimedSegments(timedTranscript)
  if (segments.length === 0) return []
  return turnsFromTimedSegments(segments).turns.flatMap(splitParagraphs)
}

/** Context from the chunk the judge read, for an episode with no usable timed transcript. */
export function contextFromChunk(
  content: string | null | undefined,
  quote: string | null | undefined,
  charStart: number | null | undefined,
  charEnd: number | null | undefined,
  chunkStartMs: number | null | undefined
): ContextExcerpt {
  if (!content || !content.trim()) return { kind: 'none', turns: [], quoteFound: false }
  let span: { start: number; end: number } | null = null
  if (
    Number.isInteger(charStart) && Number.isInteger(charEnd) &&
    (charStart as number) >= 0 && (charEnd as number) > (charStart as number) && (charEnd as number) <= content.length
  ) {
    span = { start: charStart as number, end: charEnd as number }
  }
  if (!span) span = findSpan(content, quote)
  const ex = excerptAround(content, span, ANCHOR_MAX_CHARS)
  // Mark the span inside the clipped text: re-find it there (offsets moved by the clip).
  const marked = markSpan(ex.text, span ? content.slice(span.start, span.end) : quote)
  return {
    kind: 'chunk',
    turns: [{
      speaker: null,
      start_ms: chunkStartMs ?? null,
      parts: marked,
      clippedStart: ex.clippedStart,
      clippedEnd: ex.clippedEnd,
      role: 'claim',
    }],
    quoteFound: marked.some(p => p.hit),
  }
}

// ── The whole payload for one flag ──────────────────────────

export type FlagContextInput = {
  flag: { id: string; claim_id: string; rule: string; detail: string | null; evidence: Record<string, unknown> | null }
  canonicalStatement: string
  member: {
    id: string
    statement: string
    start_ms: number | null
    direct_quote: string | null
    quote_char_start: number | null
    quote_char_end: number | null
    speaker: string | null
  } | null
  memberMatched: boolean
  memberCount: number
  source: (SourceLinkInput & { id: string; date?: string | null; timed_transcript?: unknown }) | null
  chunk: { content: string | null; start_ms: number | null } | null
}

export type FlagContext = {
  flagId: string
  claimId: string
  rule: string
  verdict: string | null
  detail: string | null
  offending: string | null
  /** The claim as articles show it, with the offending phrase marked when it appears. */
  canonical: Part[]
  /** What the judge actually read (the member insight), when it differs from the claim. */
  judgedStatement: Part[] | null
  memberMatched: boolean
  memberCount: number
  speaker: string | null
  source: { id: string; title: string | null; date: string | null; episodeNumber: number | null } | null
  startMs: number | null
  timestampLabel: string | null
  videoUrl: string | null
  /** Public episode links to fall back on when there is no video. */
  links: EpisodeLink[]
  context: ContextExcerpt
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function buildFlagContext(input: FlagContextInput): FlagContext {
  const { flag, member, source, chunk } = input
  const evidence = flag.evidence ?? {}
  const offending = asString(evidence.offending)
  const verdict = asString(evidence.verdict)

  const judged = member?.statement ?? asString(evidence.statement)
  const judgedStatement =
    judged && judged.trim() !== input.canonicalStatement.trim() ? markSpan(judged, offending) : null

  const quote = member?.direct_quote ?? null
  const anchorMs = member?.start_ms ?? chunk?.start_ms ?? null

  let context: ContextExcerpt = { kind: 'none', turns: [], quoteFound: false }
  if (source?.timed_transcript) {
    context = contextFromTurns(turnsFromStoredTranscript(source.timed_transcript), anchorMs, quote)
  }
  if (context.kind === 'none' && chunk) {
    context = contextFromChunk(chunk.content, quote, member?.quote_char_start, member?.quote_char_end, chunk.start_ms)
  }

  // The time shown and linked is the claim's own; the turn's start is only a fallback.
  const startMs = member?.start_ms ?? context.turns.find(t => t.role === 'claim')?.start_ms ?? chunk?.start_ms ?? null

  return {
    flagId: flag.id,
    claimId: flag.claim_id,
    rule: flag.rule,
    verdict,
    detail: flag.detail,
    offending,
    canonical: markSpan(input.canonicalStatement, offending),
    judgedStatement,
    memberMatched: input.memberMatched,
    memberCount: input.memberCount,
    speaker: member?.speaker ?? null,
    source: source
      ? {
          id: source.id,
          title: source.title ?? null,
          date: (source.date as string | null | undefined) ?? null,
          episodeNumber: source.episode_number === undefined || source.episode_number === null ? null : Number(source.episode_number),
        }
      : null,
    startMs,
    timestampLabel: startMs === null ? null : formatTimestamp(startMs),
    videoUrl: source ? videoLinkBefore(source, startMs) : null,
    links: source ? episodeLinks(source) : [],
    context,
  }
}

// ── What a reviewer's choice does ───────────────────────────

export type ReviewAction = 'approve' | 'reject' | 'edit' | 'needs_video_check'
export const REVIEW_ACTIONS: readonly ReviewAction[] = ['approve', 'reject', 'edit', 'needs_video_check']

export const MAX_STATEMENT_CHARS = 2000

export type ReviewPlan =
  | {
      ok: true
      /** Value for claim_flags.resolution, or null when the flag stays open. */
      resolution: string | null
      /** The flag is closed by this action. */
      closesFlag: boolean
      /** claims.status to set (only ever `active`), or null for unchanged. */
      claimStatus: 'active' | null
      /** New canonical wording, for an edit. */
      newStatement: string | null
      /** Park the flag in the "needs video check" list instead of closing it. */
      markVideoCheck: boolean
    }
  | { ok: false; error: string }

/**
 * Translate the reviewer's four choices into the flag resolution vocabulary and
 * the claim's status, through lib/claimGate.ts.
 *
 *   approve            → `false_positive`: the claim is fine; a hidden claim goes back to `active`.
 *   reject             → `approved`: the flag is right; the claim stays hidden.
 *   edit               → `reworded`: the reviewer fixed the wording; the claim goes back to `active`.
 *   needs_video_check  → nothing is decided: the flag stays open, the claim stays hidden,
 *                        and the flag moves to its own list.
 */
export function planReviewAction(
  action: string,
  ctx: { currentStatus: string; rule: string; currentStatement: string; statement?: unknown }
): ReviewPlan {
  switch (action) {
    case 'approve':
    case 'reject': {
      const resolution = action === 'approve' ? 'false_positive' : 'approved'
      return {
        ok: true, resolution, closesFlag: true, markVideoCheck: false, newStatement: null,
        claimStatus: statusAfterResolution(ctx.currentStatus, ctx.rule, resolution),
      }
    }
    case 'edit': {
      if (typeof ctx.statement !== 'string') return { ok: false, error: 'statement is required for an edit' }
      const statement = ctx.statement.replace(/\s+/g, ' ').trim()
      if (!statement) return { ok: false, error: 'statement must not be empty' }
      if (statement.length > MAX_STATEMENT_CHARS) return { ok: false, error: `statement must be at most ${MAX_STATEMENT_CHARS} characters` }
      if (statement === ctx.currentStatement.replace(/\s+/g, ' ').trim()) {
        return { ok: false, error: 'the wording was not changed — use Approve As Is instead' }
      }
      return {
        ok: true, resolution: 'reworded', closesFlag: true, markVideoCheck: false, newStatement: statement,
        claimStatus: statusAfterResolution(ctx.currentStatus, ctx.rule, 'reworded'),
      }
    }
    case 'needs_video_check':
      return { ok: true, resolution: null, closesFlag: false, claimStatus: null, newStatement: null, markVideoCheck: true }
    default:
      return { ok: false, error: `action must be one of: ${REVIEW_ACTIONS.join(', ')}` }
  }
}
