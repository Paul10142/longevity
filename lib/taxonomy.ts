/**
 * Taxonomy stage (v2): claims → topics (AI-managed hierarchy).
 *
 * A single pass both DISCOVERS and ASSIGNS: for each batch of untagged claims,
 * we show the model the closest existing topics (ANN over topics.embedding) and
 * ask it to either assign each claim to an existing topic or propose a new one
 * (optionally under a named parent). New topics are created + embedded on the
 * fly, so the hierarchy grows organically from the content. Topics go live
 * immediately; the admin audit UI lets a human rename / re-parent / merge /
 * archive them afterward (see topics.reviewed_by_human).
 *
 * Idempotent: only claims with needs_tagging=true are processed; a claim is
 * cleared once assigned.
 */

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'
import { generateEmbedding, generateEmbeddingsBatch } from './embeddings'

const TAXONOMY_MODEL = 'gpt-5-mini'
const BATCH_SIZE = 12               // claims per LLM call
const CANDIDATES_PER_CLAIM = 6      // existing-topic hints shown per claim
const TOPIC_MATCH_THRESHOLD = 0.28  // ANN floor for "existing topic" hints

let openaiInstance: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
    openaiInstance = new OpenAI({ apiKey })
  }
  return openaiInstance
}

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

type ClaimForTagging = { id: string; canonical_statement: string; context_note: string | null; embedding: number[] | null }

type TopicRow = { id: string; name: string; slug: string; parent_id: string | null }

// In-memory topic cache for a tagging run (name → row), refreshed as we create.
type TopicCache = Map<string, TopicRow>

async function loadTopicCache(): Promise<TopicCache> {
  const { data } = await db().from('topics').select('id, name, slug, parent_id').eq('status', 'active')
  const cache: TopicCache = new Map()
  for (const t of (data ?? []) as TopicRow[]) cache.set(t.name.toLowerCase(), t)
  return cache
}

/** Find-or-create a topic by name, optionally under a parent. Embeds new topics. */
async function ensureTopic(name: string, parentName: string | null, cache: TopicCache): Promise<TopicRow> {
  const key = name.toLowerCase()
  const existing = cache.get(key)
  if (existing) return existing

  let parentId: string | null = null
  if (parentName) {
    const parent = await ensureTopic(parentName, null, cache)
    parentId = parent.id
  }

  // Unique slug (append counter on collision).
  let slug = slugify(name) || 'topic'
  for (let n = 2; ; n++) {
    const { data: clash } = await db().from('topics').select('id').eq('slug', slug).limit(1)
    if (!clash || clash.length === 0) break
    slug = `${slugify(name)}-${n}`
  }

  const embedding = await generateEmbedding(name)
  const { data: created, error } = await db()
    .from('topics')
    .insert({ name, slug, parent_id: parentId, created_by: 'ai', embedding })
    .select('id, name, slug, parent_id')
    .single()
  if (error || !created) throw new Error(`Failed to create topic "${name}": ${error?.message}`)

  const row = created as TopicRow
  cache.set(key, row)
  return row
}

type Assignment = {
  claim_index: number
  topics: { name: string; parent?: string | null }[]
}

const TAXONOMY_SYSTEM = `
You organize health/medical CLAIMS into a topic taxonomy for a knowledge base.

For each claim, assign 1-2 topics that best capture what the claim is ABOUT (its subject area), not its format. Topics are reusable subject areas like "Zone 2 Training", "Insulin Resistance", "Protein Intake", "Testosterone", "Sleep & Circadian Rhythm", "Cardiovascular Disease Prevention".

Rules:
- STRONGLY prefer an existing topic from the provided candidate list when one fits — reuse keeps the taxonomy coherent. Only propose a new topic when nothing fits.
- Topic names are concise Title Case noun phrases (2-4 words). No sentences.
- Optionally place a topic under a broad parent domain (e.g. parent "Exercise" for "Zone 2 Training"; parent "Metabolic Health" for "Insulin Resistance"). Use a small set of broad parents; reuse parent names across claims.
- Assign at most 2 topics per claim. Prefer 1 unless the claim genuinely spans two subjects.

Return STRICT JSON:
{"assignments":[{"claim_index":1,"topics":[{"name":"Insulin Resistance","parent":"Metabolic Health"}]}]}
`.trim()

