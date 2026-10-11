/**
 * Dedup RECALL benchmark on the twin episodes — the closest thing the corpus
 * has to "the same notes taken twice".
 *
 *   npx tsx --env-file=.env.local scripts/evalTwinRecall.ts [--judge N] [--k 8]
 *
 * Read-only: nothing is merged, written, or queued.
 *
 * THE QUESTION. Paul's standard for the engine is a diligent note-taker: when a
 * new source repeats a fact the library already holds, the fact is attached to
 * the existing claim (corroboration), and only genuinely new facts become new
 * claims. Some episodes exist twice — a YouTube-caption transcript extracted in
 * July/August and the same episode's Deepgram transcript extracted later — so
 * the second copy's facts SHOULD mostly have merged into the first. The share
 * that did is the engine's recall on known repeats.
 *
 * Two transcripts of one episode do not yield identical facts, so 100% is not
 * the ceiling; the number is a floor on what the gate is losing, not a count of
 * duplicates.
 *
 * Part 1 (no LLM): for every Deepgram insight on a twin episode, did it land in a
 * claim that also holds a caption-twin insight? For the misses, how similar is
 * the closest caption-twin claim (cosine, computed locally from the stored
 * embeddings)? Bucketed by the bands the gate decision is about.
 *
 * Part 2 (--judge N, bills the subscription): sample up to N misses per band,
 * show the production adjudicator the top --k caption-twin claims by similarity
 * (ignoring the gate), and count SAME / DIFFERENT / UNSURE. The SAME rate per
 * band × the band's size is the recall a gate at that band would recover.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

type Band = '>=0.86' | '0.80-0.86' | '0.75-0.80' | '0.70-0.75' | '<0.70'
const BANDS: Band[] = ['>=0.86', '0.80-0.86', '0.75-0.80', '0.70-0.75', '<0.70']
function band(sim: number): Band {
  if (sim >= 0.86) return '>=0.86'
  if (sim >= 0.80) return '0.80-0.86'
  if (sim >= 0.75) return '0.75-0.80'
  if (sim >= 0.70) return '0.70-0.75'
  return '<0.70'
}

const args = process.argv.slice(2)
const num = (f: string, d: number): number => {
  const i = args.indexOf(f)
  return i > -1 ? Number(args[i + 1]) : d
}

type Vec = number[]
function toVec(e: unknown): Vec | null {
  if (Array.isArray(e)) return e as Vec
  if (typeof e === 'string') {
    try { return JSON.parse(e) as Vec } catch { return null }
  }
  return null
}
// Stored embeddings are unit-length (OpenAI), so cosine = dot product.
function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

async function main() {
  const judgeN = num('--judge', 0)
  const k = num('--k', 8)

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')

  // 1. Twin pairs: caption rows (title carries the episode number) ↔ extracted
  //    Deepgram rows with that episode_number.
  const captionRows = await selectAllPaged<{ id: string; title: string }>((from, to) =>
    db.from('sources').select('id, title').eq('transcript_origin', 'other').is('external_id', null)
      .eq('processing_status', 'succeeded').order('id').range(from, to)
  )
  const deepgramRows = await selectAllPaged<{ id: string; episode_number: number | null; title: string }>((from, to) =>
    db.from('sources').select('id, episode_number, title').eq('transcript_origin', 'deepgram')
      .eq('processing_status', 'succeeded').not('episode_number', 'is', null).order('id').range(from, to)
  )
  const byEpisode = new Map<number, { id: string; title: string }>()
  for (const d of deepgramRows) if (d.episode_number != null) byEpisode.set(d.episode_number, d)
  const pairs: { ep: number; capId: string; dgId: string; title: string }[] = []
  for (const c of captionRows) {
    const m = c.title.match(/^(\d{1,3})\s*[-‒–—]/)
    if (!m) continue
    const ep = Number(m[1])
    const d = byEpisode.get(ep)
    if (d) pairs.push({ ep, capId: c.id, dgId: d.id, title: d.title })
  }
  if (pairs.length === 0) throw new Error('no twin episodes found')
  console.log(`twin episodes: ${pairs.length} — ${pairs.map(p => `#${p.ep}`).join(', ')}\n`)

  type Insight = { id: string; source_id: string; statement: string; context_note: string | null; embedding: unknown }
  // The vector comes from the side table (migration 029), embedded one-to-one;
  // PostgREST returns it as an object, some client versions as a 1-element array.
  type Claim = { id: string; canonical_statement: string; context_note: string | null; claim_embeddings: unknown }
  const embeddingOf = (rel: unknown): unknown =>
    Array.isArray(rel) ? (rel[0] as { embedding?: unknown } | undefined)?.embedding ?? null
      : (rel as { embedding?: unknown } | null)?.embedding ?? null

  const membership = async (insightIds: string[]): Promise<Map<string, string>> => {
    const m = new Map<string, string>()
    for (const ids of chunk(insightIds, 200)) {
      const { data, error } = await db.from('claim_members').select('raw_insight_id, claim_id').in('raw_insight_id', ids)
      if (error) throw new Error(`claim_members: ${error.message}`)
      for (const r of (data ?? []) as { raw_insight_id: string; claim_id: string }[]) m.set(r.raw_insight_id, r.claim_id)
    }
    return m
  }

  // 2. Per pair: Deepgram insights, caption insights, memberships, caption claims.
  type Miss = { ep: number; insight: Insight; bestSim: number; top: (Claim & { sim: number })[] }
  const misses: Miss[] = []
  let dgTotal = 0, merged = 0

  for (const p of pairs) {
    const dgInsights = await selectAllPaged<Insight>((from, to) =>
      db.from('raw_insights').select('id, source_id, statement, context_note, embedding').eq('source_id', p.dgId).order('id').range(from, to)
    )
    const capInsights = await selectAllPaged<{ id: string }>((from, to) =>
      db.from('raw_insights').select('id').eq('source_id', p.capId).order('id').range(from, to)
    )
    const dgMembers = await membership(dgInsights.map(i => i.id))
    const capMembers = await membership(capInsights.map(i => i.id))
    const capClaimIds = [...new Set(capMembers.values())]

    const capClaims: Claim[] = []
    for (const ids of chunk(capClaimIds, 100)) {
      const { data, error } = await db.from('claims').select('id, canonical_statement, context_note, claim_embeddings(embedding)').in('id', ids)
      if (error) throw new Error(`claims: ${error.message}`)
      capClaims.push(...((data ?? []) as Claim[]))
    }
    const capVecs = capClaims.map(c => ({ c, v: toVec(embeddingOf(c.claim_embeddings)) })).filter((x): x is { c: Claim; v: Vec } => !!x.v)
    const capClaimSet = new Set(capClaimIds)

    let pairMerged = 0
    for (const ins of dgInsights) {
      dgTotal++
      const claimId = dgMembers.get(ins.id)
      if (claimId && capClaimSet.has(claimId)) { merged++; pairMerged++; continue }
      const v = toVec(ins.embedding)
      if (!v) continue
      const scored = capVecs.map(x => ({ ...x.c, sim: cosine(v, x.v) })).sort((a, b) => b.sim - a.sim)
      misses.push({ ep: p.ep, insight: ins, bestSim: scored[0]?.sim ?? 0, top: scored.slice(0, k) })
    }
    console.log(`#${String(p.ep).padStart(3)}  ${dgInsights.length.toString().padStart(4)} deepgram insights, ${String(pairMerged).padStart(4)} merged with the caption twin (${Math.round((100 * pairMerged) / Math.max(1, dgInsights.length))}%)  ${p.title.slice(0, 60)}`)
  }

  // 3. Summary.
  const counts = new Map<Band, number>(BANDS.map(b => [b, 0]))
  for (const m of misses) counts.set(band(m.bestSim), (counts.get(band(m.bestSim)) ?? 0) + 1)
  console.log(`\nTOTAL: ${dgTotal} deepgram insights, ${merged} merged (${((100 * merged) / dgTotal).toFixed(1)}% recall at today's gate), ${misses.length} not merged`)
  console.log('misses by best caption-twin similarity:')
  for (const b of BANDS) console.log(`  ${b.padEnd(10)} ${String(counts.get(b)).padStart(5)}`)

  if (judgeN <= 0) {
    console.log('\n(pass --judge N to adjudicate up to N misses per band and estimate recall at a lower gate)')
    return
  }

  // 4. Judge a sample per band, showing the top-k caption claims regardless of gate.
  const { adjudicate } = await import('../lib/consolidation')
  const verdicts = new Map<Band, { same: number; different: number; unsure: number; failed: number }>(
    BANDS.map(b => [b, { same: 0, different: 0, unsure: 0, failed: 0 }])
  )
  console.log(`\njudging up to ${judgeN} misses per band with the production adjudicator (top ${k} caption-twin claims shown)…`)
  for (const b of BANDS) {
    const pool = misses.filter(m => band(m.bestSim) === b)
    // Deterministic spread: every Nth, not the first N (which would be one episode).
    const step = Math.max(1, Math.floor(pool.length / judgeN))
    const sample = pool.filter((_, i) => i % step === 0).slice(0, judgeN)
    for (const m of sample) {
      const tally = verdicts.get(b)!
      try {
        const v = await adjudicate(
          m.insight.statement,
          m.top.map(t => ({ id: t.id, canonical_statement: t.canonical_statement, context_note: t.context_note, similarity: t.sim }))
        )
        if (v.verdict === 'SAME') tally.same++
        else if (v.verdict === 'DIFFERENT') tally.different++
        else tally.unsure++
        console.log(`  ${b.padEnd(10)} best ${m.bestSim.toFixed(3)}  ${v.verdict.padEnd(9)} conf ${v.confidence.toFixed(2)}  ${m.insight.statement.slice(0, 70)}`)
      } catch (err) {
        tally.failed++
        console.log(`  ${b.padEnd(10)} not judged: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`)
      }
    }
  }

  // 5. What a lower gate would recover: SAME rate per band × band size.
  console.log('\nband        misses  judged  SAME  DIFF  UNSURE  SAME%   est. recoverable')
  let cumulative = merged
  for (const b of BANDS) {
    const t = verdicts.get(b)!
    const judged = t.same + t.different + t.unsure
    const rate = judged ? t.same / judged : 0
    const recoverable = Math.round((counts.get(b) ?? 0) * rate)
    cumulative += recoverable
    console.log(
      `${b.padEnd(10)} ${String(counts.get(b)).padStart(6)} ${String(judged).padStart(7)} ${String(t.same).padStart(5)} ${String(t.different).padStart(5)} ${String(t.unsure).padStart(7)} ${judged ? (100 * rate).toFixed(0).padStart(5) + '%' : '    –'}   ${String(recoverable).padStart(5)}` +
        `   → recall if the gate reached this band: ${((100 * cumulative) / dgTotal).toFixed(0)}%`
    )
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
