/**
 * Repair the timing of Deepgram-transcribed sources — no re-extraction.
 *
 *   npx tsx --env-file=.env.local scripts/repairDeepgramTiming.ts <dir-of-deepgram-json> [--apply] [--limit N]
 *
 * The first attach merged a speaker's consecutive utterances into one timed
 * segment (lib/deepgramSegments.ts has the story), so every chunk inside a long
 * turn — and every insight in it — carried the turn's start time. The text was
 * right; only the clock was coarse. This script rebuilds the fine segments from
 * the Deepgram files on disk, proves the joined text is byte-identical to the
 * stored transcript, then:
 *
 *   1. replaces `sources.timed_transcript` with the per-utterance segments,
 *   2. recomputes every chunk's start_ms / end_ms with the same alignment the
 *      extractor uses (lib/transcriptSegments.ts), and
 *   3. copies each chunk's new timing onto its raw_insights.
 *
 * A source whose text does not match (transcript edited since, different
 * speaker naming) is reported and left alone. Dry run by default; `--apply`
 * writes under the one-writer lock. Idempotent: re-running changes nothing.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx > -1 ? Number(args[limitIdx + 1]) : Infinity
const dir = args.find(a => !a.startsWith('--') && (limitIdx < 0 || a !== args[limitIdx + 1]))
const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

async function main() {
  if (!dir) throw new Error('usage: repairDeepgramTiming.ts <dir-of-deepgram-json> [--apply] [--limit N]')
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')
  const { nameSpeakers, buildLabelledSegments, transcriptText } = await import('../lib/deepgramSegments')
  const { computeChunkTimings } = await import('../lib/transcriptSegments')
  if (APPLY) {
    const { acquireWriterLock } = await import('../lib/writerLock')
    acquireWriterLock('repairDeepgramTiming')
  }

  const files = (await readdir(dir)).filter(f => f.endsWith('.deepgram.json')).sort()
  let guestsByKey = new Map<string, string[]>()
  try {
    const man = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { episodes: { key: string; guests?: string[] }[] }
    guestsByKey = new Map(man.episodes.map(e => [e.key, e.guests ?? []]))
  } catch {
    process.stdout.write('warning: no manifest.json — speaker naming may differ from the original attach\n')
  }
  const keys = files.map(f => f.replace(/\.(nova-3-medical|nova-3)?\.?deepgram\.json$/, ''))

  type Row = { id: string; external_id: string; title: string; transcript: string | null; processing_status: string; timed_transcript: unknown }
  const rows = await selectAllPaged<Row>((from, to) =>
    db.from('sources').select('id, external_id, title, transcript, processing_status, timed_transcript')
      .eq('transcript_origin', 'deepgram').in('external_id', keys).order('id').range(from, to)
  )
  const byKey = new Map(rows.map(r => [r.external_id, r]))

  const totals = { sources: 0, alreadyFine: 0, textMismatch: 0, repaired: 0, chunksRetimed: 0, insightsRetimed: 0, chunksUnplaced: 0 }
  let n = 0
  for (const [i, file] of files.entries()) {
    if (n >= LIMIT) break
    const key = keys[i]
    const row = byKey.get(key)
    if (!row || !row.transcript) continue
    totals.sources++
    n++
    const dg = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as { segments: { text: string; speaker: number | null; start_ms: number; end_ms: number }[] }
    const names = nameSpeakers(dg.segments, guestsByKey.get(key) ?? [])
    const fine = buildLabelledSegments(dg.segments, names)
    const oldCount = Array.isArray(row.timed_transcript) ? row.timed_transcript.length : 0

    if (transcriptText(fine) !== row.transcript) {
      totals.textMismatch++
      process.stdout.write(`  ${key}: TEXT MISMATCH (stored ${row.transcript.length} chars vs rebuilt ${transcriptText(fine).length}) — left alone\n`)
      continue
    }
    if (oldCount === fine.length) {
      totals.alreadyFine++
      continue
    }

    // Chunks and their current timing, to measure what changes.
    const chunks = await selectAllPaged<{ id: string; locator: string; content: string; start_ms: number | null; end_ms: number | null }>((from, to) =>
      db.from('chunks').select('id, locator, content, start_ms, end_ms').eq('source_id', row.id).order('locator').range(from, to)
    )
    const timings = computeChunkTimings(chunks.map(c => c.content), fine)
    let changed = 0, unplaced = 0, maxShiftMs = 0
    for (let c = 0; c < chunks.length; c++) {
      const t = timings[c]
      if (!t) { unplaced++; continue }
      if (chunks[c].start_ms !== t.start_ms || chunks[c].end_ms !== t.end_ms) {
        changed++
        if (chunks[c].start_ms != null) maxShiftMs = Math.max(maxShiftMs, Math.abs(t.start_ms - (chunks[c].start_ms as number)))
      }
    }
    process.stdout.write(
      `  ${key}: ${oldCount} → ${fine.length} segments; ${chunks.length} chunks, ${changed} re-timed, ${unplaced} unplaceable, largest shift ${fmt(maxShiftMs)}  ${row.title.slice(0, 50)}\n`
    )
    totals.chunksUnplaced += unplaced
    if (!APPLY) { totals.repaired++; totals.chunksRetimed += changed; continue }

    const { error: upErr } = await db.from('sources').update({ timed_transcript: fine }).eq('id', row.id)
    if (upErr) throw new Error(`${key}: timed_transcript update failed: ${upErr.message}`)
    let insightsRetimed = 0
    for (let c = 0; c < chunks.length; c++) {
      const t = timings[c]
      if (!t) continue
      if (chunks[c].start_ms === t.start_ms && chunks[c].end_ms === t.end_ms) continue
      const { error: chErr } = await db.from('chunks').update({ start_ms: t.start_ms, end_ms: t.end_ms }).eq('id', chunks[c].id)
      if (chErr) throw new Error(`${key}: chunk ${chunks[c].locator} update failed: ${chErr.message}`)
      const { data: upd, error: riErr } = await db.from('raw_insights').update({ start_ms: t.start_ms, end_ms: t.end_ms }).eq('chunk_id', chunks[c].id).select('id')
      if (riErr) throw new Error(`${key}: insights of ${chunks[c].locator} update failed: ${riErr.message}`)
      insightsRetimed += (upd ?? []).length
    }
    totals.repaired++
    totals.chunksRetimed += changed
    totals.insightsRetimed += insightsRetimed
  }

  process.stdout.write(
    `\n${APPLY ? 'REPAIRED' : 'DRY RUN'} — sources ${totals.sources}: ${totals.repaired} ${APPLY ? 'repaired' : 'to repair'}, ` +
      `${totals.alreadyFine} already fine, ${totals.textMismatch} text mismatch (left alone); chunks re-timed ${totals.chunksRetimed}` +
      (APPLY ? `, insights re-timed ${totals.insightsRetimed}` : '') + `, chunks unplaceable ${totals.chunksUnplaced}\n`
  )
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
