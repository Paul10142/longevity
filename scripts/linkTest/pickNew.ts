// READ-ONLY: list the episodes that already have saved citation mentions, so a fresh set can be picked.
//   npx tsx --env-file=.env.local scripts/linkTest/pickNew.ts <ids-already-used.txt> <out.json>
// Writes nothing to the database. Output: one row per candidate episode with its mention counts by status.
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const [usedFile, outFile] = process.argv.slice(2)
if (!usedFile || !outFile) { console.error('usage: pickNew.ts <ids-already-used.txt> <out.json>'); process.exit(2) }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })

async function main() {
  const used = new Set(readFileSync(usedFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean).map(s => s.slice(0, 8)))
  const bySource = new Map<string, { total: number; resolved: number; not_found: number; pending: number }>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('reference_mentions').select('source_id, resolution_status').range(from, from + 999)
    if (error) throw error
    if (!data?.length) break
    for (const r of data as { source_id: string; resolution_status: string }[]) {
      const c = bySource.get(r.source_id) ?? { total: 0, resolved: 0, not_found: 0, pending: 0 }
      c.total++
      if (r.resolution_status === 'resolved') c.resolved++
      else if (r.resolution_status === 'not_found') c.not_found++
      else c.pending++
      bySource.set(r.source_id, c)
    }
    if (data.length < 1000) break
  }
  const rows: Record<string, unknown>[] = []
  for (const [id, c] of bySource) {
    if (used.has(id.slice(0, 8))) continue
    const { data: s } = await db.from('sources').select('title, authors, date').eq('id', id).maybeSingle()
    const { count: rawCount } = await db.from('raw_insights').select('id', { count: 'exact', head: true }).eq('source_id', id)
    rows.push({ id, title: (s as { title?: string } | null)?.title ?? null, authors: (s as { authors?: string[] } | null)?.authors ?? null, date: (s as { date?: string } | null)?.date ?? null, rawInsights: rawCount ?? 0, ...c })
  }
  writeFileSync(outFile, JSON.stringify(rows, null, 1))
  console.log(`${bySource.size} sources have mentions; ${used.size} already used; ${rows.length} candidates`)
  for (const r of rows.sort((a, b) => (b.total as number) - (a.total as number))) {
    console.log(`${(r.id as string).slice(0, 8)} m=${String(r.total).padStart(3)} res=${String(r.resolved).padStart(2)} nf=${String(r.not_found).padStart(2)} pend=${String(r.pending).padStart(2)} raw=${String(r.rawInsights).padStart(4)} ${String((r.authors as string[] | null)?.join(', ') ?? '').slice(0, 28).padEnd(28)} ${String(r.title).slice(0, 60)}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
