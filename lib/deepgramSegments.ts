/**
 * Deepgram utterances → the transcript shape the pipeline stores.
 *
 * Shared by scripts/attachTranscripts.ts (new episodes) and
 * scripts/repairDeepgramTiming.ts (fixing the ones already attached).
 *
 * THE 2026-10-12 TIMING BUG. The first attach merged consecutive utterances by
 * the same speaker into ONE timed segment, so a six-minute host monologue became
 * a single segment starting at 0:11. Chunks are ~2,400 characters (a minute or
 * two of speech), so every chunk inside that monologue — and every insight in
 * them — inherited 0:11. Episode 387 kept 79 segments out of 1,340 utterances;
 * Paul spotted six chunks at 0:11 followed by a jump to 4:59. Timing was coarse,
 * not wrong, but a deep-link that lands minutes early is useless for following
 * along.
 *
 * Now every utterance stays its own segment (median ~3 s). The speaker label is
 * written ONCE per turn, at the start of the turn's first utterance, exactly as
 * before — so `segments.map(s => s.text).join(' ')` is byte-identical to the
 * transcript the merged version produced, and the chunk→segment alignment in
 * lib/transcriptSegments.ts needs no change.
 */

export const HOST = 'Peter Attia'

export type DgSegment = { text: string; speaker: number | null; start_ms: number; end_ms: number }
export type LabelledSegment = { text: string; start_ms: number; end_ms: number }

/**
 * Map Deepgram's speaker indices to names, or leave them numbered.
 *
 * Diarization establishes that two people alternate; it never says who they
 * are. The speaker who opens the episode is the host (these episodes begin with
 * a scripted host intro). When the feed names EXACTLY ONE guest, the other
 * speaker is that guest; otherwise speakers stay `Speaker 2`, `Speaker 3`, …
 * A wrong name is worse than no name: corroboration counts DISTINCT speakers,
 * so a misattribution invents agreement between people who never spoke.
 */
export function nameSpeakers(segments: DgSegment[], guests: string[]): Map<number, string> {
  const names = new Map<number, string>()
  const first = segments.find(s => s.speaker !== null)?.speaker
  if (first == null) return names
  names.set(first, HOST)

  const others = [...new Set(segments.map(s => s.speaker).filter(s => s !== null && s !== first))] as number[]
  if (guests.length === 1 && others.length === 1) {
    names.set(others[0], guests[0])
  } else {
    // Two guests and two unnamed speakers is NOT enough to pair them — the feed
    // lists guests in title order, which need not match speaking order.
    others.forEach((sp, i) => names.set(sp, `Speaker ${i + 2}`))
  }
  return names
}

/**
 * One segment per utterance, the speaker label on the first utterance of each
 * turn. Consecutive utterances by the same speaker share a turn.
 */
export function buildLabelledSegments(segments: DgSegment[], names: Map<number, string>): LabelledSegment[] {
  const out: LabelledSegment[] = []
  let currentLabel: string | null = null
  for (const s of segments) {
    const label = s.speaker != null ? names.get(s.speaker) ?? `Speaker ${s.speaker + 1}` : null
    const newTurn = label !== null && label !== currentLabel
    if (label !== null) currentLabel = label
    out.push({ text: newTurn ? `${label}: ${s.text}` : s.text, start_ms: s.start_ms, end_ms: s.end_ms })
  }
  return out
}

/** The stored `sources.transcript` is the segments' text joined by single spaces. */
export function transcriptText(segments: LabelledSegment[]): string {
  return segments.map(s => s.text).join(' ')
}
