/**
 * Deepgram transcripts on disk → `sources.transcript` + `timed_transcript`,
 * ready for extraction.
 *
 *   npx tsx --env-file=.env.local scripts/attachTranscripts.ts <dir> [--dry-run] [--limit N]
 *
 * This is the missing link between transcription and the library: the
 * transcriber writes files, extraction reads database columns, and nothing
 * joined them. Matching is by `external_id`, the same key the audio file and the
 * feed row share (`attia-0405`).
 *
 * SPEAKER NAMES ARE WRITTEN INTO THE TRANSCRIPT TEXT, as `Name: …` at the start
 * of each turn. That is deliberate rather than a new column: `TimedSegment` is
 * `{text, start_ms, end_ms}` and `normalizeYouTubeSegments` copies exactly those
 * three fields, so any extra field is silently dropped on the way into
 * extraction. Putting the name in the text is the one representation that
 * survives chunking, hygiene, and quote resolution untouched — and it is what
 * the extraction prompt needs, since it currently has to INFER who is speaking
 * from dialogue alone (only 28% of insights carry a speaker today).
 *
 * NAMING IS CONSERVATIVE. Diarization establishes that two people alternate; it
 * never says who they are. So:
 *   - the speaker who opens the episode is the host (these episodes begin with a
 *     scripted host intro — verified on 404, where speaker 0 delivers it),
 *   - when the source row's `authors` names EXACTLY ONE guest (host =
 *     `authors[0]`, guests = the rest), the other speaker is that guest,
 *   - otherwise speakers stay `Speaker 2`, `Speaker 3`, … unnamed (a third voice is
 *     NEVER guessed: on the FoundMyFitness episodes it is the host herself),
 *   - unless Paul has assigned them: `sources.speaker_names` (migration 039, written
 *     only by /admin/speakers) maps `Speaker N` → a name from the row's own authors,
 *     and this script applies it, after checking that each answer's fingerprint still
 *     matches the voice now carrying that number (lib/speakerReview.ts
 *     `nameSpeakersAssigned`). A mapping that no longer matches the file is ignored and
 *     the log says so; a column that does not exist yet (migration not applied) is
 *     treated as no mapping.
 * `authors` is where Claude's reading of the guests lands (`refreshGuests.ts
 * --apply`), so that step comes BEFORE this one; `manifest.json` is only the
 * fallback for a row whose `authors` is null.
 * A wrong name is worse than no name: corroboration counts DISTINCT SPEAKERS, so
 * a misattribution invents agreement between people who never spoke.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// Speaker naming and segment building live in lib/deepgramSegments.ts, shared
// with scripts/repairDeepgramTiming.ts. One segment PER UTTERANCE: the first
// attach merged a speaker's consecutive utterances into one segment, which
// collapsed a whole monologue onto its first timestamp (2026-10-12).
import { buildLabelledSegments, guestsForLabels } from '../lib/deepgramSegments'
import type { DgSegment } from '../lib/deepgramSegments'
// Paul's saved speaker assignments (sources.speaker_names) and how they are applied to a file.
import { nameSpeakersAssigned, readSpeakerNames } from '../lib/speakerReview'
// The host's name comes from the registry, by the key's prefix (`huberman-…` →
// Andrew Huberman). It used to be a constant, which would have labelled every
// show's opening speaker "Peter Attia".
import { hostLabelForKey } from '../lib/shows'

type DgFile = { key: string; model: string; speakers: number[]; segments: DgSegment[]; duration_seconds: number | null }

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

async function main() {
  const dir = args.find(a => !a.startsWith('--') && !['--limit'].includes(args[args.indexOf(a) - 1]))
  if (!dir) throw new Error('usage: attachTranscripts.ts <dir-of-deepgram-json> [--dry-run] [--limit N]')
  const dryRun = has('--dry-run')
  const limit = Number(val('--limit')) || Infinity

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const files = (await readdir(dir)).filter(f => f.endsWith('.deepgram.json')).sort().reverse()
  if (files.length === 0) throw new Error(`no .deepgram.json files in ${dir}`)

  // The feed manifest written by fetchPodcastFeed is only the FALLBACK for a row
  // whose `sources.authors` is null. Guests come from `authors` (host =
  // `authors[0]`, guests = the rest), which `refreshGuests.ts --apply` corrects,
  // so apply the guest plan BEFORE attaching (see guestsForLabels). `authors` holds
  // each guest as the show writes them (`Sally Greenwald, M.D.`); the speaker labels
  // baked into the transcript are bare (`Sally Greenwald:`), which guestsForLabels does.
  let guestsByKey = new Map<string, string[]>()
  try {
    const man = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      episodes: { key: string; guests?: string[] }[]
    }
    guestsByKey = new Map(man.episodes.map(e => [e.key, e.guests ?? []]))
  } catch {
    process.stdout.write('warning: no manifest.json — rows with no `authors` will have numbered speakers, not named\n')
  }

  const keys = files.map(f => f.replace(/\.(nova-3-medical|nova-3)?\.?deepgram\.json$/, ''))
  type SourceRow = {
    id: string
    external_id: string | null
    processing_status: string | null
    title: string | null
    authors: string[] | null
    /** Paul's reviewed speaker names (migration 039); absent until that migration is applied. */
    speaker_names?: unknown
  }
  const baseColumns = 'id, external_id, processing_status, title, authors'
  let { data: rows, error } = await db.from('sources').select(`${baseColumns}, speaker_names`).in('external_id', keys)
  if (error && /speaker_names/.test(error.message)) {
    // Migration 039 is not applied yet: no episode has a review, so there is nothing to apply.
    process.stdout.write('note: sources.speaker_names does not exist yet (migration 039), so no saved speaker assignments are applied\n')
    ;({ data: rows, error } = await db.from('sources').select(baseColumns).in('external_id', keys))
  }
  if (error) throw new Error(`source lookup failed: ${error.message}`)
  const byKey = new Map(((rows ?? []) as unknown as SourceRow[]).map(r => [r.external_id as string, r]))

  let attached = 0
  let skippedDone = 0
  let skippedDup = 0
  let unmatched = 0
  let unknownShow = 0
  let named = 0
  let guestsFromManifest = 0
  let assignedApplied = 0
  let assignedIgnored = 0

  for (const [i, file] of files.entries()) {
    if (attached >= limit) break
    const key = keys[i]
    const row = byKey.get(key)
    if (!row) { unmatched++; continue }
    // Leave already-extracted sources alone. Replacing their transcript would
    // orphan the claims already built from the old one — that is the separate
    // "redo the 107" job, with its own reconciliation.
    if (row.processing_status === 'succeeded') { skippedDone++; continue }
    // A skipped row (migration 038) is a re-post or copy of an episode we already hold. Writing
    // its transcript would set it back to 'pending' below and queue the duplicate for extraction
    // — the exact cost the skip exists to prevent. Its transcript file, if one exists, is left alone.
    if (row.processing_status === 'skipped') { skippedDup++; continue }
    // No registered host means no safe name for the opening speaker. Skip loudly
    // rather than guess: a wrong name is worse than a skipped file.
    const host = hostLabelForKey(key)
    if (!host) {
      unknownShow++
      process.stdout.write(`  ${key}: no show is registered for this key's prefix — skipped (add it to lib/shows.ts)\n`)
      continue
    }

    const dg = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as DgFile
    if (!dg.segments?.length) { process.stdout.write(`  ${key}: no segments, skipped\n`); continue }

    const choice = guestsForLabels({ row, manifestGuests: guestsByKey.get(key), host })
    if (choice.from === 'manifest') guestsFromManifest++
    const assigned = nameSpeakersAssigned(dg.segments, choice.guests, host, readSpeakerNames(row.speaker_names))
    const names = assigned.names
    if (assigned.applied.length > 0) { process.stdout.write(`  ${key}: applied Paul's speaker assignments: ${assigned.applied.join('; ')}\n`); assignedApplied++ }
    if (assigned.ignored) { process.stdout.write(`  ${key}: saved speaker assignments NOT applied: ${assigned.ignored}\n`); assignedIgnored++ }
    const hasRealName = [...names.values()].some(n => n !== host && !n.startsWith('Speaker '))

    const timed = buildLabelledSegments(dg.segments, names)
    const transcript = timed.map(s => s.text).join(' ')

    if (dryRun) {
      process.stdout.write(
        `  ${key}: ${timed.length} turns, ${transcript.length} chars, speakers: ${[...names.values()].join(', ')}\n`
      )
      attached++
      if (hasRealName) named++
      continue
    }

    const { error: upErr } = await db
      .from('sources')
      .update({
        transcript,
        timed_transcript: timed,
        transcript_origin: 'deepgram',
        // Diarized, punctuated, cased, medical-model — a different class from the
        // 'medium' YouTube auto-captions this replaces.
        transcript_quality: 'high',
        // Integer column — Deepgram returns fractional seconds (7474.1626),
        // which Postgres rejects outright rather than truncating.
        media_duration_sec: dg.duration_seconds != null ? Math.round(dg.duration_seconds) : null,
        processing_status: 'pending',
        processing_error: null,
      })
      .eq('id', row.id)
    if (upErr) { process.stdout.write(`  ${key} FAILED: ${upErr.message}\n`); continue }
    attached++
    if (hasRealName) named++
  }

  process.stdout.write(
    `\n${dryRun ? 'would attach' : 'attached'} ${attached} | already extracted, left alone ${skippedDone} | ` +
      (skippedDup ? `skipped re-posts, left alone ${skippedDup} | ` : '') +
      `no matching source ${unmatched}` + (unknownShow ? ` | no registered show ${unknownShow}` : '') + `\n` +
      `${named} of ${attached} have a named guest; the rest are solo or numbered\n`
  )
  if (assignedApplied + assignedIgnored > 0) {
    process.stdout.write(
      `speaker assignments: applied for ${assignedApplied} episode(s)` +
        (assignedIgnored ? `, NOT applied for ${assignedIgnored} (the file no longer matches what was reviewed; review it again on /admin/speakers)` : '') + '\n'
    )
  }
  if (guestsFromManifest > 0) {
    process.stdout.write(
      `${guestsFromManifest} of ${attached} source rows have no \`authors\`, so their manifest guests were used ` +
        `(refreshGuests.ts --apply is what writes authors)\n`
    )
  }
  if (!dryRun && attached > 0) process.stdout.write('these sources are now pending — the extraction worker will pick them up\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
