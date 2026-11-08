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

import { bareName, bareNames, foldForMatch } from './personName'

export type DgSegment = { text: string; speaker: number | null; start_ms: number; end_ms: number }
export type LabelledSegment = { text: string; start_ms: number; end_ms: number }

export type GuestChoice = {
  guests: string[]
  /** Where the list came from: the source row's `authors`, the feed manifest, or neither (no row, no manifest entry). */
  from: 'authors' | 'manifest' | 'none'
}

/**
 * Which guest names label the speakers of one episode.
 *
 * `sources.authors` is the single record of who the guests are: `[host, ...guests]`,
 * written by the ingest and then corrected by `scripts/refreshGuests.ts` (Claude
 * reads the title and show notes). The attach used to take guests from the
 * `manifest.json` that `fetchPodcastFeed` writes in each audio folder, which holds
 * only the title-rule guests, so applying a guest plan did not change the
 * `Name:` labels baked into the transcripts.
 *
 *   - Row has authors: guests are `authors.slice(1)`. Authors that are just the
 *     host mean the episode has NO guest, which is a real answer, so the manifest
 *     is NOT consulted. Anyone who repeats the host (by the first author's name
 *     or the show's host label) is dropped, and repeats are removed, in order.
 *   - Row has no authors value (null or empty): the manifest guests, as before.
 *   - No row: the manifest guests too (callers skip such an episode anyway).
 *
 * LABELS ARE BARE. `authors` carries each guest as the show writes them, credentials
 * included (`Sally Greenwald, M.D., M.P.H.`); the label is `Sally Greenwald:`. A
 * credential in a label would make one person two speakers, and corroboration counts
 * distinct speakers. So every name returned here has its `Dr.`/credentials removed
 * (`bareName`), and a credential left standing alone by the old comma split
 * (`M.P.H.`) is dropped rather than counted as a second guest, which would stop the
 * guest being named at all (`nameSpeakers` needs exactly one). The manifest's names
 * get the same treatment.
 */
export function guestsForLabels(args: {
  row: { authors: string[] | null } | null | undefined
  manifestGuests: readonly string[] | undefined
  /** The show's host label (`hostLabelForKey(key)`), which `nameSpeakers` puts on the opening speaker. */
  host: string
}): GuestChoice {
  const { row, manifestGuests, host } = args
  const authors = row?.authors?.filter(a => typeof a === 'string' && a.trim() !== '')
  if (authors && authors.length > 0) {
    const hostKeys = new Set([foldForMatch(bareName(authors[0])), foldForMatch(host)])
    return { guests: bareNames(authors.slice(1), name => hostKeys.has(foldForMatch(name))), from: 'authors' }
  }
  if (manifestGuests) return { guests: bareNames(manifestGuests), from: 'manifest' }
  return { guests: [], from: 'none' }
}

/**
 * Map Deepgram's speaker indices to names, or leave them numbered.
 *
 * Diarization establishes that two people alternate; it never says who they
 * are. The speaker who opens the episode is the host (these episodes begin with
 * a scripted host intro). When the feed names EXACTLY ONE guest, the other
 * speaker is that guest; otherwise speakers stay `Speaker 2`, `Speaker 3`, …
 * A wrong name is worse than no name: corroboration counts DISTINCT speakers,
 * so a misattribution invents agreement between people who never spoke.
 *
 * `host` is a REQUIRED argument, never a default: it is the show's host label
 * (`hostLabelForKey(key)` in lib/shows.ts, resolved from the join key's prefix).
 * It used to be a constant "Peter Attia", which would have labelled Andrew
 * Huberman's opening monologue as Peter Attia the first time a Huberman Lab
 * episode was attached.
 */
export function nameSpeakers(segments: DgSegment[], guests: string[], host: string): Map<number, string> {
  const names = new Map<number, string>()
  const first = segments.find(s => s.speaker !== null)?.speaker
  if (first == null) return names
  names.set(first, host)

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
