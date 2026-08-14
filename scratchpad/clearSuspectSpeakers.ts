/** Null the speaker attributions written under the misleading participants prompt
 *  (sources whose authors list no real guest — the "solo episode" cohort). */
export {}
async function main() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  if (!supabaseAdmin) throw new Error('no db')
  const db = supabaseAdmin

  const sources = await selectAllPaged<{ id: string; authors: string[] | null }>(
    (from, to) => db.from('sources').select('id, authors').order('id', { ascending: true }).range(from, to),
    1000
  )
  const suspect = sources.filter(s => !(s.authors ?? []).some(a => a && !/peter\s+attia/i.test(a))).map(s => s.id)
  console.log(`suspect sources (no real guest in metadata): ${suspect.length}`)

  let cleared = 0
  for (let i = 0; i < suspect.length; i += 50) {
    const { data, error } = await db
      .from('raw_insights')
      .update({ speaker: null })
      .not('speaker', 'is', null)
      .in('source_id', suspect.slice(i, i + 50))
      .select('id')
    if (error) throw new Error(error.message)
    cleared += (data ?? []).length
  }
  console.log(`attributions cleared: ${cleared}`)
}
main().catch(e => { console.error(e); process.exit(1) })
