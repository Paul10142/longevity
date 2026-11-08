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
 *   - when the episode has EXACTLY ONE guest, the other speaker is that guest,
 *   - otherwise speakers stay `Speaker 2`, `Speaker 3`, … unnamed.
 * A wrong name is worse than no name: corroboration counts DISTINCT SPEAKERS, so
 * a misattribution invents agreement between people who never spoke.
 *
 * WHERE THE GUEST COMES FROM (2026-11-08). The source row's `authors` in the
 * database (`[host, ...guests]`, host first; lib/shows.ts), NOT the audio folder's
 * `manifest.json`. `refreshGuests.ts --apply` writes the guests Claude read from
 * each title and its show notes into `sources.authors`; the manifest keeps the
 * old title-rule guests and is never updated, so reading it would label speakers
 * with names the database no longer holds. The manifest is only the fallback for
 * a row that names nobody but the host (see `speakerGuestCandidates` for the
 * cost of that). Order of work: ingest, plan guests, dry-run, apply, THEN attach
 * (docs/EXTRACTION_RUNBOOK.md §14).
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

// Speaker naming and segment building live in lib/deepgramSegments.ts, shared
// with scripts/repairDeepgramTiming.ts. One segment PER UTTERANCE: the first
// attach merged a speaker's consecutive utterances into one segment, which
// collapsed a whole monologue onto its first timestamp (2026-10-12).
import { nameSpeakers, buildLabelledSegments, chooseSpeakerGuests, manifestGuestsByKey } from '../lib/deepgramSegments'
import type { DgSegment, GuestSource } from '../lib/deepgramSegments'
// The host's name comes from the registry, by the key's prefix (`huberman-…` →
// Andrew Huberman). It used to be a constant, which would have labelled every
// show's opening speaker "Peter Attia".
import { showByExternalId } from '../lib/shows'

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

  // The feed manifest written by fetchPodcastFeed holds the OLD title-rule guests.
  // It is only the fallback for a row whose `authors` names nobody but the host;
  // the guests come from the database row (see the header, and lib/deepgramSegments.ts).
  let manifestGuests = new Map<string, string[]>()
  try {
    manifestGuests = manifestGuestsByKey(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')))
  } catch {
    process.stdout.write('warning: no readable manifest.json — guest names come from the database only\n')
  }

  const keys = files.map(f => f.replace(/\.(nova-3-medical|nova-3)?\.?deepgram\.json$/, ''))
  type SourceRow = { id: string; external_id: string | null; processing_status: string | null; title: string | null; authors: string[] | null }
  const { data: rows, error } = await db
    .from('sources')
    .select('id, external_id, processing_status, title, authors')
    .in('external_id', keys)
  if (error) throw new Error(`source lookup failed: ${error.message}`)
  const byKey = new Map(((rows ?? []) as unknown as SourceRow[]).map(r => [r.external_id as string, r]))

  let attached = 0
  let skippedDone = 0
  let unmatched = 0
  let unknownShow = 0
  let named = 0
  const guestSources: Record<GuestSource, number> = { database: 0, manifest: 0, none: 0 }

  for (const [i, file] of files.entries()) {
    if (attached >= limit) break
    const key = keys[i]
    const row = byKey.get(key)
    if (!row) { unmatched++; continue }
    // Leave already-extracted sources alone. Replacing their transcript would
    // orphan the claims already built from the old one — that is the separate
    // "redo the 107" job, with its own reconciliation.
    if (row.processing_status === 'succeeded') { skippedDone++; continue }
    // No registered host means no safe name for the opening speaker. Skip loudly
    // rather than guess: a wrong name is worse than a skipped file.
    const show = showByExternalId(key)
    if (!show) {
      unknownShow++
      process.stdout.write(`  ${key}: no show is registered for this key's prefix — skipped (add it to lib/shows.ts)\n`)
      continue
    }
    const host = show.hostLabel

    const dg = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as DgFile
    if (!dg.segments?.length) { process.stdout.write(`  ${key}: no segments, skipped\n`); continue }

    // Guests: the row's `authors` first, the manifest only when the row has none.
    const { guests, source: guestSource } = chooseSpeakerGuests(show, row.authors, manifestGuests.get(key))
    const names = nameSpeakers(dg.segments, guests, host)
    const hasRealName = [...names.values()].some(n => n !== host && !n.startsWith('Speaker '))

    const timed = buildLabelledSegments(dg.segments, names)
    const transcript = timed.map(s => s.text).join(' ')

    if (dryRun) {
      process.stdout.write(
        `  ${key}: ${timed.length} turns, ${transcript.length} chars, speakers: ${[...names.values()].join(', ')} ` +
          `[guests: ${guestSource}${guests.length ? ` = ${guests.join(' | ')}` : ''}]\n`
      )
      attached++
      guestSources[guestSource]++
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
    guestSources[guestSource]++
    if (hasRealName) named++
  }

  process.stdout.write(
    `\n${dryRun ? 'would attach' : 'attached'} ${attached} | already extracted, left alone ${skippedDone} | ` +
      `no matching source ${unmatched}` + (unknownShow ? ` | no registered show ${unknownShow}` : '') + `\n` +
      `${named} of ${attached} have a named guest; the rest are solo or numbered\n` +
      `guest list from: database ${guestSources.database} | manifest fallback ${guestSources.manifest} | none ${guestSources.none}` +
      (guestSources.manifest > 0 ? ' — the manifest holds the OLD title-rule guests: did you apply the guest plan (refreshGuests --apply) first?' : '') +
      `\n`
  )
  if (!dryRun && attached > 0) process.stdout.write('these sources are now pending — the extraction worker will pick them up\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
