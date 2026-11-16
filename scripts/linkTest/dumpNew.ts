// READ-ONLY: dump the saved citation mentions of some episodes, with what production did with them and the
// statements of each citation's chunk, for the file-only re-run (rerun.ts) and the claim-wording check (claimLinks.ts).
//   npx tsx --env-file=.env.local scripts/linkTest/dumpNew.ts <ids.txt (8-char prefixes)> <out.json>
// Writes nothing to the database.
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { chunksHoldingQuote } from '../../lib/claimLinking'

const [idsFile, outFile] = process.argv.slice(2)
if (!idsFile || !outFile) { console.error('usage: dumpNew.ts <ids.txt> <out.json>'); process.exit(2) }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })

type Insight = { id: string; statement: string; quote: string | null; claimIds: string[] }

async function pagedIds(table: string, col: string, val: string, select: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).eq(col, val).range(from, from + 999)
    if (error) throw error
    if (!data?.length) break
    out.push(...(data as unknown as Record<string, unknown>[]))
    if (data.length < 1000) break
  }
  return out
}

async function main() {
  const prefixes = readFileSync(idsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  const out: { sources: unknown[]; mentions: unknown[] } = { sources: [], mentions: [] }
  const chunkMemo = new Map<string, Insight[]>()

  async function insightsOf(chunkId: string): Promise<Insight[]> {
    const hit = chunkMemo.get(chunkId)
    if (hit) return hit
    const raws = (await pagedIds('raw_insights', 'chunk_id', chunkId, 'id, statement, direct_quote')) as { id: string; statement: string; direct_quote: string | null }[]
    const claimsOf = new Map<string, string[]>()
    if (raws.length) {
      const { data } = await db.from('claim_members').select('raw_insight_id, claim_id').in('raw_insight_id', raws.map(r => r.id))
      for (const m of (data ?? []) as { raw_insight_id: string; claim_id: string }[]) claimsOf.set(m.raw_insight_id, [...(claimsOf.get(m.raw_insight_id) ?? []), m.claim_id])
    }
    const res = raws.filter(r => claimsOf.has(r.id)).map(r => ({ id: r.id, statement: r.statement, quote: r.direct_quote, claimIds: claimsOf.get(r.id)! }))
    chunkMemo.set(chunkId, res)
    return res
  }

  for (const prefix of prefixes) {
    const { data: all } = await db.from('sources').select('id, title, authors, date').limit(5000)
    const s = ((all ?? []) as { id: string; title: string; authors: string[] | null; date: string | null }[]).find(x => x.id.startsWith(prefix))
    if (!s) throw new Error(`no source starts with ${prefix}`)
    const mentions = (await pagedIds('reference_mentions', 'source_id', s.id, '*')) as {
      id: string; chunk_id: string | null; locator: string; raw_text: string; parsed: unknown; resolution_status: string; match_confidence: number | null; reference_id: string | null
    }[]
    mentions.sort((a, b) => a.locator.localeCompare(b.locator))
    const rawIds = (await pagedIds('raw_insights', 'source_id', s.id, 'id')).map(r => r.id as string)
    const claimSet = new Set<string>()
    for (let i = 0; i < rawIds.length; i += 200) {
      const { data } = await db.from('claim_members').select('claim_id').in('raw_insight_id', rawIds.slice(i, i + 200))
      for (const r of (data ?? []) as { claim_id: string }[]) claimSet.add(r.claim_id)
    }
    const claimIds = [...claimSet]
    const linked = new Set<string>()
    for (let i = 0; i < claimIds.length; i += 200) {
      const { data } = await db.from('claim_references').select('claim_id').in('claim_id', claimIds.slice(i, i + 200))
      for (const r of (data ?? []) as { claim_id: string }[]) linked.add(r.claim_id)
    }
    out.sources.push({ id: s.id, title: s.title, authors: s.authors, date: s.date, mentions: mentions.length, resolved: mentions.filter(m => m.resolution_status === 'resolved').length, claims: claimIds.length, claims_linked: linked.size })
    // A citation whose chunk link was cleared (the chunks were rebuilt) is found again by the words the speaker said, as in production.
    const chunks = (await pagedIds('chunks', 'source_id', s.id, 'id, content')) as { id: string; content: string }[]
    for (const m of mentions) {
      let ref: unknown = null
      const chunkId = m.chunk_id
      let how: 'saved' | 'quote' | null = m.chunk_id ? 'saved' : null
      const found = chunkId ? [chunkId] : chunksHoldingQuote(chunks, m.raw_text)
      if (!chunkId && found.length) how = 'quote'
      let oldLinkedClaimIds: string[] = []
      const insights = (await Promise.all(found.map(insightsOf))).flat().filter((x, k, all) => all.findIndex(y => y.id === x.id) === k)
      if (m.reference_id) {
        const { data } = await db.from('references_').select('title, authors, year, journal, doi, resolved_source').eq('id', m.reference_id).single()
        ref = data
        const cids = [...new Set(insights.flatMap(i => i.claimIds))]
        if (cids.length) {
          const { data: cr } = await db.from('claim_references').select('claim_id').eq('reference_id', m.reference_id).in('claim_id', cids)
          oldLinkedClaimIds = ((cr ?? []) as { claim_id: string }[]).map(r => r.claim_id)
        }
      }
      out.mentions.push({
        id: m.id, src: s.id.slice(0, 8), locator: m.locator, raw: m.raw_text, parsed: m.parsed, status: m.resolution_status, conf: m.match_confidence,
        ref, chunkId: m.chunk_id, chunkFoundBy: how, insights, oldLinkedClaimIds,
      })
    }
    console.log(`${s.id.slice(0, 8)} mentions=${mentions.length} resolved=${mentions.filter(m => m.resolution_status === 'resolved').length} claims=${claimIds.length} linked=${linked.size} ${s.title.slice(0, 50)}`)
  }
  writeFileSync(outFile, JSON.stringify(out, null, 1))
  console.log(`wrote ${(out.mentions as unknown[]).length} mentions`)
}
main().catch(e => { console.error(e); process.exit(1) })
