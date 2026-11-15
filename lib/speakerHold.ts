/**
 * The hold: an episode whose transcript still has a voice Paul has not dealt with is never picked for
 * extraction (Paul, 2026-11-08: a third or unnamed voice is never guessed; he assigns it on /admin/speakers).
 *
 * "Unnamed" means the same thing here as on that page: a `Speaker N: ` label (lib/speakerReview.ts
 * `isUnnamedLabel`). Names reach the transcript only at the next re-attach, so a voice whose saved answer
 * is a name is still unnamed (and the episode still held) until then. A voice answered "Not A Guest"
 * (`name: null`) is dealt with and does not hold the episode.
 *
 * Pure functions only; the supervisor (scripts/extractDeepgram.ts) does the database reads.
 */
import { isUnnamedLabel, readSpeakerNames } from './speakerReview'

/** The Postgres regex the review page uses to find a transcript with an unnamed voice. */
export const UNNAMED_VOICE_SQL_REGEX = 'Speaker [0-9]+: '

/** Emergency off switch, default on: `EXTRACT_HOLD_UNREVIEWED_VOICES=0` turns the hold off. */
export function holdUnreviewedVoicesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.EXTRACT_HOLD_UNREVIEWED_VOICES ?? '').trim() !== '0'
}

/** The distinct unnamed labels (`Speaker 2`, …) that appear as turn labels in a stored transcript. */
export function unnamedLabelsIn(transcript: string | null | undefined): string[] {
  const found = new Set<string>()
  for (const m of (transcript ?? '').matchAll(/(?:^|\s)(Speaker \d+): /g)) if (isUnnamedLabel(m[1])) found.add(m[1])
  return [...found]
}

/** Unnamed voices in the transcript that Paul has not answered "Not A Guest". Empty = nothing to wait for. */
export function unresolvedVoices(transcript: string | null | undefined, speakerNames: unknown): string[] {
  const saved = readSpeakerNames(speakerNames)
  return unnamedLabelsIn(transcript).filter(label => !(label in saved && saved[label].name === null))
}

/** True when the episode must wait for Paul's speaker review. */
export function isHeldForSpeakerReview(transcript: string | null | undefined, speakerNames: unknown): boolean {
  return unresolvedVoices(transcript, speakerNames).length > 0
}
