/**
 * Overnight breadth-extraction supervisor.
 *
 * Drives the newly-ingested pending sources through extract + consolidate (dedup)
 * on the local subscription CLI, resiliently across Claude usage-limit resets:
 * when a drain makes no progress (calls failing under a 5-hour limit), it heals
 * failed jobs and sleeps, then retries — so an overnight run survives limit
 * windows instead of dying on them.
 *
 * Deliberately deferred for throughput (all reversible later passes):
 *   SKIP_TAGGING=1          — claims stay needs_tagging; one bulk re-tag/discover
 *                             pass later (roots stay Paul-gated), no per-source churn.
 *   SKIP_SYNTHESIS_FANOUT=1 — no article regen (deferred to the Phase 3 rewrite).
 *   SKIP_REFERENCES=1       — the reference pass ~doubles per-source cost; later.
 *
 * SAFETY: only enqueues extract_source for sources with ZERO raw_insights. A
 * fresh extract_source job on a source that already has insights would APPEND a
 * second copy (the delete/reconcile only happens via `pipeline extract`, not a
 * bare job) — so the 0-insight filter is the guard, never remove it.
 *
 *   caffeinate -dimsu npx tsx --env-file=.env.local scripts/overnightExtract.ts [--hours N] [--max-sources N]
 */
export {} // module marker: keep `main` file-scoped, not a global (collides with pipeline.ts otherwise)

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
process.env.SKIP_TAGGING = process.env.SKIP_TAGGING || '1'
process.env.SKIP_SYNTHESIS_FANOUT = process.env.SKIP_SYNTHESIS_FANOUT || '1'
process.env.SKIP_REFERENCES = process.env.SKIP_REFERENCES || '1'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString().slice(11, 19)

