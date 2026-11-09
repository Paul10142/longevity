/**
 * Mark the Drive items that are not full episodes as skipped, with a written
 * reason: the same mark the duplicates carry (processing_status = 'skipped',
 * skip_reason; migration 038). The admin review screens then hide them in their
 * collapsed "Skipped and Non-Full" list (lib/skippedItems.ts).
 *
 *   npx tsx --env-file=.env.local scripts/markNonFullSkipped.ts           # dry run (the default): read-only
 *   npx tsx --env-file=.env.local scripts/markNonFullSkipped.ts --apply   # write
 *
 * The four items: the Ayrton Senna re-release, the Olivia Attia anniversary episode,
 * the Dax Shepard special and "Introducing Early" (lib/nonFullSkip.ts).
 *
 * WHAT --apply WRITES: processing_status and skip_reason on those rows, nothing else.
 * Facts already extracted from them (raw_insights, claims, claim_members) are not
 * touched. A title that matches zero rows or more than one row refuses the whole run.
 * A row already skipped is left as it is; a row being processed right now is left alone.
 * Not for the pasted-text copies: they are marked skipped elsewhere.
 */
import { NON_FULL_TARGETS, planNonFullSkips, refusalReasons, rowsToWrite, type SourceRowLite } from '../lib/nonFullSkip'

const APPLY = process.argv.slice(2).includes('--apply')
const clip = (s: string | null, n: number) => ((s ?? '').length > n ? `${(s ?? '').slice(0, n - 1)}…` : s ?? '')

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')

  const read = (cols: string) =>
    selectAllPaged<SourceRowLite>((from, to) => db.from('sources').select(cols).order('id', { ascending: true }).range(from, to))
  let columnsReady = true
  let rows: SourceRowLite[]
  try {
    rows = await read('id, title, processing_status, skip_reason')
  } catch (err) {
    if (!/skip_reason|column/i.test(String(err))) throw err
    columnsReady = false
    rows = await read('id, title, processing_status')
  }

  const plan = planNonFullSkips(NON_FULL_TARGETS, rows)
  console.log(APPLY ? 'APPLY MODE' : 'DRY RUN (nothing is written; pass --apply to write)')
  if (!columnsReady) console.log('NOTE: migration 038 is not applied (no skip_reason column); --apply will refuse.')
  console.log('')
  for (const p of plan) {
    console.log(`${p.verdict.toUpperCase().padEnd(17)} ${p.target.label}`)
    for (const m of p.matches) {
      console.log(`    id ${m.id}  status ${m.processing_status ?? '-'}  "${clip(m.title, 90)}"`)
      if (m.skip_reason) console.log(`    current reason: ${m.skip_reason}`)
    }
    if (p.verdict === 'change') console.log(`    would set: processing_status = 'skipped', skip_reason = "${p.target.reason}"`)
  }

  const refusals = refusalReasons(plan)
  const writes = rowsToWrite(plan)
  console.log(`\n${writes.length} row(s) would change; ${plan.filter(p => p.verdict === 'already-skipped').length} already skipped; ${plan.filter(p => p.verdict === 'busy').length} busy (left alone).`)
  if (refusals.length) {
    console.log(`REFUSED: ${refusals.join('; ')}.`)
    process.exitCode = 1
    return
  }
  if (!APPLY) return
  if (!columnsReady) throw new Error('refusing to apply: migration 038 is not applied')

  let written = 0
  for (const w of writes) {
    const { data, error } = await db
      .from('sources')
      .update({ processing_status: 'skipped', skip_reason: w.skip_reason })
      .eq('id', w.id)
      .neq('processing_status', 'processing')
      .select('id')
    if (error) throw new Error(`update ${w.id} failed: ${error.message}`)
    if ((data ?? []).length > 0) written++
  }
  console.log(`DONE: ${written} row(s) marked skipped. Claims and facts untouched.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
