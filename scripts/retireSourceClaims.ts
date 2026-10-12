/**
 * Replace a caption-transcript source (docs/caption-retirement-plan.md §3).
 *
 *   npx tsx --env-file=.env.local scripts/retireSourceClaims.ts --twins             # every caption row that has a Deepgram twin (dry run)
 *   npx tsx --env-file=.env.local scripts/retireSourceClaims.ts --source <id>       # one caption row (dry run)
 *   …                                                             --apply            # write, after a JSON backup
 *
 * Paul's rule (2026-10-11): caption-derived information is known-inaccurate, so
 * once an episode has its Deepgram version the caption version is DELETED, not
 * kept in an excluded state. Per source, in this order:
 *
 *   1. unhook — delete the caption insights' claim_members rows;
 *   2. retire — claims left with no members become empty retired shells (the
 *      row stays because reviews, links, filings and old articles point at its
 *      id; its vector row is deleted so no search can ever return it);
 *   3. re-derive — claims that still have good-transcript members get their
 *      wording rebuilt from those survivors: canonical reset to the oldest
 *      survivor, aggregates recomputed, enrich-merge re-run under the fidelity
 *      guard, vector refreshed — so nothing caption-derived survives in text or
 *      vector;
 *   4. close — pending merge reviews on retired claims are rejected
 *      (`decided_by = 'retired-source'`), never deleted;
 *   5. delete — the caption raw_insights and chunks; a duplicate row (no feed
 *      link, a feed/Deepgram row exists for the same episode) is deleted
 *      outright, a linked row is cleared to `pending` for its Deepgram transcript;
 *   6. verify in SQL before moving on.
 *
 * Dry run by default; `--apply` writes. Refuses to apply while a pipeline job is
 * running or a supervisor process is alive: one database writer at a time.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const TWINS = args.includes('--twins')
const sourceIdx = args.indexOf('--source')
const SOURCE = sourceIdx > -1 ? args[sourceIdx + 1] : null
const now = () => new Date().toISOString().slice(11, 19)

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

type Src = {
  id: string
  title: string
  external_id: string | null
  episode_number: number | null
  transcript_origin: string
  processing_status: string
}
type Target = { src: Src; twinId: string | null; rowAction: 'delete' | 'clear' }
type MemberRow = { claim_id: string; raw_insight_id: string; matched_by: string; match_confidence: number | null }
type Survivor = { raw_insight_id: string; source_id: string; statement: string; context_note: string | null; created_at: string }

async function main() {
  if (!TWINS && !SOURCE) {
    throw new Error('pass --twins (every caption row with a Deepgram twin) or --source <id>')
  }
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')
  const { recomputeAggregates, enrichClaimCanonical } = await import('../lib/consolidation')
  const { generateEmbedding, insightEmbeddingText } = await import('../lib/embeddings')
  const { recomputeTopicCounts } = await import('../lib/taxonomy')

  // ---- one writer at a time -------------------------------------------------
  if (APPLY) {
    const { data: running } = await db
      .from('jobs')
      .select('id, type')
      .eq('status', 'running')
      .gt('locked_at', new Date(Date.now() - 10 * 60_000).toISOString())
    const runningJobs = (running ?? []) as { id: string; type: string }[]
    if (runningJobs.length > 0) {
      throw new Error(`refusing to apply: ${runningJobs.length} pipeline job(s) running (${runningJobs.map(r => r.type).join(', ')})`)
    }
    const procs = execSync('ps -eo command', { encoding: 'utf8' })
      .split('\n')
      .filter(l => /extractDeepgram|overnightExtract|scripts\/pipeline\.ts|sweepCorpus/.test(l) && !/grep/.test(l))
    if (procs.length > 0) throw new Error(`refusing to apply: a supervisor is running:\n${procs.join('\n')}`)
    const { acquireWriterLock } = await import('../lib/writerLock')
    acquireWriterLock('retireSourceClaims')
  }

  // ---- targets ---------------------------------------------------------------
  const targets: Target[] = []
  if (TWINS) {
    const captionRows = await selectAllPaged<Src>((from, to) =>
      db.from('sources').select('id, title, external_id, episode_number, transcript_origin, processing_status')
        .eq('transcript_origin', 'other').is('external_id', null).order('id').range(from, to)
    )
    const deepgramRows = await selectAllPaged<{ id: string; episode_number: number | null }>((from, to) =>
      db.from('sources').select('id, episode_number').eq('transcript_origin', 'deepgram')
        .not('episode_number', 'is', null).order('id').range(from, to)
    )
    const byEpisode = new Map<number, string>()
    for (const d of deepgramRows) if (d.episode_number != null) byEpisode.set(d.episode_number, d.id)
    for (const c of captionRows) {
      const m = c.title.match(/^(\d{1,3})\s*[-‒–—]/)
      if (!m) continue
      const twinId = byEpisode.get(Number(m[1]))
      if (twinId) targets.push({ src: c, twinId, rowAction: 'delete' })
    }
  } else if (SOURCE) {
    const { data, error } = await db.from('sources')
      .select('id, title, external_id, episode_number, transcript_origin, processing_status').eq('id', SOURCE).single()
    if (error || !data) throw new Error(`source ${SOURCE}: ${error?.message ?? 'not found'}`)
    const src = data as Src
    if (src.transcript_origin !== 'other') {
      throw new Error(`source ${SOURCE} is '${src.transcript_origin}', not a caption ('other') source — refusing`)
    }
    // A duplicate row (another row holds this episode) is deleted; a linked row,
    // or a row with no other copy of its episode, is cleared to pending instead.
    let rowAction: 'delete' | 'clear' = 'clear'
    const m = src.title.match(/^(\d{1,3})\s*[-‒–—]/)
    if (!src.external_id && m) {
      const { count } = await db.from('sources').select('id', { count: 'exact', head: true })
        .eq('episode_number', Number(m[1])).neq('id', src.id)
      if ((count ?? 0) > 0) rowAction = 'delete'
    }
    targets.push({ src, twinId: null, rowAction })
  }
  if (targets.length === 0) throw new Error('no matching caption sources')

  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — ${targets.length} caption source(s)\n`)
  const backupDir = 'scratchpad/backups'
  if (APPLY) mkdirSync(backupDir, { recursive: true })

  const totals = { insights: 0, members: 0, retired: 0, rederived: 0, reviews: 0, chunks: 0, deletedRows: 0, clearedRows: 0 }

  for (const t of targets) {
    const s = t.src
    // --- what this source holds ---------------------------------------------
    const insights = await selectAllPaged<{ id: string; statement: string; context_note: string | null; direct_quote: string | null; chunk_id: string | null; created_at: string }>(
      (from, to) => db.from('raw_insights').select('id, statement, context_note, direct_quote, chunk_id, created_at').eq('source_id', s.id).order('id').range(from, to)
    )
    const insightIds = insights.map(i => i.id)
    const members: MemberRow[] = []
    for (const ids of chunk(insightIds, 200)) {
      const { data, error } = await db.from('claim_members').select('claim_id, raw_insight_id, matched_by, match_confidence').in('raw_insight_id', ids)
      if (error) throw new Error(`claim_members: ${error.message}`)
      members.push(...((data ?? []) as MemberRow[]))
    }
    const affected = [...new Set(members.map(m => m.claim_id))]

    // --- plan per affected claim: retire (no survivors) or re-derive -----------
    const retireIds: string[] = []
    const rederive: { claimId: string; seed: Survivor; survivors: number }[] = []
    for (const claimId of affected) {
      const { data, error } = await db
        .from('claim_members')
        .select('raw_insight_id, raw_insights(source_id, statement, context_note, created_at)')
        .eq('claim_id', claimId)
      if (error) throw new Error(`members of ${claimId}: ${error.message}`)
      type Row = { raw_insight_id: string; raw_insights: { source_id: string; statement: string; context_note: string | null; created_at: string } | null }
      const survivors: Survivor[] = ((data ?? []) as Row[])
        .filter(r => r.raw_insights && r.raw_insights.source_id !== s.id)
        .map(r => ({ raw_insight_id: r.raw_insight_id, ...(r.raw_insights as NonNullable<Row['raw_insights']>) }))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      if (survivors.length === 0) retireIds.push(claimId)
      else rederive.push({ claimId, seed: survivors[0], survivors: survivors.length })
    }

    const claimsBefore: unknown[] = []
    for (const ids of chunk(affected, 100)) {
      const { data } = await db.from('claims').select('id, status, canonical_statement, context_note, member_count, source_count, enriched_at').in('id', ids)
      claimsBefore.push(...(data ?? []))
    }
    const reviews: { id: string }[] = []
    for (const ids of chunk(retireIds, 100)) {
      const { data, error } = await db.from('merge_reviews').select('id, claim_id, candidate_claim_id')
        .eq('status', 'pending').or(`claim_id.in.(${ids.join(',')}),candidate_claim_id.in.(${ids.join(',')})`)
      if (error) throw new Error(`merge_reviews: ${error.message}`)
      reviews.push(...((data ?? []) as { id: string }[]))
    }
    const reviewIds = [...new Set(reviews.map(r => r.id))]
    const { count: chunkCount } = await db.from('chunks').select('id', { count: 'exact', head: true }).eq('source_id', s.id)

    console.log(
      `${s.title.slice(0, 58).padEnd(58)}  insights ${String(insights.length).padStart(4)}  members ${String(members.length).padStart(4)}  ` +
        `retire ${String(retireIds.length).padStart(4)}  re-derive ${String(rederive.length).padStart(4)}  reviews ${String(reviewIds.length).padStart(3)}  chunks ${String(chunkCount ?? 0).padStart(3)}  row: ${t.rowAction}`
    )
    totals.insights += insights.length; totals.members += members.length; totals.retired += retireIds.length
    totals.rederived += rederive.length; totals.reviews += reviewIds.length; totals.chunks += chunkCount ?? 0
    if (!APPLY) continue

    // --- backup, then write ---------------------------------------------------
    const backupPath = path.join(backupDir, `retire-${s.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(backupPath, JSON.stringify({ source: s, twinId: t.twinId, rowAction: t.rowAction, insights, members, claimsBefore, retireIds, rederive, reviewIds }, null, 1))
    console.log(`  backup → ${backupPath}`)

    // 1. unhook
    for (const ids of chunk(insightIds, 200)) {
      const { error } = await db.from('claim_members').delete().in('raw_insight_id', ids)
      if (error) throw new Error(`unhook: ${error.message}`)
    }
    // 2. retire the emptied claims; drop their vectors
    for (const ids of chunk(retireIds, 100)) {
      const { error } = await db.from('claims').update({ status: 'retired', member_count: 0, source_count: 0 }).in('id', ids)
      if (error) throw new Error(`retire: ${error.message}`)
      const { error: e2 } = await db.from('claim_embeddings').delete().in('claim_id', ids)
      if (e2) throw new Error(`retire vectors: ${e2.message}`)
    }
    // 3. re-derive the mixed claims from their survivors
    let n = 0
    for (const r of rederive) {
      const { error } = await db.from('claims')
        .update({ canonical_statement: r.seed.statement, context_note: r.seed.context_note, needs_tagging: true })
        .eq('id', r.claimId)
      if (error) throw new Error(`reseed ${r.claimId}: ${error.message}`)
      await recomputeAggregates(r.claimId)
      const result = await enrichClaimCanonical(r.claimId)
      if (!result.changed) {
        // enrich only refreshes the vector when it rewrote the text; the seed
        // reset changed the text too, so refresh it here.
        const vector = await generateEmbedding(insightEmbeddingText({ statement: result.canonical, context_note: r.seed.context_note }))
        const { error: e3 } = await db.from('claim_embeddings')
          .upsert({ claim_id: r.claimId, embedding: vector, updated_at: new Date().toISOString() }, { onConflict: 'claim_id' })
        if (e3) throw new Error(`re-embed ${r.claimId}: ${e3.message}`)
      }
      if (++n % 25 === 0) console.log(`  re-derived ${n}/${rederive.length}`)
    }
    // 4. close the reviews on retired claims
    for (const ids of chunk(reviewIds, 100)) {
      const { error } = await db.from('merge_reviews')
        .update({ status: 'rejected', decided_by: 'retired-source', decided_at: new Date().toISOString() }).in('id', ids)
      if (error) throw new Error(`close reviews: ${error.message}`)
    }
    // 5. delete the caption version
    const { error: delIns } = await db.from('raw_insights').delete().eq('source_id', s.id)
    if (delIns) throw new Error(`delete insights: ${delIns.message}`)
    const { error: delCh } = await db.from('chunks').delete().eq('source_id', s.id)
    if (delCh) throw new Error(`delete chunks: ${delCh.message}`)
    if (t.rowAction === 'delete') {
      const { error } = await db.from('sources').delete().eq('id', s.id)
      if (error) throw new Error(`delete source row: ${error.message}`)
      totals.deletedRows++
    } else {
      const { error } = await db.from('sources')
        .update({ transcript: null, timed_transcript: null, processing_status: 'pending', processing_error: null, last_processed_at: null })
        .eq('id', s.id)
      if (error) throw new Error(`clear source row: ${error.message}`)
      totals.clearedRows++
    }
    // 6. verify
    const { count: leftInsights } = await db.from('raw_insights').select('id', { count: 'exact', head: true }).eq('source_id', s.id)
    let notRetired = 0
    for (const ids of chunk(retireIds, 100)) {
      const { count } = await db.from('claims').select('id', { count: 'exact', head: true }).in('id', ids).neq('status', 'retired')
      notRetired += count ?? 0
    }
    let missingVectors = 0, emptyRederived = 0
    for (const ids of chunk(rederive.map(r => r.claimId), 100)) {
      const { count: vecs } = await db.from('claim_embeddings').select('claim_id', { count: 'exact', head: true }).in('claim_id', ids)
      missingVectors += ids.length - (vecs ?? 0)
      const { count: empties } = await db.from('claims').select('id', { count: 'exact', head: true }).in('id', ids).eq('member_count', 0)
      emptyRederived += empties ?? 0
    }
    const problems = [
      leftInsights ? `${leftInsights} insights remain` : '',
      notRetired ? `${notRetired} claims not retired` : '',
      missingVectors ? `${missingVectors} re-derived claims without a vector` : '',
      emptyRederived ? `${emptyRederived} re-derived claims with no members` : '',
    ].filter(Boolean)
    if (problems.length) throw new Error(`VERIFY FAILED for ${s.id}: ${problems.join('; ')}`)
    console.log(`  verified: insights gone, ${retireIds.length} retired, ${rederive.length} re-derived, ${reviewIds.length} reviews closed, row ${t.rowAction}d`)
  }

  if (APPLY) {
    await recomputeTopicCounts()
    console.log(`\n[${now()}] topic counts recomputed`)
  }
  console.log(
    `\n[${now()}] ${APPLY ? 'DONE' : 'DRY RUN'} — sources ${targets.length}: insights ${totals.insights}, members ${totals.members}, ` +
      `claims to retire ${totals.retired}, to re-derive ${totals.rederived}, reviews to close ${totals.reviews}, chunks ${totals.chunks}` +
      (APPLY ? `; rows deleted ${totals.deletedRows}, cleared ${totals.clearedRows}` : '')
  )
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
