/**
 * Repair topic filings stranded on merged-away claims.
 *
 * Until the 2026-08-14 fix, `mergeClaims` moved a merged claim's members but
 * NOT its `claim_topics` rows, so the filings stayed pointed at the retired
 * claim: the surviving claim silently lost those topics and the rows became
 * orphans. This walks the existing orphans onto their surviving claim.
 *
 * Merge targets can chain (A merged into B, B later merged into C), so each
 * orphan is resolved transitively through `merged_into_id` with a cycle guard.
 *
 * DRY RUN BY DEFAULT — prints what it would do and writes nothing. Pass
 * `--apply` to commit. Only run when the pipeline is idle: it writes claim_topics,
 * and a concurrent tag_claims job touches the same table.
 *
 *   npx tsx --env-file=.env.local scripts/repairOrphanedTopicLinks.ts [--apply]
 */
export {}

const MAX_CHAIN = 20

type OrphanLink = {
  claim_id: string
  topic_id: string
  confidence: number | null
  assigned_by: string
}

async function main() {
  const apply = process.argv.includes('--apply')
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  // Every non-active claim and where it merged to, so chains resolve in memory.
  const dead = await selectAllPaged<{ id: string; merged_into_id: string | null }>(
    (from, to) =>
      db
        .from('claims')
        .select('id, merged_into_id')
        .neq('status', 'active')
        .order('id', { ascending: true })
        .range(from, to),
    1000
  )
  const mergedInto = new Map(dead.map(d => [d.id, d.merged_into_id]))
  const deadIds = new Set(dead.map(d => d.id))
  console.log(`non-active claims: ${deadIds.size}`)

  /** Follow merged_into_id to the surviving claim. Null if broken or cyclic. */
  const resolve = (start: string): string | null => {
    let cursor = mergedInto.get(start) ?? null
    const seen = new Set<string>([start])
    for (let hop = 0; cursor && hop < MAX_CHAIN; hop++) {
      if (seen.has(cursor)) return null // cycle
      if (!deadIds.has(cursor)) return cursor // landed on a live claim
      seen.add(cursor)
      cursor = mergedInto.get(cursor) ?? null
    }
    return null
  }

  // Read every link and filter in memory rather than sending `.in(deadIds)` —
  // a few hundred UUIDs in a query string overflows the request URL.
  const allLinks = await selectAllPaged<OrphanLink>(
    (from, to) =>
      db
        .from('claim_topics')
        .select('claim_id, topic_id, confidence, assigned_by')
        .order('claim_id', { ascending: true })
        .order('topic_id', { ascending: true })
        .range(from, to),
    1000
  )
  const orphans = allLinks.filter(l => deadIds.has(l.claim_id))
  console.log(`claim_topics rows: ${allLinks.length} — orphaned: ${orphans.length}`)

  const movable: { orphan: OrphanLink; survivor: string }[] = []
  const unresolved: OrphanLink[] = []
  for (const o of orphans) {
    const survivor = resolve(o.claim_id)
    if (survivor) movable.push({ orphan: o, survivor })
    else unresolved.push(o)
  }

  console.log(`  resolvable to a live claim: ${movable.length}`)
  console.log(`  unresolvable (broken/cyclic chain): ${unresolved.length}`)
  for (const u of unresolved.slice(0, 10)) {
    console.log(`    claim ${u.claim_id} → topic ${u.topic_id}`)
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.')
    return
  }

  let moved = 0
  for (const { orphan, survivor } of movable) {
    // ignoreDuplicates: if the survivor is already filed under this topic, keep
    // its own row (and its confidence) rather than overwriting it.
    const { error: upErr } = await db.from('claim_topics').upsert(
      {
        claim_id: survivor,
        topic_id: orphan.topic_id,
        confidence: orphan.confidence,
        assigned_by: orphan.assigned_by,
      },
      { onConflict: 'claim_id,topic_id', ignoreDuplicates: true }
    )
    if (upErr) throw new Error(`upsert failed for ${survivor}/${orphan.topic_id}: ${upErr.message}`)

    const { error: delErr } = await db
      .from('claim_topics')
      .delete()
      .eq('claim_id', orphan.claim_id)
      .eq('topic_id', orphan.topic_id)
    if (delErr) throw new Error(`delete failed for ${orphan.claim_id}/${orphan.topic_id}: ${delErr.message}`)
    moved++
    if (moved % 50 === 0) console.log(`  moved ${moved}/${movable.length}`)
  }
  console.log(`\nDONE — moved ${moved} topic links onto their surviving claims.`)
  console.log('Topic claim counts are now stale; recompute them before trusting the tree.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
