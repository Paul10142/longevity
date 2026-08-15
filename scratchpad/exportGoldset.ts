/** Write eval/extraction-goldset.json from Paul's DB labels (fidelity_labels). */
export {}
import { readFileSync, writeFileSync } from 'node:fs'
async function main() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('no db')
  const pairs = JSON.parse(readFileSync('eval/extraction-eval-pairs.json', 'utf8')) as { id: string }[]
  type Row = { pair_id: string; label: string; labeled_by: string; rationale: string | null }
  const { data } = await supabaseAdmin.from('fidelity_labels').select('pair_id, label, labeled_by, rationale')
  const byId = new Map(((data ?? []) as Row[]).map(l => [l.pair_id, l]))
  const goldset = pairs.map(p => {
    const l = byId.get(p.id)
    return {
      id: p.id,
      label: l?.label ?? 'FAITHFUL',
      confirmed: l?.labeled_by === 'paul',
      labeled_by: l ? l.labeled_by : 'unlabeled',
      rationale: l?.rationale ?? '',
    }
  })
  writeFileSync('eval/extraction-goldset.json', JSON.stringify(goldset, null, 2))
  console.log(`wrote ${goldset.length} labels, ${goldset.filter(g => g.confirmed).length} confirmed by paul`)
}
main().catch(e => { console.error(e); process.exit(1) })
