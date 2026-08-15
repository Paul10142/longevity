/**
 * Re-adjudicate merge_review rows that were filed while the dedup checker
 * itself was down (model_reasoning === ADJUDICATION_FAILED_REASONING — e.g.
 * the 121 rows from the 2026-08-15 05:08 UTC usage-limit outage). Those rows
 * are not verdicts, they are outage debris: they bury the genuine review queue
 * and, because sweepClaims skips any pair that has a review row regardless of
 * status, they permanently block re-adjudication of their pair.
 *
 * For each row the recorded pair is re-run through the real adjudicator:
 *   SAME ≥ AUTO_MERGE_CONFIDENCE → merge provisional into candidate, close accepted
 *   DIFFERENT                    → keep both, near-duplicate link, close rejected
 *   UNSURE / weak SAME           → row stays pending with the REAL verdict —
 *                                  a genuine review Paul should look at
 * Every close is stamped decided_by 'auto-readjudicate' so it is auditable.
 *
 * Dry-run by default (still calls the LLM to preview verdicts — use --limit
 * for a cheap smoke test). --apply to write. NEVER run while the extraction
 * supervisor is running: it competes for the CLI and writes claims (guarded
 * below). Applied rows are first backed up to scratchpad/.
 *
 *   npx tsx --env-file=.env.local scripts/readjudicateCheckerErrors.ts [--apply] [--limit N]
 */
export {} // module marker

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const limitIdx = args.indexOf('--limit')
  const limit = limitIdx > -1 ? Number(args[limitIdx + 1]) : Infinity

  // The extraction supervisor and this script must not share the CLI or the
  // claims tables. Refuse to start while it runs.
  try {
    const out = execSync('pgrep -f overnightExtract', { encoding: 'utf8' }).trim()
    if (out) {
      console.error(`overnightExtract is running (pid ${out.split('\n')[0]}) — run this after it stops.`)
      process.exit(1)
    }
  } catch {
    /* pgrep exits 1 when nothing matches — that is the good case */
  }

  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  const {
    adjudicate, mergeClaims, linkNearDuplicate,
    AUTO_MERGE_CONFIDENCE, ADJUDICATION_FAILED_REASONING, AdjudicationUnavailableError,
  } = await import('../lib/consolidation')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  type Row = { id: string; claim_id: string; candidate_claim_id: string; similarity: number | null; created_at: string }
  const rows = await selectAllPaged<Row>((from, to) =>
    db.from('merge_reviews')
      .select('id, claim_id, candidate_claim_id, similarity, created_at')
      .eq('status', 'pending')
      .eq('model_reasoning', ADJUDICATION_FAILED_REASONING)
      .order('created_at', { ascending: true })
      .range(from, to)
  )
  const work = rows.slice(0, limit)
  console.log(`${rows.length} pending checker-error row(s); processing ${work.length} (${apply ? 'APPLY' : 'dry-run'})`)
  if (work.length === 0) return

  if (apply) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const path = `scratchpad/merge-reviews-checker-backup-${stamp}.json`
    writeFileSync(path, JSON.stringify(work, null, 2))
    console.log(`backed up ${work.length} row(s) → ${path}`)
  }

  type ClaimRow = { id: string; canonical_statement: string; context_note: string | null; status: string; merged_into_id: string | null }
  // Follow merged_into_id to the surviving claim (bounded — chains are short).
  async function resolveSurvivor(id: string): Promise<ClaimRow | null> {
    for (let hop = 0; hop < 5; hop++) {
      const { data } = await db.from('claims')
        .select('id, canonical_statement, context_note, status, merged_into_id')
        .eq('id', id).maybeSingle()
      if (!data) return null
      if (!data.merged_into_id) return data as ClaimRow
      id = data.merged_into_id
    }
    return null
  }

  const counts = { merged: 0, rejected: 0, genuine: 0, already_merged: 0, skipped: 0 }
  const decidedStamp = () => ({ decided_at: new Date().toISOString(), decided_by: 'auto-readjudicate' })
  let n = 0
  for (const row of work) {
    n++
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

    let verdict
    try {
      verdict = await adjudicate(provisional.canonical_statement, [{
        id: candidate.id,
        canonical_statement: candidate.canonical_statement,
        context_note: candidate.context_note,
        similarity: row.similarity ?? 0,
      }])
    } catch (err) {
      if (err instanceof AdjudicationUnavailableError) {
        console.error(`CLI unavailable at row ${n}/${work.length} — stopping; rerun this script later.`)
        break
      }
      throw err
    }

    const short = provisional.canonical_statement.slice(0, 70)
    const verdictFields = {
      model_verdict: verdict.verdict,
      model_confidence: verdict.confidence,
      model_reasoning: verdict.reasoning,
    }
    if (verdict.verdict === 'SAME' && verdict.confidence >= AUTO_MERGE_CONFIDENCE) {
      counts.merged++
      console.log(`[${n}/${work.length}] SAME ${verdict.confidence.toFixed(2)} → merge  "${short}"`)
      if (apply) {
        await mergeClaims(provisional.id, candidate.id)
        await db.from('merge_reviews').update({ status: 'accepted', ...verdictFields, ...decidedStamp() }).eq('id', row.id)
      }
    } else if (verdict.verdict === 'DIFFERENT') {
      counts.rejected++
      console.log(`[${n}/${work.length}] DIFFERENT ${verdict.confidence.toFixed(2)} → keep both  "${short}"`)
      if (apply) {
        await linkNearDuplicate(provisional.id, candidate.id, row.similarity)
        await db.from('merge_reviews').update({ status: 'rejected', ...verdictFields, ...decidedStamp() }).eq('id', row.id)
      }
    } else {
      // Genuine UNSURE (or SAME under the auto-merge bar): stays pending, but
      // now carrying a real verdict + reasoning for the human review.
      counts.genuine++
      console.log(`[${n}/${work.length}] ${verdict.verdict} ${verdict.confidence.toFixed(2)} → stays pending  "${short}"`)
      if (apply) await db.from('merge_reviews').update(verdictFields).eq('id', row.id)
    }
  }

  console.log(`\ndone (${apply ? 'applied' : 'dry-run'}): ${counts.merged} merged, ${counts.rejected} closed as distinct, ` +
    `${counts.genuine} genuine reviews kept pending, ${counts.already_merged} already merged, ${counts.skipped} skipped`)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
