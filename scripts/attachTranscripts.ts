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
 *   - when the feed names EXACTLY ONE guest, the other speaker is that guest,
 *   - otherwise speakers stay `Speaker 2`, `Speaker 3`, … unnamed.
 * A wrong name is worse than no name: corroboration counts DISTINCT SPEAKERS, so
 * a misattribution invents agreement between people who never spoke.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const HOST = 'Peter Attia'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

type DgSegment = { text: string; speaker: number | null; start_ms: number; end_ms: number }
type DgFile = { key: string; model: string; speakers: number[]; segments: DgSegment[]; duration_seconds: number | null }

/** Map Deepgram's speaker indices to names, or leave them unnamed. See header. */
function nameSpeakers(segments: DgSegment[], guests: string[]): Map<number, string> {
  const names = new Map<number, string>()
  const first = segments.find(s => s.speaker !== null)?.speaker
  if (first == null) return names
  names.set(first, HOST)

  const others = [...new Set(segments.map(s => s.speaker).filter(s => s !== null && s !== first))] as number[]
  if (guests.length === 1 && others.length === 1) {
    names.set(others[0], guests[0])
  } else {
    // Two guests and two unnamed speakers is NOT enough to pair them — the feed
    // lists guests in title order, which need not match speaking order. Number
    // them instead of guessing.
    others.forEach((sp, i) => names.set(sp, `Speaker ${i + 2}`))
  }
  return names
}

/** Turns into `Name: text`, merging consecutive turns by the same speaker so a
 *  back-and-forth does not become one label per sentence. */
function buildLabelledSegments(
  segments: DgSegment[],
  names: Map<number, string>
): { text: string; start_ms: number; end_ms: number }[] {
  const out: { text: string; start_ms: number; end_ms: number }[] = []
  for (const s of segments) {
    const label = s.speaker != null ? names.get(s.speaker) ?? `Speaker ${s.speaker + 1}` : null
    const prev = out[out.length - 1]
    const sameSpeaker = prev && label && prev.text.startsWith(`${label}:`)
    if (sameSpeaker) {
      prev.text += ` ${s.text}`
      prev.end_ms = s.end_ms
    } else {
      out.push({ text: label ? `${label}: ${s.text}` : s.text, start_ms: s.start_ms, end_ms: s.end_ms })
    }
  }
  return out
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

  // Guests come from the feed manifest written by fetchPodcastFeed.
  let guestsByKey = new Map<string, string[]>()
  try {
    const man = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      episodes: { key: string; guests?: string[] }[]
    }
    guestsByKey = new Map(man.episodes.map(e => [e.key, e.guests ?? []]))
  } catch {
    process.stdout.write('warning: no manifest.json — speakers will be numbered, not named\n')
  }

  const keys = files.map(f => f.replace(/\.(nova-3-medical|nova-3)?\.?deepgram\.json$/, ''))
  type SourceRow = { id: string; external_id: string | null; processing_status: string | null; title: string | null }
  const { data: rows, error } = await db
    .from('sources')
    .select('id, external_id, processing_status, title')
    .in('external_id', keys)
  if (error) throw new Error(`source lookup failed: ${error.message}`)
  const byKey = new Map(((rows ?? []) as unknown as SourceRow[]).map(r => [r.external_id as string, r]))

  let attached = 0
  let skippedDone = 0
  let unmatched = 0
  let named = 0

  for (const [i, file] of files.entries()) {
    if (attached >= limit) break
    const key = keys[i]
    const row = byKey.get(key)
    if (!row) { unmatched++; continue }
    // Leave already-extracted sources alone. Replacing their transcript would
    // orphan the claims already built from the old one — that is the separate
    // "redo the 107" job, with its own reconciliation.
    if (row.processing_status === 'succeeded') { skippedDone++; continue }

    const dg = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as DgFile
    if (!dg.segments?.length) { process.stdout.write(`  ${key}: no segments, skipped\n`); continue }

    const names = nameSpeakers(dg.segments, guestsByKey.get(key) ?? [])
    const hasRealName = [...names.values()].some(n => n !== HOST && !n.startsWith('Speaker '))

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
      `no matching source ${unmatched}\n` +
      `${named} of ${attached} have a named guest; the rest are solo or numbered\n`
  )
  if (!dryRun && attached > 0) process.stdout.write('these sources are now pending — the extraction worker will pick them up\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
