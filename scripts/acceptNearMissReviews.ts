/**
 * Clear the "near-miss" half of the merge-review queue.
 *
 * Every pending row in that queue is a SAME verdict — the checker judged the two
 * statements the same underlying fact — that landed just under
 * AUTO_MERGE_CONFIDENCE (0.85) and so was parked for a human instead of merged.
 * On 2026-08-16, 145 rows were pending and 83 of them sat at 0.82–0.83: they
 * failed a threshold, not a judgement.
 *
 * Parking them was the right call only while a merge was LOSSY — `attachMember`
 * and `mergeClaims` keep the winner's canonical, so the other side's detail was
 * buried in the evidence drill-down. With enrich-merge enabled (ENRICH_MERGE=1,
 * Paul opted in 2026-08-16) `mergeClaims` rewrites the winner's canonical to
 * carry every member's detail, so accepting a SAME verdict no longer loses
 * anything — which is what makes this bulk accept safe.
 *
 * Scope is deliberately narrow: model_verdict SAME and confidence ≥ --min
 * (default 0.80). Rows below that stay pending for Paul — the point is to spend
 * his attention on the genuinely uncertain ones, not on threshold rounding.
 *
 * Dry-run by default. NEVER run while the extraction supervisor is running: it
 * writes the same claims tables and (through enrich) shares the CLI — the same
 * guard as scripts/readjudicateCheckerErrors.ts. Applied rows are backed up to
 * scratchpad/ first.
 *
 *   npx tsx --env-file=.env.local scripts/acceptNearMissReviews.ts [--apply] [--min 0.8] [--limit N]
 */
export {} // module marker

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const num = (flag: string) => {
    const i = args.indexOf(flag)
    return i > -1 ? Number(args[i + 1]) : undefined
  }
  const min = num('--min') ?? 0.8
  const limit = num('--limit') ?? Infinity

  // The extraction supervisor and this script must not share the CLI or the
  // claims tables. Refuse to WRITE while it runs. The dry run is pure reads and
  // makes no model call (it accepts the verdict already on the row rather than
  // re-adjudicating), so previewing the selection mid-extraction is safe.
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
  const { mergeClaims } = await import('../lib/consolidation')
  const { ENRICH_MERGE_ENABLED } = await import('../lib/enrichMerge')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  // Not fatal — the merges are still correct — but it changes what they mean, so
  // it must never be silent: without enrich the loser's detail stays buried.
  if (!ENRICH_MERGE_ENABLED) {
    console.log('⚠ ENRICH_MERGE is OFF — merges will keep the winner\'s wording and bury the')
    console.log('  other side\'s detail. Set ENRICH_MERGE=1 in .env.local first, or accept that')
    console.log('  a later enrich sweep must fold the detail back in.\n')
  }

  type Row = {
    id: string
    claim_id: string
    candidate_claim_id: string
    similarity: number | null
    model_confidence: number | null
    model_reasoning: string | null
    created_at: string
  }
  const rows = await selectAllPaged<Row>((from, to) =>
    db.from('merge_reviews')
      .select('id, claim_id, candidate_claim_id, similarity, model_confidence, model_reasoning, created_at')
      .eq('status', 'pending')
      .eq('model_verdict', 'SAME')
      .gte('model_confidence', min)
      .order('created_at', { ascending: true })
      .range(from, to)
  )
  const work = rows.slice(0, limit)
  console.log(`${rows.length} pending SAME row(s) at confidence ≥ ${min}; processing ${work.length} (${apply ? 'APPLY' : 'dry-run'})`)
  if (work.length === 0) return

  if (apply) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const path = `scratchpad/merge-reviews-nearmiss-backup-${stamp}.json`
    writeFileSync(path, JSON.stringify(work, null, 2))
    console.log(`backed up ${work.length} row(s) → ${path}`)
  }

  type ClaimRow = { id: string; canonical_statement: string; status: string; merged_into_id: string | null }
  /** Follow merged_into_id to the surviving claim (bounded — chains are short). */
  async function resolveSurvivor(id: string): Promise<ClaimRow | null> {
    for (let hop = 0; hop < 5; hop++) {
      const { data } = await db.from('claims')
        .select('id, canonical_statement, status, merged_into_id')
        .eq('id', id).maybeSingle()
      if (!data) return null
      if (!data.merged_into_id) return data as ClaimRow
      id = data.merged_into_id
    }
    return null
  }

  const counts = { merged: 0, already_merged: 0, skipped: 0, failed: 0 }
  const decidedStamp = () => ({ decided_at: new Date().toISOString(), decided_by: 'auto-accept-near-miss' })
  let failStreak = 0
  let n = 0

  for (const row of work) {
    n++
    // The review's claim_id is the provisional claim consolidation created; the
    // candidate is the pre-existing one it matched. Merge provisional → candidate,
    // exactly as the admin accept button does (app/api/admin/reviews/[id]/route.ts).
    const provisional = await resolveSurvivor(row.claim_id)
    const candidate = await resolveSurvivor(row.candidate_claim_id)

    if (!provisional || !candidate || provisional.status !== 'active' || candidate.status !== 'active') {
      counts.skipped++
      console.log(`[${n}/${work.length}] skip — claim missing/inactive (review ${row.id})`)
      continue
    }
    if (provisional.id === candidate.id) {
      counts.already_merged++
      console.log(`[${n}/${work.length}] pair already merged elsewhere → close accepted`)
      if (apply) await db.from('merge_reviews').update({ status: 'accepted', ...decidedStamp() }).eq('id', row.id)
      continue
    }

    const conf = (row.model_confidence ?? 0).toFixed(2)
    const short = provisional.canonical_statement.slice(0, 70)
    console.log(`[${n}/${work.length}] SAME ${conf} → merge  "${short}"`)
    if (!apply) { counts.merged++; continue }

    try {
      // With ENRICH_MERGE=1 this also rewrites the winner's canonical to carry
      // both sides' detail (and re-flags it for tagging).
      await mergeClaims(provisional.id, candidate.id)
      await db.from('merge_reviews').update({ status: 'accepted', ...decidedStamp() }).eq('id', row.id)
      counts.merged++
      failStreak = 0
    } catch (err) {
      // Leave the row pending: the merge is either untouched or done-but-not-enriched,
      // and enrichClaimCanonical is idempotent, so a rerun resolves either state
      // (a completed merge comes back as "already merged → close accepted").
      counts.failed++
      failStreak++
      console.error(`[${n}/${work.length}] FAILED — ${err instanceof Error ? err.message : String(err)}`)
      if (failStreak >= 3) {
        console.error('3 consecutive failures (CLI down?) — stopping; rerun this script later.')
        break
      }
    }
  }

  console.log(`\ndone (${apply ? 'applied' : 'dry-run'}): ${counts.merged} merged, ` +
    `${counts.already_merged} already merged, ${counts.skipped} skipped, ${counts.failed} failed`)
  if (!apply) console.log('rerun with --apply to write.')
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
