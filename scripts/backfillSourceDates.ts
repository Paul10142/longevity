/**
 * Backfill sources.date from the ingest plan (CSV air-dates), for any ingested
 * source whose date is still NULL. Idempotent, only fills NULLs. Reusable after
 * every ingest batch — the transcript API sometimes returns a null date.
 *
 *   npx tsx --env-file=.env.local scripts/backfillSourceDates.ts [--dry-run]
 */
import { readFileSync } from 'node:fs'

async function main() {
  const dry = process.argv.includes('--dry-run')
  const plan = JSON.parse(readFileSync('scratchpad/ingest-plan.json', 'utf8')) as {
    toIngest: { videoId: string; date: string | null; title: string }[]
  }
  const dateByVideo = new Map(plan.toIngest.filter(t => t.date).map(t => [t.videoId, t.date as string]))

  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured')

  const { data } = await supabaseAdmin
    .from('sources').select('id, external_id, title, date').is('date', null)
  const rows = (data ?? []) as { id: string; external_id: string | null; title: string; date: string | null }[]

  let updated = 0, noDate = 0
  for (const s of rows) {
    const d = s.external_id ? dateByVideo.get(s.external_id) : undefined
    if (!d) { noDate++; continue }
    if (dry) { console.log(`  would set ${d}  ${s.title.slice(0, 55)}`); updated++; continue }
    const { error } = await supabaseAdmin.from('sources').update({ date: d }).eq('id', s.id)
    if (error) throw new Error(`update ${s.id}: ${error.message}`)
    updated++
  }
  console.log(`${dry ? '[dry-run] ' : ''}backfilled ${updated} source date(s); ${noDate} null-date source(s) had no plan date.`)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
