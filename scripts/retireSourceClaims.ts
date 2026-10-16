/**
 * Replace a caption-transcript source (docs/caption-retirement-plan.md §3).
 *
 *   npx tsx --env-file=.env.local scripts/retireSourceClaims.ts --twins             # every caption row that has a Deepgram twin (dry run)
 *   npx tsx --env-file=.env.local scripts/retireSourceClaims.ts --source <id>       # one caption row (dry run)
 *   …                                                             --apply            # write, after a JSON backup
 *   npx tsx --env-file=.env.local scripts/retireSourceClaims.ts --resume <backup.json> [--apply]
 *                                       # finish an interrupted --apply from its own backup (dry run without --apply)
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
 *
 * Interruptions (2026-10-16): the plan for steps 2–4 is fixed in the JSON backup
 * and every step writes only what is still outstanding (lib/retireSource.ts), so
 * `--resume <backup.json> --apply` finishes a cut-short run, and repeating it is
 * a no-op. A plain `--source`/`--twins` run that finds an interrupted earlier
 * attempt for the same source REFUSES (exit code 2) and prints the resume command,
 * instead of planning nothing from the half-unhooked state.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { execSync } from 'node:child_process'
import {
  INTERRUPTED_EXIT_CODE, InterruptedAttemptError, applyPlan, assertNoInterruptedAttempt, buildPlan,
  outstanding, readBackup, readProgress, writeBackup,
  type RowAction, type Src,
} from '../lib/retireSource'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const TWINS = args.includes('--twins')
const sourceIdx = args.indexOf('--source')
const SOURCE = sourceIdx > -1 ? args[sourceIdx + 1] : null
const resumeIdx = args.indexOf('--resume')
const RESUME = resumeIdx > -1 ? args[resumeIdx + 1] : null
const now = () => new Date().toISOString().slice(11, 19)
const BACKUP_DIR = process.env.RETIRE_BACKUP_DIR || 'scratchpad/backups'

type Target = { src: Src; twinId: string | null; rowAction: RowAction }

async function main() {
  if (!TWINS && !SOURCE && !RESUME) {
    throw new Error('pass --twins (every caption row with a Deepgram twin), --source <id>, or --resume <backup.json>')
  }
  if (RESUME && (TWINS || SOURCE)) throw new Error('--resume takes a backup file on its own, not --twins / --source')
  if (RESUME && (!RESUME || RESUME.startsWith('--'))) throw new Error('--resume needs the path of a retire-<sourceId>-<stamp>.json backup')
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')
  const { recomputeTopicCounts } = await import('../lib/taxonomy')
  const { createSupabaseRetireStore } = await import('../lib/retireSourceStore')
  const store = await createSupabaseRetireStore()

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

  // ---- resume: finish an interrupted run from its backup -----------------------
  if (RESUME) {
    const plan = readBackup(RESUME)
    const s = plan.source
    const todo = await outstanding(store, plan, readProgress(RESUME))
    console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — resume ${RESUME}\n  source ${s.id} "${s.title.slice(0, 58)}" (row: ${plan.rowAction})`)
    console.log(
      `  outstanding: fact→claim links ${todo.members}, claims to retire ${todo.retireTodo.length} (of ${plan.retireIds.length}), ` +
        `claims to re-derive ${todo.rederiveTodo.length} (of ${plan.rederive.length}), reviews to close ${todo.reviewsTodo.length} (of ${plan.reviewIds.length}), ` +
        `source row: ${todo.source.exists ? `present (${todo.source.origin}), ${todo.source.insights} insights, ${todo.source.chunks} chunks` : 'gone'}`
    )
    if (todo.retireBlocked.length) console.log(`  WARNING: ${todo.retireBlocked.length} claim(s) planned for retirement now have members — they will be left alone`)
    if (todo.source.exists && todo.source.origin !== 'other') console.log(`  NOTE: the source row is now '${todo.source.origin}' (already replaced) — step 5 will leave it alone`)
    if (!APPLY) { console.log(`\n[${now()}] DRY RUN — nothing written`); return }
    const counts = await applyPlan(store, plan, { backupPath: RESUME, log: l => console.log(l) })
    await recomputeTopicCounts()
    console.log(
      `\n[${now()}] DONE (resume) — retired ${counts.retired}, re-derived ${counts.rederived} (skipped ${counts.rederiveSkipped} already done, ` +
        `${counts.rederiveRetired} found empty), reviews closed ${counts.reviewsClosed}, row ${counts.rowAction}; topic counts recomputed`
    )
    return
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
    let rowAction: RowAction = 'clear'
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

  const totals = { insights: 0, members: 0, retired: 0, rederived: 0, reviews: 0, chunks: 0, deletedRows: 0, clearedRows: 0 }

  for (const t of targets) {
    const s = t.src
    // An interrupted earlier --apply for this source: refuse rather than plan nothing.
    await assertNoInterruptedAttempt(store, BACKUP_DIR, s.id)
    const plan = await buildPlan(store, s, t.twinId, t.rowAction)
    const { chunks: chunkCount } = await store.sourceState(s.id)
    console.log(
      `${s.title.slice(0, 58).padEnd(58)}  insights ${String(plan.insights.length).padStart(4)}  members ${String(plan.members.length).padStart(4)}  ` +
        `retire ${String(plan.retireIds.length).padStart(4)}  re-derive ${String(plan.rederive.length).padStart(4)}  reviews ${String(plan.reviewIds.length).padStart(3)}  chunks ${String(chunkCount).padStart(3)}  row: ${t.rowAction}`
    )
    totals.insights += plan.insights.length; totals.members += plan.members.length; totals.retired += plan.retireIds.length
    totals.rederived += plan.rederive.length; totals.reviews += plan.reviewIds.length; totals.chunks += chunkCount
    if (!APPLY) continue

    // --- backup (plan + progress file), then write ----------------------------
    const backupPath = writeBackup(BACKUP_DIR, plan)
    console.log(`  backup → ${backupPath}`)
    const counts = await applyPlan(store, plan, { backupPath, log: l => console.log(l) })
    if (counts.rowAction === 'deleted') totals.deletedRows++
    if (counts.rowAction === 'cleared') totals.clearedRows++
    console.log(`  verified: insights gone, ${plan.retireIds.length} retired, ${plan.rederive.length} re-derived, ${plan.reviewIds.length} reviews closed, row ${t.rowAction}d`)
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

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(e instanceof InterruptedAttemptError ? INTERRUPTED_EXIT_CODE : 1)
})
