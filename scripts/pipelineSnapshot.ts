/** One-line pipeline snapshot for monitoring: "<raw_insights> <active_claims> <open_jobs>".
 *  DB-only, cheap (head counts). Used by the overnight health Monitor. */
import { supabaseAdmin } from '../lib/supabaseServer'
async function main() {
  if (!supabaseAdmin) throw new Error('no db')
  const [i, c, j] = await Promise.all([
    supabaseAdmin.from('raw_insights').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('claims').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseAdmin.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['queued', 'running']),
  ])
  console.log(`${i.count ?? 0} ${c.count ?? 0} ${j.count ?? 0}`)
}
main().catch(() => { console.log('ERR ERR ERR') })
