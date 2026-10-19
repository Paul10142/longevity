/**
 * Extraction supervisor scoped to Deepgram-transcribed sources.
 *
 *   npx tsx --env-file=.env.local scripts/extractDeepgram.ts [--hours N] [--batch N]
 *
 * Covers both good transcript origins: 'deepgram' (ours, diarised) and
 * 'published' (the show's own, publisher-labelled).
 *
 * Why not `overnightExtract.ts`: that one queues every pending source with no
 * insights, which today would sweep in the sources still carrying YouTube
 * auto-captions. Those are the ones we have decided to re-transcribe, so
 * extracting them now produces claims that must be thrown away — and worse,
 * they are OLDER than the Deepgram rows, and `claim_next_job()` is FIFO within a
 * tier, so they would run FIRST and starve the good work indefinitely. Four such
 * jobs had already been queued and were dequeued by hand on 2026-08-24.
 *
 * So the origin filter is the whole point. Widen it only to another origin that
 * carries real speaker attribution — never relax it to "pending" alone.
 *
 * Deliberately deferred, matching overnightExtract: tagging, article regen, and
 * the reference pass. All reversible later passes.
 *
 * Usage limits (2026-10-12): the subscription window filled 23 minutes in and
 * the old loop kept running a round every ~2.5 min for an hour — 10,744 failed
 * calls. Now a full or nearly-full window (lib/usageLimit.ts) makes the worker
 * defer its job (no attempt spent) and this loop sleep until just after the
 * reset, printing one PAUSE and one RESUME line so the lost time is greppable.
 *
 * Poison jobs: a job that can never succeed (a model safety-filter refusal) or
 * keeps failing round after round is quarantined — left `failed`, not healed —
 * so it neither re-spends calls every round nor keeps the run from finishing.
 *
 * Ending: the run is done when nothing is left to enqueue and no RUNNABLE job is
 * open (lib/runnableWork.ts) — jobs of a type this run skips (SKIP_* flags),
 * quarantined jobs and jobs parked past the deadline do not count. Before
 * 2026-10-12 any open job did, so the parked August tag_claims job kept a
 * finished run idling for ~45 minutes until it was stopped by hand.
 *
 * Lanes (2026-10-18, lib/pipelineLanes.ts, docs/EXTRACTION_RUNBOOK.md §9). The same
 * script runs in three modes so the usage guard's pattern covers all of them:
 *
 *   (no flag)           extract and consolidate together, as before; holds the whole corpus
 *   --extract-only      only extract_source jobs; consolidate_source jobs stay queued, and the
 *                       run ends when no extraction work remains
 *   --consolidate-only  only consolidate_source jobs, one source at a time, ends when none are
 *                       left (and, while an extract-only run is live, waits for the jobs it queues)
 *
 * One extract-only run and one consolidate-only run may hold the corpus together (lane
 * locks, lib/writerLock.ts); neither may run beside a maintenance writer or a second run of
 * its own lane. Lane modes need migration 032.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
process.env.SKIP_TAGGING = process.env.SKIP_TAGGING || '1'
process.env.SKIP_SYNTHESIS_FANOUT = process.env.SKIP_SYNTHESIS_FANOUT || '1'
process.env.SKIP_REFERENCES = process.env.SKIP_REFERENCES || '1'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString().slice(11, 19)

function num(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag)
  return i > -1 ? Number(args[i + 1]) : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const hours = num(args, '--hours') ?? 10
  const batch = num(args, '--batch') ?? 3
  const deadline = Date.now() + hours * 3_600_000

  const { parseLane, laneJobTypes, laneHealTypes, laneEnqueuesExtractions, laneLabel, consolidateShouldWait } =
    await import('../lib/pipelineLanes')
  const lane = parseLane(args)
  if (lane !== 'all' && process.env.ALLOW_MEMBERED_REEXTRACT === '1') {
    // That override makes extraction run a library-wide claim reconcile, which is
    // unsafe beside another lane. Do it as a plain (no flag) run instead.
    throw new Error('ALLOW_MEMBERED_REEXTRACT=1 is not allowed in a lane run; use the plain supervisor for that')
  }
  const laneTypes = laneJobTypes(lane)

  const { startRunLog } = await import('../lib/runLog')
  startRunLog(lane === 'all' ? 'extractDeepgram' : `extractDeepgram-${lane}`)
  // One writer at a time: refuse to start while a maintenance script or another
  // supervisor holds the corpus, instead of racing it. A lane run takes only its
  // lane, so one extract-only and one consolidate-only run can overlap.
  const { acquireWriterLock, acquireLaneLock, laneIsLive } = await import('../lib/writerLock')
  if (lane === 'all') acquireWriterLock(laneLabel(lane))
  else acquireLaneLock(lane, laneLabel(lane))
  const { enqueueJob } = await import('../lib/jobs')
  const { runWorkerTick } = await import('../lib/worker')
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  const { formatCliStats, cliCircuit } = await import('../lib/llm')
  const { usageGate, planPause, quarantineReason, PipelineHaltError } = await import('../lib/usageLimit')
  const { reportHalt } = await import('../lib/haltNotice')
  const { classifyOpenJobs, describeWork, runIsFinished, runnableJobTypes } = await import('../lib/runnableWork')
  type UsageLimitErr = import('../lib/usageLimit').UsageLimitError
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  console.log(
    `[${now()}] deepgram extraction${lane === 'all' ? '' : ` — ${lane.toUpperCase()}-ONLY lane`} — deadline in ${hours}h` +
      (laneEnqueuesExtractions(lane) ? `, batch ${batch}` : '')
  )

  /** Sources that already carry insights — never re-enqueue (would double them). */
  async function extractedIds(): Promise<Set<string>> {
    const rows = await selectAllPaged<{ source_id: string }>((from, to) =>
      db.from('raw_insights').select('source_id').range(from, to)
    )
    return new Set(rows.map(r => r.source_id))
  }

  async function pendingGoodTranscripts(extracted: Set<string>): Promise<string[]> {
    const rows = await selectAllPaged<{ id: string }>((from, to) =>
      db
        .from('sources')
        .select('id')
        // THE filter — see the header. Both values mean "a transcript with real
        // speaker attribution": 'deepgram' is ours (diarised), 'published' is
        // the show's own (publisher-labelled). What is excluded is 'other',
        // i.e. YouTube auto-captions, which is the whole point.
        .in('transcript_origin', ['deepgram', 'published'])
        .eq('processing_status', 'pending')
        .order('date', { ascending: false }) // newest first, as asked
        .range(from, to)
    )
    return rows.map(r => r.id).filter(id => !extracted.has(id))
  }

  const healCounts = new Map<string, number>()
  const quarantined = new Map<string, string>() // job id -> reason

  /**
   * The open jobs this run should still wait for. Not a raw count: a parked job
   * (run_after beyond the deadline), a job of a type this run skips, and a
   * quarantined job can never drain here, so counting them kept a finished run
   * idling until stopped by hand (2026-10-12, the parked August tag_claims job).
   */
  async function openWork() {
    const rows = await selectAllPaged<{ id: string; type: string; status: string; run_after: string | null }>(
      (from, to) =>
        db.from('jobs').select('id, type, status, run_after').in('status', ['queued', 'running']).order('id').range(from, to)
    )
    return classifyOpenJobs(rows, deadline, {
      types: runnableJobTypes(process.env, lane),
      quarantinedIds: new Set(quarantined.keys()),
    })
  }

  /**
   * Heal jobs that failed on a transport blip so they retry — except jobs that
   * cannot succeed: a safety-filter refusal is deterministic for its input, and
   * a job that has been healed 3 times and still fails is not
   * suffering a blip. Those stay `failed` (reported at STOP), so they stop
   * re-spending calls every round and stop counting as open work.
   */
  async function healFailed(): Promise<number> {
    const { data: failed } = await db
      .from('jobs')
      .select('id, type, error')
      .eq('status', 'failed')
      .in('type', laneHealTypes(lane))
    const heal: string[] = []
    for (const j of (failed ?? []) as { id: string; type: string; error: string | null }[]) {
      if (quarantined.has(j.id)) continue
      const n = (healCounts.get(j.id) ?? 0) + 1
      const reason = quarantineReason(j.error, n - 1)
      if (reason) {
        quarantined.set(j.id, `${j.type}: ${reason}`)
        console.log(
          `[${now()}] quarantined job ${j.id} (${j.type}) — ${reason}; left failed, not retried this run. ` +
            `Last error: ${(j.error ?? '').replace(/\s+/g, ' ').slice(0, 140)}`
        )
        continue
      }
      healCounts.set(j.id, n)
      heal.push(j.id)
    }
    if (!heal.length) return 0
    const { data } = await db
      .from('jobs')
      .update({ status: 'queued', run_after: new Date().toISOString(), locked_at: null })
      .in('id', heal)
      .select('id')
    return (data ?? []).length
  }

  let pausedMs = 0
  let pauseCount = 0
  const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19)
  const mins = (ms: number) => `${Math.round(ms / 60_000)}m`

  /**
   * Sleep until the usage window reopens. Returns false when it reopens only
   * after the run's deadline (a weekly limit): the caller ends the run.
   */
  async function pauseForLimit(limit: UsageLimitErr): Promise<boolean> {
    const t0 = Date.now()
    const plan = planPause(limit.resetAt, t0, deadline)
    const why =
      limit.kind === 'approaching'
        ? `usage window ${Math.round((limit.utilization ?? 0) * 100)}% full, pausing before the limit`
        : 'usage limit reached'
    const resets = limit.resetAt ? `${new Date(limit.resetAt).toISOString()} UTC` : 'at an unknown time'
    if (plan.beyondDeadline) {
      console.log(`[${now()}] PAUSE — ${why}; resets ${resets}, after this run's deadline — stopping the run.`)
      return false
    }
    console.log(
      `[${now()}] PAUSE — ${why}; resets ${resets}. Sleeping until ${hhmmss(plan.wakeAt)} UTC (${mins(plan.sleepMs)}). ` +
        `Jobs keep their checkpoints; no attempts spent.`
    )
    await sleep(plan.sleepMs)
    const lost = Date.now() - t0
    pausedMs += lost
    pauseCount++
    console.log(
      `[${now()}] RESUME — paused ${mins(lost)} (${hhmmss(t0)} → ${hhmmss(t0 + lost)} UTC); ` +
        `total paused ${mins(pausedMs)} over ${pauseCount} pause(s).`
    )
    return true
  }

  let round = 0
  let idleStreak = 0
  let failStreak = 0
  let lastExtracted = -1
  let halted: InstanceType<typeof PipelineHaltError> | null = null

  while (Date.now() < deadline) {
    try {
      // Check before doing anything: if the window is full (or nearly), wait
      // for it instead of enqueueing work whose calls would be refused.
      const preGate = usageGate()
      if (preGate) {
        if (!(await pauseForLimit(preGate))) break
        continue
      }

      round++
      const healed = await healFailed()
      if (healed) console.log(`[${now()}] healed ${healed} failed job(s)`)

      // The consolidate lane starts no extractions and has no use for the source list.
      const extracted = laneEnqueuesExtractions(lane) ? await extractedIds() : new Set<string>()
      const remaining = laneEnqueuesExtractions(lane) ? await pendingGoodTranscripts(extracted) : []

      // Back-pressure: if the last round healed failures and completed nothing,
      // the CLI is probably in a usage-limit window. Drain what exists rather
      // than stacking more jobs that will fail the same way.
      const stalled = healed > 0 && extracted.size === lastExtracted
      lastExtracted = extracted.size
      const fresh = stalled ? [] : remaining.slice(0, batch)
      if (stalled) console.log(`[${now()}] stalled — pausing fresh enqueues this round`)

      for (const id of fresh) await enqueueJob('extract_source', { source_id: id })

      const work = await openWork()
      console.log(
        `[${now()}] round ${round}: ${remaining.length} source(s) left, ` +
          `${fresh.length} enqueued, ${work.open} open job(s): ${describeWork(work)}`
      )
      if (runIsFinished(fresh.length, work)) {
        // Every extraction an extract-only run finishes queues a consolidation, so an
        // empty queue is not "done" while that run is still going.
        if (consolidateShouldWait(lane, laneIsLive('extract'), work.runnable)) {
          console.log(`[${now()}] queue empty but an extract-only run is live — waiting 2m for the jobs it queues.`)
          await sleep(2 * 60_000)
          continue
        }
        console.log(`[${now()}] no remaining work — done.`)
        break
      }

      // `processed` counts only jobs that SUCCEEDED or yielded. A job that threw
      // is not progress: a round of nothing but failures sleeps (below) instead
      // of spinning, which is how one poison job used to keep rounds "busy".
      let processed = 0
      let failedJobs = 0
      let limitHit: UsageLimitErr | undefined
      for (;;) {
        const tick = await runWorkerTick(15 * 60_000, laneTypes ? { jobTypes: laneTypes } : {})
        processed += tick.processed - tick.failed
        failedJobs += tick.failed
        // Also read the breaker itself: a halt swallowed inside a handler never reaches the tick.
        halted = tick.halt ?? cliCircuit.halted
        if (halted) break
        if (tick.usageLimit) {
          limitHit = tick.usageLimit
          break
        }
        if (tick.processed === 0 || Date.now() >= deadline) break
      }
      console.log(
        `[${now()}] round ${round}: drained ${processed} job(s)` +
          `${failedJobs ? `, ${failedJobs} failed` : ''}; ${formatCliStats()}`
      )

      if (halted) {
        reportHalt(halted, msg => console.log(`[${now()}] ${msg}`))
        break
      }

      if (limitHit) {
        if (!(await pauseForLimit(limitHit))) break
        idleStreak = 0
        failStreak = 0
        continue
      }

      if (processed === 0) {
        idleStreak++
        const wait = Math.min(15 * 60_000, 3 * 60_000 * idleStreak)
        console.log(`[${now()}] no progress (streak ${idleStreak}) — sleeping ${Math.round(wait / 60000)}m`)
        await sleep(wait)
      } else {
        idleStreak = 0
      }
      failStreak = 0
    } catch (err) {
      if (err instanceof PipelineHaltError) {
        halted = err
        reportHalt(err, msg => console.log(`[${now()}] ${msg}`))
        break
      }
      // A round that dies mid-flight (Supabase unreachable AND the CLI down at
      // once) must not kill an unattended run: whatever job it held either
      // failed (healFailed requeues it) or goes stale and is reclaimed.
      failStreak++
      const wait = Math.min(15 * 60_000, 3 * 60_000 * failStreak)
      const msg = err instanceof Error ? err.message.slice(0, 160) : String(err)
      console.warn(`[${now()}] round ${round} died (${msg}) — sleeping ${Math.round(wait / 60000)}m`)
      await sleep(wait)
    }
  }

  const [{ count: insights }, { count: claims }] = await Promise.all([
    db.from('raw_insights').select('*', { count: 'exact', head: true }),
    db.from('claims').select('*', { count: 'exact', head: true }).eq('status', 'active'),
  ])
  console.log(`\n[${now()}] STOP — ${insights} raw insights, ${claims} active claims. ${formatCliStats()}`)
  console.log(
    pauseCount
      ? `[${now()}] usage-limit pauses: ${pauseCount}, ${mins(pausedMs)} lost in total.`
      : `[${now()}] usage-limit pauses: none.`
  )
  for (const [id, reason] of quarantined) console.log(`[${now()}] quarantined job ${id} — ${reason}`)
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