async function main() {
  const args = process.argv.slice(2)
  const hours = num(args, '--hours') ?? 10
  const maxSources = num(args, '--max-sources') ?? 10_000
  // Enqueue in small batches and drain each to idle before the next, so the jobs
  // queue never holds a big backlog (the daily Vercel cron would otherwise try
  // these on the credit-less API backend, and a killed run would strand hundreds
  // of queued jobs). Each source also finishes (extract+consolidate) before we
  // move on, rather than extracting everything then consolidating.
  const batch = num(args, '--batch') ?? 4
  // Storage safety brake. Originally sized for the free plan's 500 MB read-only
  // lock; the org moved to Pro (8 GB included) on 2026-08-14, so the default is
  // now 6000 MB — still a runaway guard, but far above the ~1.1 GB the full
  // 249-source catalogue is projected to need (~4.5 MB/source). Pass --max-mb to
  // override. NOTE: on Pro this is a cost guard, not a lock — exceeding the
  // included disk bills extra rather than halting the database.
  const maxMb = num(args, '--max-mb') ?? 6000
  const deadline = Date.now() + hours * 3_600_000

  const { enqueueJob } = await import('../lib/jobs')
  const { runWorkerTick } = await import('../lib/worker')
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  console.log(`[${now()}] overnight extract — deadline in ${hours}h, cap ${maxSources} sources`)
  console.log(`  flags: SKIP_TAGGING=${process.env.SKIP_TAGGING} SKIP_SYNTHESIS_FANOUT=${process.env.SKIP_SYNTHESIS_FANOUT} SKIP_REFERENCES=${process.env.SKIP_REFERENCES}`)

  // Sources that already carry insights — never re-enqueue (would double them).
  async function extractedSourceIds(): Promise<Set<string>> {
    const rows = await selectAllPaged<{ source_id: string }>(
      (from, to) => db.from('raw_insights').select('source_id').range(from, to)
    )
    return new Set(rows.map(r => r.source_id))
  }

  async function freshPending(extracted: Set<string>): Promise<string[]> {
    const rows = await selectAllPaged<{ id: string }>(
      (from, to) => db.from('sources').select('id').eq('processing_status', 'pending').order('date', { ascending: false }).range(from, to)
    )
    return rows.map(r => r.id).filter(id => !extracted.has(id))
  }

  async function openJobs(): Promise<number> {
    const { count } = await db.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['queued', 'running'])
    return count ?? 0
  }

  async function dbSizeMb(): Promise<number> {
    const { data, error } = await db.rpc('database_size_bytes')
    // Fail OPEN: a transient read error must not halt a healthy extraction. The
    // external monitor is a second line of defence, and the cap is far off.
    if (error || data == null) { console.log(`[${now()}] (db size check failed: ${error?.message ?? 'null'})`); return 0 }
    return Number(data) / (1024 * 1024)
  }

  // Heal jobs that failed under a usage limit so they retry after a reset.
  async function healFailed(): Promise<number> {
    const { data } = await db.from('jobs')
      .update({ status: 'queued', run_after: new Date().toISOString(), locked_at: null })
      .eq('status', 'failed')
      .in('type', ['extract_source', 'consolidate_source'])
      .select('id')
    return (data ?? []).length
  }

  let enqueuedTotal = 0
  let round = 0
  let idleStreak = 0
  let failStreak = 0
  let lastExtractedCount = -1
  while (Date.now() < deadline) {
    // A round that dies mid-flight (total network blip: Supabase `fetch failed`
    // AND the CLI unreachable at once) must not kill an unattended overnight
    // run — the 2026-08-15 22:22 blip took the whole supervisor down within a
    // minute of launch. Treat it like a no-progress round: whatever job it was
    // on is failed (healFailed requeues it) or its lock goes stale (reclaimed
    // >10 min), so backing off and retrying loses nothing. The deadline stays
    // the ultimate bound, mirroring the usage-limit idleStreak design.
    try {
    round++
    const mb = await dbSizeMb()
    if (mb >= maxMb) {
      console.log(`[${now()}] STOP — database at ${mb.toFixed(0)} MB ≥ ${maxMb} MB safety cap. Pass a higher --max-mb to continue (on Pro this is a cost guard: 8 GB is included, beyond that bills extra).`)
      break
    }
    const healed = await healFailed()
    if (healed) console.log(`[${now()}] healed ${healed} failed job(s) → requeued`)

    const extracted = await extractedSourceIds()
    const remainingPending = await freshPending(extracted)
    // Only enqueue a small batch this round (respecting the total cap).
    const room = Math.max(0, maxSources - enqueuedTotal)
    // Back-pressure: when the last round healed failures and completed no new
    // source, the CLI is likely down (usage-limit window). Enqueueing more
    // sources then just bloats the queue with jobs that will fail the same way
    // — the 2026-08-15 outage stacked 27 open jobs like that. Drain what exists;
    // resume enqueueing once something actually completes.
    const stalled = healed > 0 && extracted.size === lastExtractedCount
    lastExtractedCount = extracted.size
    const fresh = stalled ? [] : remainingPending.slice(0, Math.min(batch, room))
    if (stalled) console.log(`[${now()}] stalled (healed ${healed}, no new sources) — pausing fresh enqueues this round`)

    for (const id of fresh) {
      const { deduped } = await enqueueJob('extract_source', { source_id: id })
      if (!deduped) enqueuedTotal++
    }
    const jobs = await openJobs()
    console.log(`[${now()}] round ${round}: ${extracted.size} sources extracted, ${fresh.length} fresh enqueued this round, ${jobs} open job(s)`)

    if (jobs === 0 && fresh.length === 0) {
      console.log(`[${now()}] no remaining work — done.`)
      break
    }

    // Drain within the current window.
    let processed = 0
    for (;;) {
      const { processed: p } = await runWorkerTick(15 * 60_000)
      processed += p
      if (p === 0) break
      if (Date.now() >= deadline) break
    }
    console.log(`[${now()}] round ${round}: drained ${processed} job(s)`)

    if (processed === 0) {
      idleStreak++
      // No progress — most likely a usage-limit window. Back off and retry.
      const wait = Math.min(15 * 60_000, 3 * 60_000 * idleStreak)
      console.log(`[${now()}] no progress (streak ${idleStreak}) — sleeping ${Math.round(wait / 60000)}m before retry (limit reset?)`)
      await sleep(wait)
    } else {
      idleStreak = 0
    }
    failStreak = 0
    } catch (err) {
      failStreak++
      const wait = Math.min(15 * 60_000, 3 * 60_000 * failStreak)
      const msg = err instanceof Error ? err.message.slice(0, 160) : String(err)
      console.warn(`[${now()}] round ${round} died (${msg}) — sleeping ${Math.round(wait / 60000)}m before retry (network blip? streak ${failStreak})`)
      await sleep(wait)
    }
  }

  // Final tally.
  const [{ count: claims }, { count: insights }, extractedNow] = await Promise.all([
    db.from('claims').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('raw_insights').select('*', { count: 'exact', head: true }),
    extractedSourceIds(),
  ])
  console.log(`\n[${now()}] STOP — ${enqueuedTotal} source(s) enqueued this run; ${extractedNow.size} sources now have insights; ${insights} raw insights; ${claims} active claims.`)
}

function num(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag)
  return i > -1 ? Number(args[i + 1]) : undefined
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
