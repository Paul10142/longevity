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

import { isHostName, type Show } from './shows'

export type DgSegment = { text: string; speaker: number | null; start_ms: number; end_ms: number }
export type LabelledSegment = { text: string; start_ms: number; end_ms: number }

/** Where an episode's guest names came from. */
export type GuestSource = 'database' | 'manifest' | 'none'
export type GuestChoice = { guests: string[]; source: GuestSource }

/**
 * Trim, drop blanks, drop the show's host and drop repeats (ignoring case).
 * The host is dropped by NAME, in any usual spelling, not by position: `authors`
 * is `[host, ...guests]` on every row the ingest writes, but a hand-edited row,
 * a title-rule leftover or a manifest from before the strict guest rule can have
 * the host anywhere, and the host labelling their own guest is the one error
 * this list must never produce. Another show's host stays: Rhonda Patrick is a
 * real guest on Huberman Lab.
 */
export function cleanGuestNames(show: Show, names: readonly unknown[] | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names ?? []) {
    if (typeof raw !== 'string') continue
    const name = raw.replace(/\s+/g, ' ').trim()
    if (!name || isHostName(show, name)) continue
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
  }
  return out
}

/**
 * Guest names for labelling an episode's speakers, best source first.
 *
 *   1. `sources.authors` (the database): the guests are everything after the host.
 *      `refreshGuests.ts --apply` writes Claude's reading of the title and show
 *      notes there, so this is the source of truth for who the guest is.
 *   2. The feed manifest's `guests` (the local `manifest.json` that
 *      `fetchPodcastFeed.ts` writes), as a FALLBACK when the row names nobody but
 *      the host, or has no authors. The manifest holds the old title-rule guests
 *      and is never updated by `refreshGuests --apply`, which is why it must not
 *      win over the database. It stays as a fallback so an episode whose row was
 *      never given guests, or a flow that has no row authors yet, still gets a
 *      named guest instead of `Speaker 2`. Cost: a row Claude deliberately left
 *      host-only (a solo episode) can pick up a stale title-rule name here, so
 *      apply the guest plan BEFORE attaching (docs/EXTRACTION_RUNBOOK.md §14) and
 *      read the `guests:` source the attach prints in its dry run.
 *
 * Only the host's own spelling is filtered out of both lists (`cleanGuestNames`).
 * Returned in preference order, with the manifest entry left out when it adds
 * nothing (empty, or the same names as the database).
 */
export function speakerGuestCandidates(
  show: Show,
  authors: readonly string[] | null | undefined,
  manifestGuests: readonly string[] | null | undefined
): GuestChoice[] {
  const fromDb = cleanGuestNames(show, authors)
  const fromManifest = cleanGuestNames(show, manifestGuests)
  const out: GuestChoice[] = []
  if (fromDb.length > 0) out.push({ guests: fromDb, source: 'database' })
  const same = fromManifest.length === fromDb.length && fromManifest.every((g, i) => g.toLowerCase() === fromDb[i].toLowerCase())
  if (fromManifest.length > 0 && !same) out.push({ guests: fromManifest, source: 'manifest' })
  return out
}

/** The guests to label speakers with: the first candidate, or none. */
export function chooseSpeakerGuests(
  show: Show,
  authors: readonly string[] | null | undefined,
  manifestGuests: readonly string[] | null | undefined
): GuestChoice {
  return speakerGuestCandidates(show, authors, manifestGuests)[0] ?? { guests: [], source: 'none' }
}

/**
 * `manifest.json` → guests by episode key. Tolerant: a missing, malformed or
 * oddly-shaped manifest gives an empty map, never a throw, because the manifest
 * is only a fallback now.
 */
export function manifestGuestsByKey(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const episodes = (raw as { episodes?: unknown } | null)?.episodes
  if (!Array.isArray(episodes)) return out
  for (const e of episodes) {
    const ep = e as { key?: unknown; guests?: unknown } | null
    if (!ep || typeof ep.key !== 'string') continue
    out.set(ep.key, Array.isArray(ep.guests) ? ep.guests.filter((g): g is string => typeof g === 'string') : [])
  }
  return out
}

/**
 * Map Deepgram's speaker indices to names, or leave them numbered.
 *
 * Diarization establishes that two people alternate; it never says who they
 * are. The speaker who opens the episode is the host (these episodes begin with
 * a scripted host intro). When `guests` has EXACTLY ONE name (from
 * `chooseSpeakerGuests`: the source row's `authors`, else the feed manifest), the
 * other speaker is that guest; otherwise speakers stay `Speaker 2`, `Speaker 3`, …
 * A wrong name is worse than no name: corroboration counts DISTINCT speakers,
 * so a misattribution invents agreement between people who never spoke.
 *
 * `host` is a REQUIRED argument, never a default: it is the show's host label
 * (`show.hostLabel` in lib/shows.ts, resolved from the join key's prefix). It is
 * deliberately NOT `authors[0]`: that is the display form (`Dr. Peter Attia`), and
 * the label written into a transcript must stay byte-stable so the timing repair
 * can prove its rebuilt text equals the stored text.
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

/**
 * Rebuild an already-attached episode's segments so their joined text is
 * byte-identical to the stored transcript, for the timing repair.
 *
 * Tries each candidate guest list in order (the attach's own order, from
 * `speakerGuestCandidates`), then "no guest" last, and returns the first that
 * reproduces `stored`, with the source it used. Null when none does (the
 * transcript was edited since, or labelled from a guest list that no longer
 * exists anywhere): the caller leaves that source alone.
 *
 * Why not just rebuild from today's `authors`: `refreshGuests --apply` can change
 * `authors` after an episode was attached, and the repair must reproduce the
 * stored labels, not relabel them.
 */
export function rebuildToStored(
  segments: DgSegment[],
  host: string,
  candidates: readonly GuestChoice[],
  stored: string
): { segments: LabelledSegment[]; source: GuestSource } | null {
  for (const c of [...candidates, { guests: [], source: 'none' as const }]) {
    const rebuilt = buildLabelledSegments(segments, nameSpeakers(segments, c.guests, host))
    if (transcriptText(rebuilt) === stored) return { segments: rebuilt, source: c.source }
  }
  return null
}
