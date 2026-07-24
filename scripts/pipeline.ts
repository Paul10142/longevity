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
 *   progress [--watch]   Per-source rebuild progress, throughput and ETA
 *                        (DB only — safe to poll while a drain is running)
 *   novelty              Per-source novel / refinement / redundant breakdown
 *                        (spec §9 — the engine's dedup value made visible)
 *   sources [--limit N]  List ingestable sources from the Attia YouTube channel
 *                        feed + site RSS, marking what is already in the library
 *   ingest <id|url> …    Register YouTube source(s) WITH timing (start_ms
 *                        deep-links). Does NOT queue extraction — breadth ingest
 *                        is Phase 4 and gated on the cost checkpoint, so spend
 *                        stays a separate, deliberate `extract` step.
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
  const { selectAllPaged } = await import('../lib/pagination')

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

  /**
   * Per-source view of a corpus rebuild, with observed throughput and an ETA.
   *
   * `status` answers "is anything queued"; this answers "how far along is the
   * run, and when does it land" — the question a multi-hour re-extraction
   * actually raises. Reads only tables (no LLM), so it is safe to poll while the
   * drain is running and costs nothing.
   */
  async function progress() {
    const WINDOW_MIN = 15 // throughput window; long enough to survive one slow chunk
    const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString()

    type Src = { id: string; title: string; processing_status: string | null }
    type Insight = { id: string; source_id: string; created_at: string }
    type Member = { raw_insight_id: string; created_at: string }
    type QJob = { type: string; status: string; payload: Record<string, unknown>; progress: Record<string, unknown> }

    // Every one of these grows with the corpus and is used for counting, so all
    // of them page. `.range(0, 49_999)` does NOT lift the 1000-row server cap —
    // it silently returns 1000, which would under-report the run's own progress.
    const [srcRes, chunks, insights, members, jobRes] = await Promise.all([
      db.from('sources').select('id, title, processing_status').order('created_at'),
      selectAllPaged<{ source_id: string }>(
        (f, t) => db.from('chunks').select('source_id').order('id', { ascending: true }).range(f, t)
      ),
      selectAllPaged<Insight>(
        (f, t) => db.from('raw_insights').select('id, source_id, created_at').order('created_at', { ascending: true }).range(f, t)
      ),
      selectAllPaged<Member>(
        (f, t) => db.from('claim_members').select('raw_insight_id, created_at').order('created_at', { ascending: true }).range(f, t)
      ),
      db.from('jobs').select('type, status, payload, progress').in('status', ['queued', 'running']),
    ])

    const sources = (srcRes.data ?? []) as Src[]
    const jobs = (jobRes.data ?? []) as QJob[]

    const chunkTotal = new Map<string, number>()
    for (const c of chunks) {
      chunkTotal.set(c.source_id, (chunkTotal.get(c.source_id) ?? 0) + 1)
    }
    const sourceOfInsight = new Map(insights.map(i => [i.id, i.source_id]))
    const memberSet = new Set(members.map(m => m.raw_insight_id))

    // In-flight chunk position comes from the extract job's checkpoint — the
    // chunks table only tells us the total. Only an *extract_source* job means
    // extraction is outstanding; a queued consolidate job for the same source
    // does not (that source is already fully extracted).
    const chunkDone = new Map<string, number>()
    const extracting = new Set<string>()
    for (const j of jobs) {
      if (j.type !== 'extract_source') continue
      const sid = j.payload?.source_id as string | undefined
      if (!sid) continue
      extracting.add(sid)
      chunkDone.set(sid, Number(j.progress?.chunk_index ?? 0))
    }

    const perSource = sources.map(s => {
      const mine = insights.filter(i => i.source_id === s.id)
      const total = chunkTotal.get(s.id) ?? 0
      const consolidated = mine.filter(i => memberSet.has(i.id)).length
      return {
        title: s.title.length > 34 ? `${s.title.slice(0, 33)}…` : s.title,
        chunks: extracting.has(s.id) ? `${chunkDone.get(s.id) ?? 0}/${total}` : `${total}/${total}`,
        extracted: mine.length,
        consolidated,
        done: !extracting.has(s.id) && mine.length > 0 && consolidated === mine.length,
      }
    })

    console.log(`\nCORPUS REBUILD — ${new Date().toISOString().slice(11, 19)}Z\n`)
    console.log(`  ${'source'.padEnd(35)}${'chunks'.padEnd(10)}${'insights'.padEnd(10)}consolidated`)
    for (const r of perSource) {
      console.log(
        `  ${r.title.padEnd(35)}${r.chunks.padEnd(10)}${String(r.extracted).padEnd(10)}` +
        `${r.consolidated}/${r.extracted}${r.done ? '  ✓' : ''}`
      )
    }

    // Observed throughput over the window — the only honest basis for an ETA,
    // since chunk cost varies with transcript density and the CLI throttles.
    const extractedRecently = insights.filter(i => i.created_at >= since).length
    const adjudicatedRecently = members.filter(m => m.created_at >= since).length
    const insightsPerMin = extractedRecently / WINDOW_MIN
    const adjPerMin = adjudicatedRecently / WINDOW_MIN

    const chunksLeft = sources.reduce(
      (n, s) => (extracting.has(s.id) ? n + Math.max(0, (chunkTotal.get(s.id) ?? 0) - (chunkDone.get(s.id) ?? 0)) : n),
      0
    )
    // Insights a remaining chunk will add, measured over the sources this run has
    // ALREADY finished extracting. Counting every insight against only the
    // in-flight job's chunk index inflates the yield several-fold.
    let doneInsights = 0
    let doneChunks = 0
    for (const s of sources) {
      if (extracting.has(s.id)) continue
      const n = insights.filter(i => i.source_id === s.id).length
      if (n === 0) continue
      doneInsights += n
      doneChunks += chunkTotal.get(s.id) ?? 0
    }
    const yieldPerChunk = doneChunks > 0 ? doneInsights / doneChunks : 4
    const pendingNow = insights.filter(i => !memberSet.has(i.id)).length
    const toAdjudicate = pendingNow + Math.round(chunksLeft * yieldPerChunk)

    // Fallbacks so the ETA survives a phase that has not started yet: extraction
    // and consolidation alternate, so one of the two rates is usually 0.
    const OBSERVED_INSIGHTS_PER_MIN = 4.3 // this run, 2026-07-24
    const OBSERVED_ADJ_PER_MIN = 5.5      // ~11s per adjudication via the claude CLI
    const exRate = insightsPerMin > 0 ? insightsPerMin : OBSERVED_INSIGHTS_PER_MIN
    const adjRate = adjPerMin > 0 ? adjPerMin : OBSERVED_ADJ_PER_MIN
    const estimated = insightsPerMin === 0 || adjPerMin === 0 ? '  (one phase idle — partly from prior rates)' : ''

    const running = jobs.filter(j => j.status === 'running').map(j => j.type)
    console.log(`\n  in flight   ${running.length ? running.join(', ') : 'nothing running'} · ${jobs.length} job(s) open`)
    console.log(`  throughput  ${insightsPerMin.toFixed(1)} insights/min extracted · ${adjPerMin.toFixed(1)} adjudications/min`)
    console.log(`  remaining   ~${chunksLeft} chunk(s) to extract, ~${toAdjudicate} insight(s) to adjudicate`)
    const eta = (chunksLeft * yieldPerChunk) / exRate + toAdjudicate / adjRate
    console.log(`  eta         ~${Math.floor(eta / 60)}h ${Math.round(eta % 60)}m${estimated}`)
    console.log()
  }

  switch (command) {
    case 'status':
      await status()
      return

    case 'novelty': {
      // Novelty report (spec §9): the engine's dedup value, made visible.
      // Per source, classify each of its insights into three buckets:
      //   redundant  — merged into a claim it did not seed (added nothing new)
      //   refinement — seeded a claim that is near_duplicate-linked to existing
      //                material (a new dose/population/caveat on a known idea —
      //                the engine's REAL value, counted as partially redundant)
      //   novel      — seeded a claim with no such link (genuinely new ground)
      // The headline "% new" is the novel bucket; the dedup story is redundant +
      // refinement. Read-only, no LLM.
      const [insRows, memRows, linkRows, srcRes] = await Promise.all([
        selectAllPaged<{ id: string; source_id: string }>(
          (f, t) => db.from('raw_insights').select('id, source_id').order('created_at', { ascending: true }).range(f, t)
        ),
        selectAllPaged<{ raw_insight_id: string; claim_id: string; matched_by: string }>(
          (f, t) => db.from('claim_members').select('raw_insight_id, claim_id, matched_by').order('created_at', { ascending: true }).range(f, t)
        ),
        selectAllPaged<{ claim_id: string; related_claim_id: string }>(
          (f, t) => db.from('claim_links').select('claim_id, related_claim_id').eq('kind', 'near_duplicate').order('claim_id', { ascending: true }).range(f, t)
        ),
        db.from('sources').select('id, title').order('created_at'),
      ])
      const srcRows = (srcRes.data ?? []) as { id: string; title: string }[]
      const memByInsight = new Map(memRows.map(m => [m.raw_insight_id, m]))
      const linkedClaims = new Set<string>()
      for (const l of linkRows) { linkedClaims.add(l.claim_id); linkedClaims.add(l.related_claim_id) }
      const titleById = new Map(srcRows.map(s => [s.id, s.title]))

      type Bucket = { redundant: number; refinement: number; novel: number; unconsolidated: number }
      const bySource = new Map<string, Bucket>()
      for (const ins of insRows) {
        const b = bySource.get(ins.source_id) ?? { redundant: 0, refinement: 0, novel: 0, unconsolidated: 0 }
        const m = memByInsight.get(ins.id)
        if (!m) b.unconsolidated++
        else if (m.matched_by !== 'seed') b.redundant++       // merged into an existing claim
        else if (linkedClaims.has(m.claim_id)) b.refinement++ // seeded, but a variant of known material
        else b.novel++                                        // seeded new ground
        bySource.set(ins.source_id, b)
      }

      const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')
      console.log(`\nNOVELTY — what each source ADDED to the library (spec §9)\n`)
      console.log(`  ${'source'.padEnd(36)}${'total'.padEnd(8)}${'novel'.padEnd(9)}${'refine'.padEnd(9)}${'redund'.padEnd(9)}`)
      const tot: Bucket = { redundant: 0, refinement: 0, novel: 0, unconsolidated: 0 }
      for (const [sid, b] of bySource) {
        const total = b.redundant + b.refinement + b.novel + b.unconsolidated
        if (total === 0) continue
        tot.redundant += b.redundant; tot.refinement += b.refinement; tot.novel += b.novel; tot.unconsolidated += b.unconsolidated
        const title = (titleById.get(sid) ?? sid).slice(0, 34)
        console.log(`  ${title.padEnd(36)}${String(total).padEnd(8)}${pct(b.novel, total).padEnd(9)}${pct(b.refinement, total).padEnd(9)}${pct(b.redundant, total).padEnd(9)}`)
      }
      const gt = tot.redundant + tot.refinement + tot.novel + tot.unconsolidated
      console.log(`\n  ${'CORPUS'.padEnd(36)}${String(gt).padEnd(8)}${pct(tot.novel, gt).padEnd(9)}${pct(tot.refinement, gt).padEnd(9)}${pct(tot.redundant, gt).padEnd(9)}`)
      console.log(`\n  novel ${tot.novel} · refinement ${tot.refinement} · redundant ${tot.redundant}` +
        (tot.unconsolidated ? ` · ${tot.unconsolidated} not yet consolidated` : ''))
      console.log(`  Refinement + redundant = ${pct(tot.refinement + tot.redundant, gt)} is the engine's dedup work;`)
      console.log(`  novel = ${pct(tot.novel, gt)} is genuinely new ground. (Refinement grows as near-duplicate`)
      console.log(`  links accrue — only sources consolidated AFTER 2026-07-24 carry them.)\n`)
      return
    }

    case 'sources': {
      // Show what is available to ingest, and what is already in the library.
      const { fetchChannelVideos, fetchSiteFeed } = await import('../lib/sourceDiscovery')
      const limit = arg === '--limit' ? Number(process.argv[4]) || 15 : 15

      const { data: existing } = await db.from('sources').select('external_id, url, title')
      const haveIds = new Set(
        ((existing ?? []) as { external_id: string | null; url: string | null }[])
          .flatMap(s => [s.external_id, s.url?.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1]])
          .filter(Boolean) as string[]
      )

      const videos = await fetchChannelVideos(undefined, limit)
      console.log(`\nYOUTUBE CHANNEL — ${videos.length} recent upload(s)\n`)
      for (const v of videos) {
        const mark = haveIds.has(v.videoId) ? '✓ in library' : '  new'
        console.log(`  ${mark}  ${v.videoId}  ${v.published ?? '          '}  ${v.title.slice(0, 62)}`)
      }

      // Full episodes are the high-value ingest target — the channel feed is
      // mostly short promo clips cut from them, which add little but dedup work.
      const { discoverEpisodes } = await import('../lib/sourceDiscovery')
      const episodes = await discoverEpisodes(limit)
      console.log(`\nFULL EPISODES (site feed → resolved YouTube video)\n`)
      for (const e of episodes) {
        const mark = e.videoId && haveIds.has(e.videoId) ? '✓ in library' : e.videoId ? '  new' : '  no video'
        console.log(`  ${mark}  ${(e.videoId ?? '—').padEnd(12)} ${e.published ?? '          '}  ${e.title.slice(0, 56)}`)
      }

      const posts = await fetchSiteFeed(limit)
      console.log(`\nSITE FEED — ${posts.length} recent post(s)\n`)
      for (const p of posts) {
        console.log(`  ${p.published ?? '          '}  ${p.title.slice(0, 68)}`)
      }
      console.log(`\nIngest one with:  npm run pipeline -- ingest <videoId|url>`)
      console.log(`Ingest registers the source only — extraction stays a separate, deliberate step.\n`)
      return
    }

    case 'ingest': {
      // Register a YouTube source WITH its timing, but do not queue extraction.
      // Deliberate: breadth ingest is Phase 4 in the sequencing authority and is
      // gated on the cost checkpoint, so adding a source must never silently
      // start spending on extraction + adjudication.
      if (!arg) throw new Error('usage: npm run pipeline -- ingest <videoId|youtubeUrl> [more…]')
      const { fetchTimedTranscript, discoverEpisodes, parseGuests } = await import('../lib/sourceDiscovery')
      const { extractYouTubeVideoId } = await import('../lib/youtubeUtils')

      const targets = process.argv.slice(3).filter(a => !a.startsWith('--'))
      // Reject promo clips by transcript length. The channel is mostly 2-minute
      // cuts from full episodes; those add no knowledge the episode lacks and
      // leave consolidation to dedup them against it. A full episode runs ~90k
      // chars, a clip ~5k, so the split is unambiguous. --min-chars 0 disables.
      const minCharsFlag = process.argv.indexOf('--min-chars')
      const minChars = minCharsFlag > -1 ? Number(process.argv[minCharsFlag + 1]) : 20_000
      // The SITE feed titles carry the guest reliably (`… | Gayatri Devi, M.D.`);
      // the YouTube title often drops it. Resolve once and prefer it, so the
      // experts layer (spec §5.5) gets its names at ingest rather than needing a
      // re-ingest later.
      const episodeByVideo = new Map<string, string>()
      try {
        for (const e of await discoverEpisodes(20)) {
          if (e.videoId) episodeByVideo.set(e.videoId, e.title)
        }
      } catch {
        // Feed unreachable — fall back to the YouTube title. Not fatal.
      }
      for (const target of targets) {
        const videoId = extractYouTubeVideoId(target) ?? target
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          console.log(`  ✗ ${target}: not a YouTube video id or URL`)
          continue
        }
        const { data: dupe } = await db
          .from('sources').select('id, title').eq('external_id', videoId).maybeSingle()
        if (dupe) {
          console.log(`  · ${videoId}: already ingested — ${(dupe as { title: string }).title.slice(0, 50)}`)
          continue
        }
        try {
          const t = await fetchTimedTranscript(videoId)
          if (t.transcript.length < minChars) {
            console.log(`  · ${videoId}: skipped — ${t.transcript.length.toLocaleString()} chars, below --min-chars ${minChars.toLocaleString()} (promo clip)`)
            continue
          }
          const siteTitle = episodeByVideo.get(videoId)
          const title = siteTitle ?? t.title ?? `YouTube ${videoId}`
          const guests = parseGuests(siteTitle ?? t.title ?? '')
          const { data: inserted, error } = await db.from('sources').insert({
            type: 'video',
            title,
            authors: ['Dr. Peter Attia', ...guests],
            date: t.date,
            url: t.url,
            external_id: videoId,
            transcript: t.transcript,
            timed_transcript: t.segments,
            media_type: 'video',
            media_url: t.url,
            transcript_origin: 'other', // youtube-transcript.io captions
            // 'medium', not 'high': these are auto-generated captions, so they
            // carry mis-transcriptions (drug names and numbers especially) that a
            // human-checked transcript would not. Transcript hygiene strips ads
            // and intros, but it cannot fix a misheard dose.
            transcript_quality: 'medium',
            authority_tier: 'expert',
            processing_status: 'pending',
          }).select('id').single()
          if (error) throw new Error(error.message)
          console.log(
            `  ✓ ${videoId}: ${title.slice(0, 46)} — ` +
            `${t.transcript.length.toLocaleString()} chars, ${t.segments.length} timed segment(s)` +
            `${guests.length ? `, guest(s): ${guests.join(', ')}` : ''} → ${(inserted as { id: string }).id}`
          )
        } catch (err) {
          console.log(`  ✗ ${videoId}: ${err instanceof Error ? err.message : err}`)
        }
      }
      console.log(`\nRegistered as 'pending'. To process one: npm run pipeline -- extract <source_id>\n`)
      return
    }

    case 'progress': {
      // `--watch` redraws until interrupted — the drain is a multi-hour run and
      // this is the window onto it.
      if (arg !== '--watch') {
        await progress()
        return
      }
      for (;;) {
        process.stdout.write('\x1b[2J\x1b[H')
        await progress()
        await new Promise(r => setTimeout(r, 30_000))
      }
    }

    case 'extract': {
      if (!arg) throw new Error('usage: npm run pipeline -- extract <source_id>')
      const { error } = await db
        .from('raw_insights')
        .delete()
        .eq('source_id', arg)
      if (error) throw new Error(`Failed to clear prior insights: ${error.message}`)
      // `claim_members.raw_insight_id` is ON DELETE CASCADE, so that delete just
      // stripped this source's members off every claim they belonged to. Nothing
      // recomputes those claims: a fully-emptied one stays `active` with a stale
      // member_count and remains a live `match_claims` candidate, so the
      // re-extracted insights would merge back into a ghost claim whose canonical
      // came from the discarded run — and `topic_claims` would keep serving it.
      // A partly-emptied one stays correctly active but over-reports its
      // corroboration. Reconcile both (migration 012); nothing is deleted.
      const { data: reconciled, error: reconcileErr } = await db.rpc('reconcile_claim_membership')
      if (reconcileErr) throw new Error(`Failed to reconcile claim membership: ${reconcileErr.message}`)
      const { recounted = 0, retired = 0 } = (reconciled ?? {}) as { recounted?: number; retired?: number }
      if (recounted || retired) {
        console.log(`Reconciled claims after the delete: ${retired} retired (no members left), ${recounted} recounted.`)
      }
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
      // Spend guard: cap total expensive synthesis jobs across the whole drain so
      // a stray library-wide queue can't run up $100s locally unasked. Overridable.
      const maxSynth = Number(process.env.MAX_SYNTHESIS_JOBS ?? 50)
      console.log(`Draining queue via ${process.env.LLM_BACKEND} (synthesis cap ${maxSynth})…\n`)
      let total = 0
      let synth = 0
      for (;;) {
        // Long budget: unlike Vercel there is no invocation ceiling locally.
        const { processed, synthesisProcessed } = await runWorkerTick(15 * 60_000)
        total += processed
        synth += synthesisProcessed
        if (processed === 0) break
        if (synth >= maxSynth) {
          console.log(`\n⚠︎ Spend guard: stopped after ${synth} synthesis job(s) (MAX_SYNTHESIS_JOBS=${maxSynth}). Remaining stay queued — raise the env to continue a deliberate build.`)
          break
        }
        console.log(`  …${total} jobs processed`)
      }
      console.log(`\nDone — ${total} job${total === 1 ? '' : 's'} processed.\n`)
      await status()
      return
    }

    default:
      console.log('usage: npm run pipeline -- <work|extract <source_id>|ingest <videoId…>|sources|discover|sweep|status|progress [--watch]>')
      process.exit(1)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
