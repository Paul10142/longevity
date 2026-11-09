import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })
async function main() {
  const ids = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
  for (const id of ids) {
    const { data } = await db.from('reference_mentions').select('chunk_id,resolution_status').eq('source_id', id)
    const { count: ch } = await db.from('chunks').select('*', { count: 'exact', head: true }).eq('source_id', id)
    const st: Record<string, number> = {}; for (const r of data ?? []) st[r.resolution_status] = (st[r.resolution_status] ?? 0) + 1
    console.log(id.slice(0, 8), 'chunks', ch, 'mentions', data?.length, JSON.stringify(st), 'distinctChunks', new Set((data ?? []).map(r => r.chunk_id)).size)
  }
}
main()
