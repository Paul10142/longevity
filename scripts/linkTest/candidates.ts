import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })
const out = process.argv[2]
const SPECIFIC = /\bet al\b|published in|\b(NEJM|Lancet|JAMA|BMJ|Nature|Science|Cell)\b|journal of|\b(19|20)\d\d (study|trial|paper|meta-analysis|review)|(study|trial|paper) (from|in) (19|20)\d\d|\bPMID\b|doi/gi
const VAGUE = /\b(a|one|the|some|recent|new) (study|studies|paper|trial|meta-analysis|meta analysis|research)\b/gi
async function main() {
  const { data: srcs } = await db.from('sources').select('id,title,authors,date,type').eq('processing_status', 'succeeded').limit(2000)
  const { data: m } = await db.from('reference_mentions').select('source_id')
  const has = new Set((m ?? []).map(r => r.source_id))
  const rows: any[] = []
  const todo = srcs!.filter(s => !has.has(s.id) && s.type !== 'article')
  let i = 0
  async function worker() {
    while (i < todo.length) {
      const s = todo[i++]
      const { count: ri } = await db.from('raw_insights').select('*', { count: 'exact', head: true }).eq('source_id', s.id)
      let spec = 0, vague = 0, chars = 0, n = 0, from = 0
      for (;;) {
        const { data } = await db.from('chunks').select('content').eq('source_id', s.id).range(from, from + 499)
        if (!data || !data.length) break
        for (const c of data) { n++; chars += c.content.length; spec += (c.content.match(SPECIFIC) ?? []).length; vague += (c.content.match(VAGUE) ?? []).length }
        if (data.length < 500) break
        from += 500
      }
      rows.push({ id: s.id, title: s.title, authors: s.authors, date: s.date, type: s.type, raw_insights: ri, chunks: n, chars, spec, vague })
    }
  }
  await Promise.all([1, 2, 3, 4, 5].map(worker))
  writeFileSync(out, JSON.stringify(rows))
  console.log('done', rows.length)
}
main()
