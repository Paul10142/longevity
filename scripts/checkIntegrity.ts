/**
 * Read-only corpus integrity check. Never writes.
 *
 *   npx tsx --env-file=.env.local scripts/checkIntegrity.ts [--show 20]
 *
 * Lists the failure signatures an interrupted caption replacement leaves
 * (lib/integrity.ts): active claims with no members, members pointing at a
 * missing fact, retired claims that still hold a vector or members, facts whose
 * source row is gone. Expected: 0 of each. Exit code 1 when any is non-zero.
 *
 * Run it while a replace/retire is mid-flight and a non-zero count can be
 * transient (e.g. between "unhook" and "retire"); re-run a minute later, or with
 * the loop stopped, before treating it as damage.
 */
export {} // module marker

import { INTEGRITY_LABELS, checkIntegrity, integrityCounts, type IntegrityReport } from '../lib/integrity'

const args = process.argv.slice(2)
const showIdx = args.indexOf('--show')
const SHOW = showIdx > -1 ? Number(args[showIdx + 1]) || 20 : 10

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')

  const ids = async (table: string, col: string, filter?: (q: any) => any) =>
    (await selectAllPaged<Record<string, string>>((from, to) => {
      const q = db.from(table).select(col)
      return (filter ? filter(q) : q).order(col).range(from, to)
    })).map(r => r[col])

  const t0 = Date.now()
  const activeClaimIds = await ids('claims', 'id', q => q.eq('status', 'active'))
  const retiredClaimIds = await ids('claims', 'id', q => q.eq('status', 'retired'))
  const members = await selectAllPaged<{ claim_id: string; raw_insight_id: string }>((from, to) =>
    db.from('claim_members').select('claim_id, raw_insight_id').order('raw_insight_id').range(from, to))
  const insights = await selectAllPaged<{ id: string; source_id: string }>((from, to) =>
    db.from('raw_insights').select('id, source_id').order('id').range(from, to))
  const sourceIds = await ids('sources', 'id')
  const vectorClaimIds = await ids('claim_embeddings', 'claim_id')

  const report = checkIntegrity({ activeClaimIds, retiredClaimIds, members, insights, sourceIds, vectorClaimIds })
  const counts = integrityCounts(report)
  console.log(
    `integrity check (read-only, ${Math.round((Date.now() - t0) / 1000)}s): ` +
      `${activeClaimIds.length} active / ${retiredClaimIds.length} retired claims, ${members.length} links, ${insights.length} facts, ${sourceIds.length} sources, ${vectorClaimIds.length} vectors\n`
  )
  let bad = 0
  for (const k of Object.keys(INTEGRITY_LABELS) as (keyof IntegrityReport)[]) {
    bad += counts[k]
    console.log(`${String(counts[k]).padStart(6)}  ${INTEGRITY_LABELS[k]}`)
    if (counts[k]) {
      for (const x of report[k].slice(0, SHOW)) console.log(`          ${typeof x === 'string' ? x : JSON.stringify(x)}`)
      if (counts[k] > SHOW) console.log(`          … and ${counts[k] - SHOW} more (--show N)`)
    }
  }
  console.log(bad === 0 ? '\nOK — all zero.' : `\n${bad} problem row(s) — see above.`)
  process.exit(bad === 0 ? 0 : 1)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(2) })
