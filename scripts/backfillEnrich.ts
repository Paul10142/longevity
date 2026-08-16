/**
 * Backfill enrich-merge over claims that were merged BEFORE it was on.
 *
 * WHY THIS EXISTS. `attachMember`/`mergeClaims` keep the winner's canonical, so
 * every merge made before 2026-08-16 buried the other side's detail: it survives
 * in `claim_members` (the evidence drill-down) but is absent from the sentence
 * synthesis writes articles from. Enrich-merge fixes that going forward; this
 * script repairs the ~1,230 multi-member claims that predate it — 189 merges by
 * the automated scripts plus every auto-merge from the 84 pre-enrich
 * consolidate_source runs.
 *
 * SAFETY. It only ever rewrites a canonical from that claim's OWN members, and
 * `synthesizeEnrichedCanonical`'s fidelity guard rejects a rewrite asserting a
 * numeric specific no member carried (prior canonical kept). `raw_insights` are
 * immutable and never touched. Rejects are LOGGED here rather than swallowed —
 * `mergeClaims` discards the EnrichResult, which is why rejects have been
 * invisible until now.
 *
 * RESUMABLE. `enriched_at` is stamped on every successful evaluation (changed or
 * not), and the selection is `enriched_at IS NULL`, so an interrupted run simply
 * continues. Interrupting it is safe — each claim commits on its own.
 *
 * NEVER run while the extraction supervisor is running: it writes claims and
 * shares the CLI. Guarded below on --apply.
 *
 *   npx tsx --env-file=.env.local scripts/backfillEnrich.ts [--apply] [--limit N] [--hours H]
 */
export {} // module marker

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { execSync } from 'node:child_process'

const now = () => new Date().toISOString().slice(11, 19)

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const num = (flag: string) => {
    const i = args.indexOf(flag)
    return i > -1 ? Number(args[i + 1]) : undefined
  }
  const limit = num('--limit') ?? Infinity
  const hours = num('--hours') ?? 12
  const deadline = Date.now() + hours * 3_600_000

  if (apply) {
    try {
      const out = execSync('pgrep -f overnightExtract', { encoding: 'utf8' }).trim()
      if (out) {
        console.error(`overnightExtract is running (pid ${out.split('\n')[0]}) — run this after it stops.`)
        process.exit(1)
      }
    } catch {
      /* pgrep exits 1 when nothing matches — that is the good case */
    }
  }

  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  const { enrichClaimCanonical } = await import('../lib/consolidation')
  const { ENRICH_MERGE_ENABLED } = await import('../lib/enrichMerge')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  // enrichClaimCanonical itself does not consult the flag — but running the
  // backfill while the pipeline is configured OFF would be incoherent, and
  // silently so. Fail loudly instead.
  if (!ENRICH_MERGE_ENABLED) {
    console.error('ENRICH_MERGE=0 is set — enrich is disabled for this environment. Refusing to backfill.')
    process.exit(1)
  }

  // Only multi-member claims can bury a side; singletons already equal their one
  // member. Paged — this read is ~1,200 rows and a truncated select would
  // silently skip the tail (the silent-truncation bug class, lib/pagination.ts).
  type Row = { id: string; member_count: number; canonical_statement: string }
  const claims = await selectAllPaged<Row>((from, to) =>
    db.from('claims')
      .select('id, member_count, canonical_statement')
      .eq('status', 'active')
      .gt('member_count', 1)
      .is('enriched_at', null)
      .order('member_count', { ascending: false }) // richest claims first: most buried detail
      .order('id', { ascending: true })            // stable tiebreak so paging cannot skip/repeat
      .range(from, to)
  )

  const work = claims.slice(0, limit)
  console.log(`[${now()}] ${claims.length} un-enriched multi-member claim(s); processing ${work.length} (${apply ? 'APPLY' : 'dry-run'})`)
  if (work.length === 0) return
  if (!apply) {
    const bySize = work.reduce<Record<number, number>>((acc, c) => {
      acc[c.member_count] = (acc[c.member_count] ?? 0) + 1
      return acc
    }, {})
    console.log('  by member count:', Object.entries(bySize).map(([k, v]) => `${k}→${v}`).join(' '))
    console.log('  rerun with --apply to write.')
    return
  }

  const counts = { enriched: 0, unchanged: 0, rejected: 0, failed: 0 }
  let failStreak = 0
  let n = 0

  for (const claim of work) {
    if (Date.now() >= deadline) {
      console.log(`[${now()}] time budget reached — stopping cleanly; rerun to continue.`)
      break
    }
    n++
    try {
      const result = await enrichClaimCanonical(claim.id)
      failStreak = 0
      if (result.rejected) {
        // The guard caught an invented specific and kept the prior canonical.
        // This is the signal that has been invisible in the live path; surface it.
        counts.rejected++
        console.log(`[${n}/${work.length}] REJECTED (invented ${JSON.stringify(result.invented)}) — prior kept — ${claim.id}`)
      } else if (result.changed) {
        counts.enriched++
        console.log(`[${n}/${work.length}] enriched (${claim.member_count} members) "${result.canonical.slice(0, 80)}…"`)
      } else {
        counts.unchanged++
        console.log(`[${n}/${work.length}] no change (${result.reason})`)
      }
    } catch (err) {
      counts.failed++
      failStreak++
      console.error(`[${n}/${work.length}] FAILED ${claim.id} — ${err instanceof Error ? err.message : String(err)}`)
      if (failStreak >= 5) {
        console.error('5 consecutive failures (CLI down?) — stopping; rerun later to continue.')
        break
      }
    }
    if (n % 25 === 0) {
      console.log(`[${now()}] progress: ${n}/${work.length} — ${counts.enriched} enriched, ${counts.unchanged} unchanged, ${counts.rejected} rejected, ${counts.failed} failed`)
    }
  }

  console.log(`\n[${now()}] done: ${counts.enriched} enriched, ${counts.unchanged} already complete, ` +
    `${counts.rejected} rejected by the fidelity guard, ${counts.failed} failed`)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
