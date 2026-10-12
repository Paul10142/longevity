/**
 * How often would a look-ahead verdict be stale? Read-only estimate from real sources.
 *
 *   npx tsx --env-file=.env.local scripts/estimateStaleRate.ts [--sources 12] [--window 4]
 *
 * With the judge running W facts ahead (lib/judgePipeline.ts), fact i is judged before the
 * facts i-W+1 … i-1 are written. Its verdict is wasted if one of those writes put a claim in
 * its neighbourhood (cosine >= the 0.70 gate to fact i) that the early search could not have
 * seen: a claim they SEEDED, or one they merged into (an enrich-merge may rewrite it).
 * This counts those cases from the stored memberships and vectors — an upper bound, because
 * a merge only changes a claim's text when the judge flags enrich.
 */
export {}
const args = process.argv.slice(2)
const num = (f: string, d: number) => { const i = args.indexOf(f); return i > -1 ? Number(args[i + 1]) : d }
type Vec = number[]
const toVec = (e: unknown): Vec | null => Array.isArray(e) ? (e as Vec) : typeof e === 'string' ? (JSON.parse(e) as Vec) : null
const dot = (a: Vec, b: Vec) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('no db')
  const W = num('--window', 4)
  const nSources = num('--sources', 12)
  const { data: srcs } = await db.from('sources').select('id, title').eq('transcript_origin', 'deepgram').eq('processing_status', 'succeeded').order('id').limit(200)
  const pick = (srcs ?? []).filter((_: unknown, i: number) => i % Math.max(1, Math.floor((srcs?.length ?? 1) / nSources)) === 0).slice(0, nSources) as { id: string; title: string }[]
  let facts = 0, staleSeed = 0, staleMerge = 0, stale = 0, withCands = 0
  for (const s of pick) {
    const { data: ins } = await db.from('raw_insights').select('id, embedding, created_at').eq('source_id', s.id).order('created_at', { ascending: true }).order('id')
    const rows = (ins ?? []) as { id: string; embedding: unknown }[]
    const ids = rows.map(r => r.id)
    const mem = new Map<string, { claim_id: string; matched_by: string }>()
    for (let i = 0; i < ids.length; i += 150) {
      const { data } = await db.from('claim_members').select('raw_insight_id, claim_id, matched_by').in('raw_insight_id', ids.slice(i, i + 150))
      for (const m of (data ?? []) as { raw_insight_id: string; claim_id: string; matched_by: string }[]) mem.set(m.raw_insight_id, m)
    }
    const claimIds = [...new Set([...mem.values()].map(m => m.claim_id))]
    const cv = new Map<string, Vec>()
    for (let i = 0; i < claimIds.length; i += 100) {
      const { data } = await db.from('claim_embeddings').select('claim_id, embedding').in('claim_id', claimIds.slice(i, i + 100))
      for (const c of (data ?? []) as { claim_id: string; embedding: unknown }[]) { const v = toVec(c.embedding); if (v) cv.set(c.claim_id, v) }
    }
    const vecs = rows.map(r => toVec(r.embedding))
    let sFacts = 0, sStale = 0
    for (let i = 0; i < rows.length; i++) {
      const v = vecs[i]; if (!v) continue
      facts++; sFacts++
      let seed = false, merge = false
      for (let j = Math.max(0, i - (W - 1)); j < i; j++) {
        const m = mem.get(rows[j].id); const c = m && cv.get(m.claim_id)
        if (!m || !c) continue
        if (dot(v, c) >= 0.7) { if (m.matched_by === 'seed') seed = true; else merge = true }
      }
      if (seed) staleSeed++
      if (merge) staleMerge++
      if (seed || merge) { stale++; sStale++ }
    }
    console.log(`${s.title.slice(0, 60).padEnd(60)} ${String(sFacts).padStart(4)} facts, ${String(sStale).padStart(3)} possibly stale (${(100 * sStale / Math.max(1, sFacts)).toFixed(0)}%)`)
  }
  void withCands
  console.log(`\nwindow ${W}: ${facts} facts, ${stale} possibly stale = ${(100 * stale / facts).toFixed(1)}%  (a neighbour seeded by a recent fact: ${staleSeed}; a neighbour merged into by a recent fact: ${staleMerge}; some facts both)`)
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
