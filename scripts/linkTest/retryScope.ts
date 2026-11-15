// READ-ONLY count: how much would a retry of the library's old "not found" citations touch?
//   npx tsx --env-file=.env.local scripts/linkTest/retryScope.ts
// Writes nothing. It only counts reference_mentions by status and by episode, and how many already-found
// citations have no claim linked (links the old chunk rule never made, or lost when claims were rebuilt).
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })
type M = { id: string; source_id: string; chunk_id: string | null; resolution_status: string; reference_id: string | null; parsed: { type?: string | null } | null }

async function main() {
  const ms: M[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('reference_mentions').select('id, source_id, chunk_id, resolution_status, reference_id, parsed').range(from, from + 999)
    if (error) throw error
    if (!data?.length) break
    ms.push(...(data as unknown as M[]))
    if (data.length < 1000) break
  }
  const by = (f: (m: M) => boolean) => ({ mentions: ms.filter(f).length, sources: new Set(ms.filter(f).map(m => m.source_id)).size })
  console.log('ALL mentions', JSON.stringify(by(() => true)))
  for (const st of ['pending', 'resolved', 'not_found']) console.log(st, JSON.stringify(by(m => m.resolution_status === st)))
  const nf = ms.filter(m => m.resolution_status === 'not_found')
  const types: Record<string, number> = {}
  for (const m of nf) types[m.parsed?.type ?? 'unknown'] = (types[m.parsed?.type ?? 'unknown'] ?? 0) + 1
  console.log('not_found by type', JSON.stringify(types))
  console.log('not_found per source', JSON.stringify(Object.fromEntries([...new Set(nf.map(m => m.source_id))].map(s => [s.slice(0, 8), nf.filter(m => m.source_id === s).length]))))

  // Already-found citations: does any claim of the citation's chunk carry the link?
  let resolvedNoLink = 0
  let resolvedLinked = 0
  for (const m of ms.filter(x => x.resolution_status === 'resolved' && x.reference_id)) {
    let linked = false
    if (m.chunk_id) {
      const { data: raws } = await db.from('raw_insights').select('id').eq('chunk_id', m.chunk_id)
      const rawIds = (raws ?? []).map((r: { id: string }) => r.id)
      if (rawIds.length) {
        const { data: mem } = await db.from('claim_members').select('claim_id').in('raw_insight_id', rawIds)
        const cids = [...new Set((mem ?? []).map((x: { claim_id: string }) => x.claim_id))]
        if (cids.length) {
          const { count } = await db.from('claim_references').select('claim_id', { count: 'exact', head: true }).eq('reference_id', m.reference_id!).in('claim_id', cids)
          linked = (count ?? 0) > 0
        }
      }
    }
    if (linked) resolvedLinked++; else resolvedNoLink++
  }
  console.log('resolved citations with a claim linked in their chunk:', resolvedLinked, '| with none:', resolvedNoLink)
}
main().catch(e => { console.error(e); process.exit(1) })
