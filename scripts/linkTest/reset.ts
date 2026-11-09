// Deletes the (unresolved) mentions of ONE test source so an interrupted extract can be redone cleanly.
import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })
async function main() {
  const id = process.argv[2]
  const { error, count } = await db.from('reference_mentions').delete({ count: 'exact' }).eq('source_id', id).eq('resolution_status', 'pending')
  console.log('deleted', count, error?.message ?? '')
}
main()
