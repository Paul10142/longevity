/**
 * Recover timing for a transcript that has none, by aligning it against the
 * timestamped captions of the same recording.
 *
 * The situation this solves: a show publishes an accurate, speaker-labelled
 * transcript with no timestamps, and YouTube carries auto-captions for the same
 * episode that are the mirror image — sloppy words, timed every few seconds.
 * Neither alone is enough; together they give accurate text, real speaker names,
 * AND timing.
 *
 * HOW IT WORKS, AND WHY IT IS ANCHORS RATHER THAN A DIFF. The two texts never
 * match closely — one is human, one is a machine guess, and roughly 40% of
 * six-word windows differ. But timing does not need every word matched: it needs
 * enough EXACT common sequences ("anchors") spread through the recording to
 * interpolate between. Measured on three episodes, every one of 20 sections
 * contained at least one anchor and every anchor advanced in time.
 *
 * TWO RULES PROTECT AGAINST FALSE ANCHORS, which are the real failure mode — a
 * repeated stock phrase matching the wrong part of the episode would drag a
 * claim's timestamp somewhere else entirely:
 *   1. an n-gram that appears MORE THAN ONCE in the captions is discarded, so
 *      only sequences unique to one moment can anchor;
 *   2. anchors must advance monotonically; one that jumps backwards is dropped
 *      rather than trusted.
 *
 * Timing between anchors is linear interpolation on word position, and turns
 * outside the first/last anchor inherit the nearest one. So a returned time is
 * ALWAYS derived, never measured — callers should record it as such.
 */

export type TimedCaption = { start_ms: number; text: string }
export type Turn = { speaker: string | null; text: string }
export type TimedTurn = { text: string; speaker: string | null; start_ms: number; end_ms: number }

const GRAM = 6

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/** n-gram → time, keeping only n-grams that occur exactly once. */
function buildAnchorIndex(captions: TimedCaption[]): Map<string, number> {
  const words: [string, number][] = []
  for (const c of captions) {
    for (const w of normalize(c.text).split(' ')) if (w) words.push([w, c.start_ms])
  }
  const seen = new Map<string, number>()
  const dupes = new Set<string>()
  for (let i = 0; i <= words.length - GRAM; i++) {
    const g = words.slice(i, i + GRAM).map(x => x[0]).join(' ')
    if (seen.has(g)) { dupes.add(g); continue }
    seen.set(g, words[i][1])
  }
  for (const d of dupes) seen.delete(d)
  return seen
}

/**
 * Assign a start/end time to every turn.
 *
 * `durationMs` bounds the last turn; without it the final turn would end at its
 * own start, which reads as a zero-length span.
 */
export function alignTurns(turns: Turn[], captions: TimedCaption[], durationMs?: number): {
  timed: TimedTurn[]
  anchors: number
  coverage: number
} {
  const index = buildAnchorIndex(captions)

  // Flatten to words while remembering which turn each word belongs to, so an
  // anchor found mid-turn still dates that turn.
  const wordTurn: number[] = []
  const words: string[] = []
  turns.forEach((t, ti) => {
    for (const w of normalize(t.text).split(' ')) if (w) { words.push(w); wordTurn.push(ti) }
  })

  // Anchor positions: (word index, time), monotonic only.
  const points: [number, number][] = []
  let lastTime = -1
  for (let i = 0; i <= words.length - GRAM; i++) {
    const t = index.get(words.slice(i, i + GRAM).join(' '))
    if (t === undefined) continue
    if (t < lastTime) continue // backwards jump — a false match, discard
    points.push([i, t])
    lastTime = t
    i += GRAM - 1 // don't stack overlapping anchors from the same phrase
  }

  const timeAtWord = (i: number): number => {
    if (points.length === 0) return 0
    if (i <= points[0][0]) return points[0][1]
    if (i >= points[points.length - 1][0]) return points[points.length - 1][1]
    // binary search for the bracketing anchors
    let lo = 0
    let hi = points.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (points[mid][0] <= i) lo = mid
      else hi = mid
    }
    const [i0, t0] = points[lo]
    const [i1, t1] = points[hi]
    if (i1 === i0) return t0
    return Math.round(t0 + ((i - i0) / (i1 - i0)) * (t1 - t0))
  }

  const firstWordOfTurn = new Map<number, number>()
  wordTurn.forEach((ti, wi) => { if (!firstWordOfTurn.has(ti)) firstWordOfTurn.set(ti, wi) })

  const starts = turns.map((_, ti) => {
    const wi = firstWordOfTurn.get(ti)
    return wi === undefined ? 0 : timeAtWord(wi)
  })

  const lastEnd = durationMs ?? (captions.length ? captions[captions.length - 1].start_ms + 5000 : 0)
  const timed: TimedTurn[] = turns.map((t, ti) => ({
    text: t.speaker ? `${t.speaker}: ${t.text}` : t.text,
    speaker: t.speaker,
    start_ms: starts[ti],
    // A turn ends where the next begins; never before it starts.
    end_ms: Math.max(starts[ti], ti + 1 < starts.length ? starts[ti + 1] : lastEnd),
  }))

  // Coverage: fraction of 20 equal sections containing at least one anchor.
  const BINS = 20
  const per = Math.max(1, Math.floor(words.length / BINS))
  const hit = new Set<number>()
  for (const [wi] of points) hit.add(Math.min(BINS - 1, Math.floor(wi / per)))

  return { timed, anchors: points.length, coverage: hit.size / BINS }
}

/**
 * Split a published transcript into turns on inline `Name:` labels.
 *
 * Labels are matched only when they look like a person's name — up to three
 * capitalised words. A looser rule swallows ordinary mid-sentence colons
 * ("The result: nothing") and would silently invent a speaker.
 */
export function splitTurns(text: string, knownSpeakers: string[] = []): Turn[] {
  const known = new Set(knownSpeakers.map(s => s.toLowerCase()))
  const re = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}):\s/g
  const turns: Turn[] = []
  let cursor = 0
  let speaker: string | null = null
  for (const m of text.matchAll(re)) {
    const name = m[1].trim()
    // When the speaker list is known, trust only those names; a stray
    // capitalised phrase followed by a colon is not a turn.
    if (known.size > 0 && !known.has(name.toLowerCase())) continue
    const body = text.slice(cursor, m.index).trim()
    if (body) turns.push({ speaker, text: body })
    speaker = name
    cursor = (m.index ?? 0) + m[0].length
  }
  const tail = text.slice(cursor).trim()
  if (tail) turns.push({ speaker, text: tail })
  return turns.filter(t => t.text.length > 0)
}

/** Speaker names that appear as inline labels, most frequent first. */
export function detectSpeakers(text: string, min = 3): string[] {
  const counts = new Map<string, number>()
  for (const m of text.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}):\s/g)) {
    const n = m[1].trim()
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n)
}
