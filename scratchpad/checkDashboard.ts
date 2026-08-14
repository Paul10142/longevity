/**
 * Runtime check for the /admin dashboard's data layer.
 *
 * The page is behind the admin password gate, so it cannot be loaded headlessly.
 * This exercises the exact same queries (head:true counts + the database_size_bytes
 * RPC) against the live DB to prove the shapes are right before shipping.
 *
 *   npx tsx --env-file=.env.local scratchpad/checkDashboard.ts
 */
export {}

async function main() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  const c = async (label: string, q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count, error } = await q
    console.log(`${label.padEnd(28)} ${error ? `ERROR ${JSON.stringify(error)}` : count}`)
  }

  await c('merge_reviews pending', db.from('merge_reviews').select('id', { count: 'exact', head: true }).eq('status', 'pending'))
  await c('topic_proposals pending', db.from('topic_proposals').select('id', { count: 'exact', head: true }).eq('status', 'pending'))
  await c('claim_flags open', db.from('claim_flags').select('id', { count: 'exact', head: true }).is('resolved_at', null))
  await c('topics unreviewed', db.from('topics').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('reviewed_by_human', false))
  await c('sources pending', db.from('sources').select('id', { count: 'exact', head: true }).eq('processing_status', 'pending'))
  await c('claims untagged', db.from('claims').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('needs_tagging', true))
  await c('claims active', db.from('claims').select('id', { count: 'exact', head: true }).eq('status', 'active'))
  await c('jobs open', db.from('jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']))

  const { data, error } = await db.rpc('database_size_bytes')
  console.log(`${'database_size_bytes'.padEnd(28)} ${error ? `ERROR ${JSON.stringify(error)}` : `${(Number(data) / 1024 / 1024).toFixed(1)} MB (raw type: ${typeof data})`}`)
}

main().catch(e => { console.error(e); process.exit(1) })