async function assignBatch(
  claims: ClaimForTagging[],
  candidatesByClaim: Map<number, string[]>
): Promise<Assignment[]> {
  const body = claims
    .map((c, i) => {
      const cands = candidatesByClaim.get(i) ?? []
      const hint = cands.length ? `\n   existing candidates: ${cands.join('; ')}` : ''
      return `${i + 1}. ${c.canonical_statement}${c.context_note ? ` (${c.context_note})` : ''}${hint}`
    })
    .join('\n')

  const completion = await getOpenAI().chat.completions.create({
    model: TAXONOMY_MODEL,
    messages: [
      { role: 'system', content: TAXONOMY_SYSTEM },
      { role: 'user', content: `Assign topics to these claims:\n${body}` },
    ],
    response_format: { type: 'json_object' },
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { assignments?: Assignment[] }
    return Array.isArray(parsed.assignments) ? parsed.assignments : []
  } catch {
    return []
  }
}

export type TagCheckpoint = { processed: number; topics_created: number; links_created: number }

/**
 * Tag all claims flagged needs_tagging, discovering topics as needed.
 * Resumable: processes claims in created order; clears needs_tagging as it goes.
 */
export async function tagClaims(
  checkpoint: Partial<TagCheckpoint> | undefined,
  onProgress: (cp: TagCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: TagCheckpoint }> {
  const started = Date.now()
  const { data: run } = await db()
    .from('pipeline_runs')
    .insert({ kind: 'tag', status: 'running' })
    .select('id')
    .single()
  const runId = run?.id

  const cache = await loadTopicCache()
  const topicCountBefore = cache.size

  let cp: TagCheckpoint = {
    processed: checkpoint?.processed ?? 0,
    topics_created: checkpoint?.topics_created ?? 0,
    links_created: checkpoint?.links_created ?? 0,
  }

  while (true) {
    if (Date.now() - started > timeBudgetMs) {
      return { done: false, checkpoint: cp }
    }

    // Next batch of untagged active claims.
    const { data: batch, error } = await db()
      .from('claims')
      .select('id, canonical_statement, context_note, embedding')
      .eq('status', 'active')
      .eq('needs_tagging', true)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE)
    if (error) throw new Error(`Failed to load claims for tagging: ${error.message}`)
    const claims = (batch ?? []) as ClaimForTagging[]
    if (claims.length === 0) break

    // Existing-topic hints per claim via ANN.
    const candidatesByClaim = new Map<number, string[]>()
    for (let i = 0; i < claims.length; i++) {
      if (!claims[i].embedding) continue
      const { data: cands } = await db().rpc('match_topics', {
        query_embedding: claims[i].embedding,
        match_threshold: TOPIC_MATCH_THRESHOLD,
        match_count: CANDIDATES_PER_CLAIM,
      })
      candidatesByClaim.set(i, ((cands ?? []) as { name: string }[]).map(c => c.name))
    }

    const assignments = await assignBatch(claims, candidatesByClaim)
    const byIndex = new Map<number, Assignment>()
    for (const a of assignments) byIndex.set(a.claim_index, a)

    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i]
      const assignment = byIndex.get(i + 1)
      const topics = (assignment?.topics ?? []).slice(0, 2)

      for (const t of topics) {
        if (!t?.name) continue
        const topic = await ensureTopic(t.name, t.parent ?? null, cache)
        const { error: linkErr } = await db()
          .from('claim_topics')
          .upsert({ claim_id: claim.id, topic_id: topic.id, assigned_by: 'ai' }, { onConflict: 'claim_id,topic_id' })
        if (!linkErr) cp = { ...cp, links_created: cp.links_created + 1 }
      }

      await db().from('claims').update({ needs_tagging: false }).eq('id', claim.id)
      cp = { ...cp, processed: cp.processed + 1 }
    }

    cp = { ...cp, topics_created: cache.size - topicCountBefore }
    await onProgress(cp)
  }

  // Refresh claim_count per topic from the links.
  await recomputeTopicCounts()

  if (runId) {
    await db()
      .from('pipeline_runs')
      .update({ status: 'success', finished_at: new Date().toISOString(), stats: { ...cp } })
      .eq('id', runId)
  }
  return { done: true, checkpoint: cp }
}

/** Recompute every active topic's claim_count from claim_topics. */
export async function recomputeTopicCounts(): Promise<void> {
  const { data: topics } = await db().from('topics').select('id').eq('status', 'active')
  for (const t of (topics ?? []) as { id: string }[]) {
    const { count } = await db()
      .from('claim_topics')
      .select('claim_id', { count: 'exact', head: true })
      .eq('topic_id', t.id)
    await db().from('topics').update({ claim_count: count ?? 0 }).eq('id', t.id)
  }
}

// Re-export for callers that batch-embed topic names elsewhere.
export { generateEmbeddingsBatch }
