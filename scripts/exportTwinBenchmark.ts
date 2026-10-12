/**
 * Freeze the twin-episode recall benchmark to a file.
 *
 *   npx tsx --env-file=.env.local scripts/exportTwinBenchmark.ts [--out eval/twin-benchmark-20261011.json]
 *
 * Read-only. The nine episodes the corpus holds twice (a YouTube-caption
 * extraction, then a Deepgram one) are the only ground truth we have for "did
 * the engine recognise a repeat". The caption versions are about to be deleted
 * (docs/caption-retirement-plan.md), so the benchmark's inputs are exported
 * first: every Deepgram insight with its vector and whether it had merged with
 * the caption twin at export time, and every caption-side claim with its vector.
 * `scripts/evalTwinRecall.ts --from <file>` then runs against the file instead
 * of the live rows.
 *
 * Instead of raw vectors (59 MB as JSON), each Deepgram insight stores its
 * TOP_K nearest caption claims with their cosine similarity, computed here from
 * the live vectors, plus the text of every caption claim. That is everything
 * the benchmark reads, in a few MB. Commit it under eval/ once; never
 * regenerate it after the deletion (there would be nothing left to export).
 */
const TOP_K = 12
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const OUT = outIdx > -1 ? args[outIdx + 1] : 'eval/twin-benchmark-20261011.json'

function toVec(e: unknown): number[] | null {
  if (Array.isArray(e)) return e as number[]
  if (typeof e === 'string') { try { return JSON.parse(e) as number[] } catch { return null } }
  return null
}
function embeddingOf(rel: unknown): unknown {
  if (Array.isArray(rel)) return (rel[0] as { embedding?: unknown } | undefined)?.embedding ?? null
  return (rel as { embedding?: unknown } | null)?.embedding ?? null
}
function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}
// Stored embeddings are unit-length (OpenAI), so cosine = dot product.
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')

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

  const membership = async (insightIds: string[]): Promise<Map<string, string>> => {
    const m = new Map<string, string>()
    for (const ids of chunk(insightIds, 200)) {
      const { data, error } = await db.from('claim_members').select('raw_insight_id, claim_id').in('raw_insight_id', ids)
      if (error) throw new Error(`claim_members: ${error.message}`)
      for (const r of (data ?? []) as { raw_insight_id: string; claim_id: string }[]) m.set(r.raw_insight_id, r.claim_id)
    }
    return m
  }

  type Insight = { id: string; statement: string; context_note: string | null; embedding: unknown }
  const episodes: unknown[] = []
  let dgTotal = 0, merged = 0

  for (const c of captionRows) {
    const m = c.title.match(/^(\d{1,3})\s*[-‒–—]/)
    if (!m) continue
    const ep = Number(m[1])
    const d = byEpisode.get(ep)
    if (!d) continue

    const dgInsights = await selectAllPaged<Insight>((from, to) =>
      db.from('raw_insights').select('id, statement, context_note, embedding').eq('source_id', d.id).order('id').range(from, to)
    )
    const capInsights = await selectAllPaged<{ id: string }>((from, to) =>
      db.from('raw_insights').select('id').eq('source_id', c.id).order('id').range(from, to)
    )
    const dgMembers = await membership(dgInsights.map(i => i.id))
    const capMembers = await membership(capInsights.map(i => i.id))
    const capClaimIds = [...new Set(capMembers.values())]
    const capClaimSet = new Set(capClaimIds)

    const captionClaims: { id: string; canonical_statement: string; context_note: string | null }[] = []
    const capVecs: { id: string; v: number[] }[] = []
    for (const ids of chunk(capClaimIds, 100)) {
      const { data, error } = await db.from('claims').select('id, canonical_statement, context_note, claim_embeddings(embedding)').in('id', ids)
      if (error) throw new Error(`claims: ${error.message}`)
      for (const row of (data ?? []) as { id: string; canonical_statement: string; context_note: string | null; claim_embeddings: unknown }[]) {
        captionClaims.push({ id: row.id, canonical_statement: row.canonical_statement, context_note: row.context_note })
        const v = toVec(embeddingOf(row.claim_embeddings))
        if (v) capVecs.push({ id: row.id, v })
      }
    }

    const deepgramInsights = dgInsights.map(i => {
      const claimId = dgMembers.get(i.id) ?? null
      const mergedWithCaption = !!(claimId && capClaimSet.has(claimId))
      dgTotal++
      if (mergedWithCaption) merged++
      const v = toVec(i.embedding)
      const candidates = v
        ? capVecs.map(x => ({ id: x.id, sim: Number(cosine(v, x.v).toFixed(4)) })).sort((a, b) => b.sim - a.sim).slice(0, TOP_K)
        : []
      return { id: i.id, statement: i.statement, context_note: i.context_note, claim_id: claimId, merged_with_caption: mergedWithCaption, candidates }
    })

    episodes.push({ episode: ep, title: d.title, deepgram_source_id: d.id, caption_source_id: c.id, deepgramInsights, captionClaims })
    process.stdout.write(`#${ep}: ${dgInsights.length} deepgram insights, ${captionClaims.length} caption claims\n`)
  }

  if (episodes.length === 0) throw new Error('no twin episodes found — nothing to export')
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({
    exported_at: new Date().toISOString(),
    note: 'Twin-episode dedup recall benchmark, frozen before the caption versions were deleted. merged_with_caption reflects the engine state at export time (0.80 gate era).',
    gate_at_export: Number(process.env.CONSOLIDATION_CANDIDATE_THRESHOLD ?? 0.70),
    episodes,
  }))
  process.stdout.write(`\nwrote ${OUT}: ${episodes.length} episodes, ${dgTotal} deepgram insights, ${merged} merged with the caption twin (${((100 * merged) / dgTotal).toFixed(1)}%)\n`)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
