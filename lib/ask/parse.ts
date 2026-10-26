/**
 * Turning the composer's markdown into the stored sentence model (design §6.5)
 * and into the numbers the physician sees.
 *
 * The composer cites candidates by their position in the list it was given
 * (`[47]`, `[3, 112]`). Printed as is, a brief would open with "[47]". So the
 * markers are rewritten on the way out: every marker becomes a single `[n]`,
 * numbered 1, 2, 3 … by first appearance in the text; a marker that does not
 * name a candidate is dropped and counted. `BriefStream` applies the same
 * rewrite to the live stream (holding back any half-arrived marker), and
 * `parseBrief` applies it to the finished text, so what the client printed while
 * streaming is exactly what is stored.
 *
 * Pure functions only: no model, no database.
 */

import type { Sentence } from '../blocks'
import type { Cited } from './types'

export const FOLLOW_UPS_TAG = 'FOLLOW_UPS:'

/** Leading whitespace is part of the match so a dropped marker takes its space with it. */
const MARKER_RE = /(\s*)\[(\d+(?:\s*,\s*\d+)*)\]/g
/** A '[' with no ']' after it, this close to the end, may still become a marker. */
const OPEN_MARKER_MAX = 30

export type MarkerState = {
  /** Candidate number -> displayed number. */
  display: Map<number, number>
  /** Candidate numbers in order of first appearance (index + 1 = displayed number). */
  order: number[]
  dangling: number
}

export function newMarkerState(): MarkerState {
  return { display: new Map(), order: [], dangling: 0 }
}

/** Rewrite every `[n]` / `[n, m]` in `text` to displayed single markers; drop unresolvable ones. */
export function rewriteMarkers(text: string, resolve: (n: number) => boolean, state: MarkerState): string {
  return text.replace(MARKER_RE, (_m, lead: string, nums: string) => {
    const shown: number[] = []
    for (const part of nums.split(',')) {
      const n = Number(part.trim())
      if (!resolve(n)) {
        state.dangling++
        continue
      }
      let d = state.display.get(n)
      if (d === undefined) {
        d = state.order.length + 1
        state.display.set(n, d)
        state.order.push(n)
      }
      if (!shown.includes(d)) shown.push(d)
    }
    return shown.length ? lead + shown.map(d => `[${d}]`).join('') : ''
  })
}

/**
 * Feed the composer's deltas in; clean deltas come out. Everything from
 * `FOLLOW_UPS:` onward is withheld (it is delivered in `done.follow_ups`), and so
 * is any piece that might still turn into a marker or the tag.
 */
export class BriefStream {
  readonly state = newMarkerState()
  private raw = ''
  private pending = ''
  private tailSeen = false

  constructor(
    private resolve: (n: number) => boolean,
    private emit: (text: string) => void
  ) {}

  /** Everything received so far, unmodified (what gets parsed at the end). */
  get received(): string {
    return this.raw
  }

  push(delta: string): void {
    this.raw += delta
    if (this.tailSeen) return
    this.pending += delta

    const tagAt = this.pending.indexOf(FOLLOW_UPS_TAG)
    if (tagAt >= 0) {
      this.tailSeen = true
      this.send(this.pending.slice(0, tagAt).trimEnd())
      this.pending = ''
      return
    }

    let end = this.pending.length
    // A partial tag at the end ("FOLL").
    for (let k = Math.min(end, FOLLOW_UPS_TAG.length - 1); k >= 1; k--) {
      if (this.pending.endsWith(FOLLOW_UPS_TAG.slice(0, k))) { end -= k; break }
    }
    // A marker still arriving ("[4" or "[4, 1").
    const open = this.pending.lastIndexOf('[', end - 1)
    if (open >= 0 && this.pending.indexOf(']', open) === -1 && end - open <= OPEN_MARKER_MAX) end = open
    // Whitespace that may be the lead of a marker.
    while (end > 0 && /\s/.test(this.pending[end - 1])) end--

    this.send(this.pending.slice(0, end))
    this.pending = this.pending.slice(end)
  }

