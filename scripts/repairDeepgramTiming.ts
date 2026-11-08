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
 *
 * SPEAKER LABELS ARE REBUILT, NEVER CHANGED. The attach takes guest names from the
 * source row's `authors` (else the manifest), and `refreshGuests --apply` can change
 * `authors` AFTER an episode was attached, so today's guests need not be the ones
 * the stored transcript was labelled with. This repair must reproduce the stored
 * text, not relabel it, so it tries each candidate guest list in the attach's order
 * (database `authors`, then the manifest, then no guest at all) and keeps the first
 * whose rebuilt text is byte-identical to the stored transcript. If none matches the
 * source is reported as TEXT MISMATCH and left alone, exactly as before.
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
  const { nameSpeakers, buildLabelledSegments, transcriptText, speakerGuestCandidates, manifestGuestsByKey, rebuildToStored } = await import('../lib/deepgramSegments')
  const { computeChunkTimings } = await import('../lib/transcriptSegments')
  const { showByExternalId } = await import('../lib/shows')
  if (APPLY) {
    const { acquireWriterLock } = await import('../lib/writerLock')
    acquireWriterLock('repairDeepgramTiming')
  }

  const files = (await readdir(dir)).filter(f => f.endsWith('.deepgram.json')).sort()
  let manifestGuests = new Map<string, string[]>()
  try {
    manifestGuests = manifestGuestsByKey(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')))
  } catch {
    process.stdout.write('warning: no readable manifest.json — guest names come from the database only\n')
  }
  const keys = files.map(f => f.replace(/\.(nova-3-medical|nova-3)?\.?deepgram\.json$/, ''))

  type Row = { id: string; external_id: string; title: string; transcript: string | null; processing_status: string; timed_transcript: unknown; authors: string[] | null }
  const rows = await selectAllPaged<Row>((from, to) =>
    db.from('sources').select('id, external_id, title, transcript, processing_status, timed_transcript, authors')
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
    // Same host the attach used (lib/shows.ts, by the key's prefix); without it
    // the rebuilt text could not match the stored transcript.
    const show = showByExternalId(key)
    if (!show) {
      process.stdout.write(`  ${key}: no show is registered for this key's prefix — left alone\n`)
      continue
    }
    const host = show.hostLabel
    // The attach's candidate guest lists, then "no guest": keep the first that
    // rebuilds the stored text exactly (see the header and rebuildToStored).
    const candidates = speakerGuestCandidates(show, row.authors, manifestGuests.get(key))
    const rebuilt = rebuildToStored(dg.segments, host, candidates, row.transcript)
    const oldCount = Array.isArray(row.timed_transcript) ? row.timed_transcript.length : 0

    if (!rebuilt) {
      totals.textMismatch++
      const first = buildLabelledSegments(dg.segments, nameSpeakers(dg.segments, candidates[0]?.guests ?? [], host))
      process.stdout.write(`  ${key}: TEXT MISMATCH (stored ${row.transcript.length} chars vs rebuilt ${transcriptText(first).length}) — left alone\n`)
      continue
    }
    const fine = rebuilt.segments
    if (candidates.length > 0 && rebuilt.source !== candidates[0].source) {
      // Not an error: the stored labels were made from an older guest list than the
      // one `authors` holds now. The repair keeps the stored labels.
      process.stdout.write(`  ${key}: stored labels match the ${rebuilt.source === 'none' ? 'no-guest' : rebuilt.source} guest list, not the current ${candidates[0].source} one — kept as stored\n`)
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
