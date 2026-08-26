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

  const { enqueueJob } = await import('../lib/jobs')
  const { runWorkerTick } = await import('../lib/worker')
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { selectAllPaged } = await import('../lib/pagination')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const db = supabaseAdmin

  console.log(`[${now()}] deepgram extraction — deadline in ${hours}h, batch ${batch}`)

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

  async function openJobs(): Promise<number> {
    const { count } = await db.from('jobs').select('*', { count: 'exact', head: true }).in('status', ['queued', 'running'])
    return count ?? 0
  }

  /** Heal jobs that failed on a transport blip so they retry. */
  async function healFailed(): Promise<number> {
    const { data } = await db
      .from('jobs')
      .update({ status: 'queued', run_after: new Date().toISOString(), locked_at: null })
      .eq('status', 'failed')
      .in('type', ['extract_source', 'consolidate_source'])
      .select('id')
    return (data ?? []).length
  }

  let round = 0
  let idleStreak = 0
  let failStreak = 0
  let lastExtracted = -1

  while (Date.now() < deadline) {
    try {
      round++
      const healed = await healFailed()
      if (healed) console.log(`[${now()}] healed ${healed} failed job(s)`)

      const extracted = await extractedIds()
      const remaining = await pendingGoodTranscripts(extracted)

      // Back-pressure: if the last round healed failures and completed nothing,
      // the CLI is probably in a usage-limit window. Drain what exists rather
      // than stacking more jobs that will fail the same way.
      const stalled = healed > 0 && extracted.size === lastExtracted
      lastExtracted = extracted.size
      const fresh = stalled ? [] : remaining.slice(0, batch)
      if (stalled) console.log(`[${now()}] stalled — pausing fresh enqueues this round`)

      for (const id of fresh) await enqueueJob('extract_source', { source_id: id })

      const open = await openJobs()
      console.log(
        `[${now()}] round ${round}: ${remaining.length} source(s) left, ` +
          `${fresh.length} enqueued, ${open} open job(s)`
      )
      if (open === 0 && fresh.length === 0) {
        console.log(`[${now()}] no remaining work — done.`)
        break
      }

      let processed = 0
      for (;;) {
        const { processed: p } = await runWorkerTick(15 * 60_000)
        processed += p
        if (p === 0 || Date.now() >= deadline) break
      }
      console.log(`[${now()}] round ${round}: drained ${processed} job(s)`)

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
  console.log(`\n[${now()}] STOP — ${insights} raw insights, ${claims} active claims.`)
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
