/**
 * Local pipeline runner.
 *
 *   npm run pipeline -- <command> [args]
 *
 * Drains the same `jobs` queue the deployed worker uses, but in-process on this
 * machine. With `LLM_BACKEND=claude-code` (the default here) every generative
 * call shells out to the local `claude` CLI, so the work bills your Claude
 * subscription instead of API credits. Embeddings still call OpenAI — Anthropic
 * has no embeddings model, and dedup/tagging need vectors.
 *
 * Commands:
 *   work                 Drain the queue until empty (the usual one)
 *   extract <source_id>  Queue a re-extraction for one source
 *   discover             Queue a topic-discovery pass
 *   sweep                Queue a claim-dedup sweep
 *   status               Print queue + library counts and exit
 *
 * Examples:
 *   npm run pipeline -- status
 *   npm run pipeline -- discover && npm run pipeline -- work
 *   LLM_BACKEND=api npm run pipeline -- work     # bill API credits instead
 */

// Env comes from `--env-file=.env.local` in the npm script (Node 20.6+ builtin).

// Default to the subscription-backed CLI; override with LLM_BACKEND=api.
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

async function main() {
  const [command, arg] = process.argv.slice(2)

  // Imported after env is loaded — these modules read env at module scope.
  const { enqueueJob } = await import('../lib/jobs')
  const { runWorkerTick } = await import('../lib/worker')
  const { supabaseAdmin } = await import('../lib/supabaseServer')

  if (!supabaseAdmin) {
    console.error('Supabase not configured — check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local')
    process.exit(1)
  }
  const db = supabaseAdmin

  async function status() {
    const [jobs, claims, insights, topics] = await Promise.all([
      db.from('jobs').select('type, status').in('status', ['queued', 'running', 'failed']),
      db.from('claims').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      db.from('raw_insights').select('*', { count: 'exact', head: true }),
      db.from('topics').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    ])
    const byStatus: Record<string, number> = {}
    for (const j of (jobs.data ?? []) as { type: string; status: string }[]) {
      byStatus[`${j.status}:${j.type}`] = (byStatus[`${j.status}:${j.type}`] || 0) + 1
    }
    console.log(`backend       ${process.env.LLM_BACKEND}`)
    console.log(`raw insights  ${insights.count ?? 0}`)
    console.log(`claims        ${claims.count ?? 0}`)
    console.log(`topics        ${topics.count ?? 0}`)
    const entries = Object.entries(byStatus)
    console.log(`jobs          ${entries.length === 0 ? 'idle' : ''}`)
    for (const [k, v] of entries) console.log(`  ${k.padEnd(28)} ${v}`)
  }

  switch (command) {
    case 'status':
      await status()
      return

    case 'extract': {
      if (!arg) throw new Error('usage: npm run pipeline -- extract <source_id>')
      const { error } = await db
        .from('raw_insights')
        .delete()
        .eq('source_id', arg)
      if (error) throw new Error(`Failed to clear prior insights: ${error.message}`)
      await db.from('sources').update({ processing_status: 'pending', processing_error: null }).eq('id', arg)
      await enqueueJob('extract_source', { source_id: arg })
      console.log(`Queued extract_source for ${arg}. Run: npm run pipeline -- work`)
      return
    }

    case 'discover': {
      // Dry run proposes without writing, so the taxonomy stays curated.
      if (arg === '--dry-run') {
        const { discoverTopics } = await import('../lib/taxonomy')
        console.log('Proposing topics (dry run — nothing will be written)…\n')
        let n = 0
        const res = await discoverTopics(undefined, async () => {}, 15 * 60_000, {
          dryRun: true,
          onPropose: p => {
            n++
            console.log(`  ${p.name}${p.parent ? `  (under ${p.parent})` : '  (new top-level)'}`)
            if (p.rationale) console.log(`      ${p.rationale}`)
            console.log(`      from: ${p.batch}\n`)
          },
        })
        console.log(n === 0 ? 'No new topics proposed.' : `${res.checkpoint.topics_created} topic(s) proposed.`)
        console.log('\nTo apply: npm run pipeline -- discover && npm run pipeline -- work')
        return
      }
      await enqueueJob('discover_topics', {})
      console.log('Queued discover_topics. Run: npm run pipeline -- work')
      return
    }

    case 'sweep':
      await enqueueJob('claim_sweep', {})
      console.log('Queued claim_sweep. Run: npm run pipeline -- work')
      return

    case 'work': {
      console.log(`Draining queue via ${process.env.LLM_BACKEND}…\n`)
      let total = 0
      for (;;) {
        // Long budget: unlike Vercel there is no invocation ceiling locally.
        const { processed } = await runWorkerTick(15 * 60_000)
        total += processed
        if (processed === 0) break
        console.log(`  …${total} jobs processed`)
      }
      console.log(`\nDone — ${total} job${total === 1 ? '' : 's'} processed.\n`)
      await status()
      return
    }

    default:
      console.log('usage: npm run pipeline -- <work|extract <source_id>|discover|sweep|status>')
      process.exit(1)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