  /** The stream ended: release whatever is held. */
  finish(): void {
    if (!this.tailSeen) this.send(this.pending.trimEnd())
    this.pending = ''
  }

  private send(text: string): void {
    if (!text) return
    const out = rewriteMarkers(text, this.resolve, this.state)
    if (out) this.emit(out)
  }
}

// --- sentences --------------------------------------------------------------

const ABBREV_RE = /\b(?:e\.g|i\.e|vs|dr|approx|fig|ca|cf|etc|al|mr|ms)\.$/i
const CONCLUSION_RE = /\b(?:therefore|thus|taken together|together|overall|consequently|hence|collectively|in sum|combined|suggests?|implies|imply)\b/i

/** Split one line of prose into sentences, keeping any markers attached to the sentence they close. */
export function splitSentences(line: string): string[] {
  const out: string[] = []
  let start = 0
  const re = /[.!?]+(?:\s*\[\d+(?:\s*,\s*\d+)*\])*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    const end = m.index + m[0].length
    const after = line.slice(end)
    // A boundary needs whitespace and a capital, digit or opener next (or the end of the line):
    // "1.6 g/kg" and "e.g. the" are not boundaries.
    if (after.length && !/^\s+["'“‘([]?[A-Z0-9]/.test(after)) continue
    if (ABBREV_RE.test(line.slice(start, m.index + 1))) continue
    out.push(line.slice(start, end))
    start = end
  }
  if (start < line.length) out.push(line.slice(start))
  return out.map(s => s.trim()).filter(Boolean)
}

function stripMarkers(s: string): string {
  return s
    .replace(MARKER_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
}

export type ParsedBrief = {
  /** The brief the physician reads: markers renumbered, follow-ups removed. */
  body: string
  /** Stored sentence model (lib/blocks): cited -> sourced / synthesis, uncited -> connective. */
  sentences: Sentence[]
  /** Printed number -> claim id, in order of first appearance. */
  cited: Cited[]
  followUps: string[]
  /** Markers that named no candidate (stripped from the body). */
  danglingMarkers: number
  /** Sentences that cited only non-candidates: they read as connective but asserted something. */
  unsupportedSentences: number
}

/** `candidateMap`: candidate number (as shown to the composer) -> claim id. */
export function parseBrief(raw: string, candidateMap: Map<number, string>): ParsedBrief {
  const tagAt = raw.indexOf(FOLLOW_UPS_TAG)
  const bodyRaw = tagAt >= 0 ? raw.slice(0, tagAt) : raw
  const tail = tagAt >= 0 ? raw.slice(tagAt + FOLLOW_UPS_TAG.length) : ''
  const resolve = (n: number) => candidateMap.has(n)

  const state = newMarkerState()
  const body = rewriteMarkers(bodyRaw, resolve, state).trim()

  const sentences: Sentence[] = []
  let unsupported = 0
  for (const rawLine of bodyRaw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const prose = line.replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    for (const s of splitSentences(prose)) {
      const nums = [...s.matchAll(MARKER_RE)].flatMap(m => m[2].split(',').map(x => Number(x.trim())))
      const ids = [...new Set(nums.filter(resolve).map(n => candidateMap.get(n)!))]
      const text = stripMarkers(s)
      if (!text) continue
      if (ids.length === 0) {
        if (nums.length > 0) unsupported++
        sentences.push({ kind: 'connective', text })
      } else if (ids.length >= 2 && CONCLUSION_RE.test(text)) {
        sentences.push({ kind: 'synthesis', text, claim_ids: ids })
      } else {
        sentences.push({ kind: 'sourced', text, claim_ids: ids })
      }
    }
  }

  const followUps = tail
    .split('\n')
    .map(l => stripMarkers(l.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '').replace(/^["“]|["”]$/g, '')))
    .filter(Boolean)
    .slice(0, 3)

  return {
    body,
    sentences,
    cited: state.order.map((n, i) => ({ n: i + 1, claim_id: candidateMap.get(n)! })),
    followUps,
    danglingMarkers: state.dangling,
    unsupportedSentences: unsupported,
  }
}
