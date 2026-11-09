// Read-only: dump every test mention with its outcome, trace and linked claims.
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })
async function main() {
  const ids = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
  const traces: any[] = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const tmap = new Map(traces.map(t => [t.mention_id, t]))
  const out: any = { sources: [], mentions: [] }
  for (const id of ids) {
    const { data: s } = await db.from('sources').select('title,authors,date').eq('id', id).single()
    const { data: ms } = await db.from('reference_mentions').select('*').eq('source_id', id).order('locator')
    // claims of this source
    const rawIds: string[] = []
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('raw_insights').select('id,chunk_id').eq('source_id', id).range(from, from + 999)
      if (!data?.length) break
      rawIds.push(...data.map((r: any) => r.id)); if (data.length < 1000) break
    }
    const claimSet = new Set<string>()
    for (let i = 0; i < rawIds.length; i += 200) {
      const { data } = await db.from('claim_members').select('claim_id').in('raw_insight_id', rawIds.slice(i, i + 200))
      for (const r of data ?? []) claimSet.add(r.claim_id)
    }
    const claimIds = [...claimSet]
    const linked = new Set<string>()
    const links: any[] = []
    for (let i = 0; i < claimIds.length; i += 200) {
      const { data } = await db.from('claim_references').select('claim_id,reference_id').in('claim_id', claimIds.slice(i, i + 200))
      for (const r of data ?? []) { linked.add(r.claim_id); links.push(r) }
    }
    out.sources.push({ id, title: s!.title, authors: s!.authors, chunks: null, mentions: ms!.length, resolved: ms!.filter((m: any) => m.resolution_status === 'resolved').length, claims: claimIds.length, claims_linked: linked.size })
    for (const m of ms!) {
      let ref: any = null
      if (m.reference_id) { const { data } = await db.from('references_').select('title,authors,year,journal,doi,resolved_source').eq('id', m.reference_id).single(); ref = data }
      // claims in the same chunk
      let chunkClaims: string[] = []
      if (m.reference_id && m.chunk_id) {
        const { data: raws } = await db.from('raw_insights').select('id').eq('chunk_id', m.chunk_id)
        const { data: mem } = await db.from('claim_members').select('claim_id').in('raw_insight_id', (raws ?? []).map((r: any) => r.id))
        const cids = [...new Set((mem ?? []).map((x: any) => x.claim_id))]
        const { data: cl } = await db.from('claims').select('canonical_statement').in('id', cids)
        chunkClaims = (cl ?? []).map((c: any) => c.canonical_statement)
      }
      const t = tmap.get(m.id)
      out.mentions.push({ id: m.id, src: id.slice(0, 8), locator: m.locator, raw: m.raw_text, parsed: m.parsed, status: m.resolution_status, conf: m.match_confidence, ref, chunkClaims,
        trace: t ? { attempted: t.attempted, judge: t.judge, cands: t.candidates.map((c: any) => `${c.title} | ${(c.authors ?? []).slice(0, 2).join(', ')} | ${c.journal} | ${c.year} | ${c.doi}`) } : null })
    }
  }
  writeFileSync(process.argv[4], JSON.stringify(out, null, 1))
  console.log(out.sources.map((s: any) => `${s.id.slice(0, 8)} m=${s.mentions} r=${s.resolved} claims=${s.claims} linked=${s.claims_linked} ${s.title.slice(0, 40)}`).join('\n'))
}
main()
