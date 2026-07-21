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

import { supabaseAdmin } from './supabaseServer'
import { generateEmbedding, generateEmbeddingsBatch } from './embeddings'
import { startOrResumeRun, finishRun, failRun } from './pipelineRuns'
import { claudeJson, CLAUDE_JUDGMENT_MODEL } from './llm'

// Judgment tier: topic placement shapes the whole taxonomy, so a bad call here
// compounds across every claim filed under it.
const TAXONOMY_MODEL = CLAUDE_JUDGMENT_MODEL
const BATCH_SIZE = 12               // claims per LLM call
const CANDIDATES_PER_CLAIM = 6      // existing-topic hints shown per claim
const TOPIC_MATCH_THRESHOLD = 0.28  // ANN floor for "existing topic" hints

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

  // Unique slug, assigned ONCE at creation and frozen thereafter (rename never
  // re-slugs) so topic URLs and article citations stay stable. See ARCHITECTURE.md.
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

  try {
    const parsed = await claudeJson<{ assignments?: Assignment[] }>(
      TAXONOMY_SYSTEM,
      `Assign topics to these claims:\n${body}`,
      8000,
      TAXONOMY_MODEL
    )
    return Array.isArray(parsed.assignments) ? parsed.assignments : []
  } catch {
    return []
  }
}

export type TagCheckpoint = {
  processed: number
  topics_created: number
  links_created: number
  run_id?: string | null
}

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
  const runId = await startOrResumeRun('tag', null, checkpoint?.run_id)

  try {
  const cache = await loadTopicCache()
  const topicCountBefore = cache.size

  let cp: TagCheckpoint = {
    processed: checkpoint?.processed ?? 0,
    topics_created: checkpoint?.topics_created ?? 0,
    links_created: checkpoint?.links_created ?? 0,
    run_id: runId,
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

  await finishRun(runId, {
    processed: cp.processed,
    topics_created: cp.topics_created,
    links_created: cp.links_created,
  })
  return { done: true, checkpoint: cp }
  } catch (err) {
    await failRun(runId, err)
    throw err
  }
}

// ── Topic discovery ─────────────────────────────────────────
//
// Tagging can only make *local* decisions: for one claim, which of the topics
// that already exist fit best? It cannot notice that forty supplement claims
// are scattered across Metabolic Health and Endocrinology and deserve a branch
// of their own. That stepping-back pass is this stage.
//
// It only *proposes and creates* topics — placement stays with the tagger. Any
// claim under a reshaped topic is flagged `needs_tagging`, and the follow-on
// `tag_claims` job re-files it against the now-richer tree. That keeps one
// code path responsible for assignment.

const DISCOVERY_SYSTEM = `
You are curating the topic taxonomy for a lifestyle-medicine knowledge library.

You are shown the current topic tree and a sample of claims that are either
unfiled or sitting in over-broad buckets. Propose NEW topics that would give
these claims a better home.

Rules:
- Propose a topic only when several claims genuinely share a subject. Never
  propose a topic for a single claim.
- Prefer a small number of durable, clinically meaningful topics over many
  narrow ones. Proposing zero topics is a valid and common answer.
- "parent" must be the exact name of an existing topic, or null for a new
  top-level topic. Only use null when the subject genuinely sits alongside the
  existing top-level topics rather than inside one.
- Do not propose a topic whose name duplicates or merely rephrases an existing
  one.

Return STRICT JSON:
{"topics":[{"name":"...","parent":"... or null","rationale":"why these claims cluster"}]}
`.trim()

type ProposedTopic = { name?: string; parent?: string | null; rationale?: string }

export type DiscoverCheckpoint = {
  topics_created: number
  claims_reflagged: number
  run_id?: string | null
}

// A topic holding more than this many claims is a candidate for splitting.
const OVERBROAD_CLAIM_COUNT = 15
// How many claim statements to show the model per over-broad topic.
const DISCOVERY_SAMPLE = 40

/**
 * Propose and create new topics for unfiled or poorly-filed claims, then flag
 * the affected claims for re-tagging. Enqueue `tag_claims` after this runs.
 */
export async function discoverTopics(
  checkpoint: Partial<DiscoverCheckpoint> | undefined,
  onProgress: (cp: DiscoverCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000,
  // `dryRun` proposes without writing — the taxonomy is human-curated, so it
  // should be possible to see what the model wants before it lands.
  options: {
    dryRun?: boolean
    onPropose?: (p: { name: string; parent: string | null; rationale: string; batch: string }) => void
  } = {}
): Promise<{ done: boolean; checkpoint: DiscoverCheckpoint }> {
  const started = Date.now()
  const { dryRun = false, onPropose } = options
  const runId = dryRun ? null : await startOrResumeRun('discover_topics', null, checkpoint?.run_id)

  try {
    const cache = await loadTopicCache()
    let cp: DiscoverCheckpoint = {
      topics_created: checkpoint?.topics_created ?? 0,
      claims_reflagged: checkpoint?.claims_reflagged ?? 0,
      run_id: runId,
    }

    // Current tree, for both the prompt and duplicate rejection.
    const { data: topicRows } = await db()
      .from('topics')
      .select('id, name, parent_id, claim_count')
      .eq('status', 'active')
    const topics = (topicRows ?? []) as { id: string; name: string; parent_id: string | null; claim_count: number }[]
    const nameById = new Map(topics.map(t => [t.id, t.name]))
    const treeText = topics
      .map(t => `- ${t.name}${t.parent_id ? ` (under ${nameById.get(t.parent_id) ?? '?'})` : ''} — ${t.claim_count} claims`)
      .join('\n')

    // Pool 1: claims with no topic at all.
    const { data: linkRows } = await db().from('claim_topics').select('claim_id').range(0, 49999)
    const linked = new Set((linkRows ?? []).map((l: { claim_id: string }) => l.claim_id))
    const { data: allClaims } = await db()
      .from('claims')
      .select('id, canonical_statement')
      .eq('status', 'active')
      .range(0, 49999)
    const orphans = ((allClaims ?? []) as { id: string; canonical_statement: string }[])
      .filter(c => !linked.has(c.id))
      .slice(0, DISCOVERY_SAMPLE)

    // Pool 2: one batch per over-broad topic.
    const overbroad = topics.filter(t => t.claim_count >= OVERBROAD_CLAIM_COUNT)

    type Batch = { label: string; claimIds: string[]; statements: string[] }
    const batches: Batch[] = []
    if (orphans.length >= 2) {
      batches.push({
        label: 'Claims that currently have no topic at all',
        claimIds: orphans.map(c => c.id),
        statements: orphans.map(c => c.canonical_statement),
      })
    }
    for (const t of overbroad) {
      const { data: members } = await db()
        .from('claim_topics')
        .select('claim_id, claims!inner(id, canonical_statement, status)')
        .eq('topic_id', t.id)
        .eq('claims.status', 'active')
        .limit(DISCOVERY_SAMPLE)
      const rows = (members ?? []) as { claim_id: string; claims: { canonical_statement: string } }[]
      if (rows.length < 2) continue
      batches.push({
        label: `Claims currently filed under the broad topic "${t.name}"`,
        claimIds: rows.map(r => r.claim_id),
        statements: rows.map(r => r.claims.canonical_statement),
      })
    }

    const reflag = new Set<string>()

    for (const batch of batches) {
      if (Date.now() - started > timeBudgetMs) {
        return { done: false, checkpoint: cp }
      }

      let proposed: ProposedTopic[] = []
      try {
        const result = await claudeJson<{ topics?: ProposedTopic[] }>(
          DISCOVERY_SYSTEM,
          `Existing topic tree:\n${treeText}\n\n${batch.label}:\n${batch.statements.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
          4000,
          CLAUDE_JUDGMENT_MODEL
        )
        proposed = Array.isArray(result.topics) ? result.topics : []
      } catch (err) {
        console.warn('[discover] proposal failed:', err instanceof Error ? err.message : err)
        continue
      }

      let createdHere = 0
      for (const p of proposed) {
        const name = typeof p.name === 'string' ? p.name.trim() : ''
        if (!name) continue
        // Skip anything that already exists — ensureTopic would no-op, but this
        // keeps topics_created honest.
        if (cache.has(name.toLowerCase())) continue
        // A proposed parent must already exist; otherwise place at top level
        // rather than inventing an unreviewed intermediate node.
        const parent =
          typeof p.parent === 'string' && cache.has(p.parent.trim().toLowerCase())
            ? p.parent.trim()
            : null

        onPropose?.({ name, parent, rationale: p.rationale ?? '', batch: batch.label })
        if (dryRun) {
          cp = { ...cp, topics_created: cp.topics_created + 1 }
          continue
        }

        try {
          await ensureTopic(name, parent, cache)
          createdHere++
          cp = { ...cp, topics_created: cp.topics_created + 1 }
        } catch (err) {
          console.warn(`[discover] could not create topic "${name}":`, err instanceof Error ? err.message : err)
        }
      }

      // Only re-tag when this batch actually gained somewhere to go.
      if (createdHere > 0) for (const id of batch.claimIds) reflag.add(id)
      await onProgress(cp)
    }

    if (!dryRun && reflag.size > 0) {
      const ids = Array.from(reflag)
      for (let i = 0; i < ids.length; i += 200) {
        await db().from('claims').update({ needs_tagging: true }).in('id', ids.slice(i, i + 200))
      }
      cp = { ...cp, claims_reflagged: ids.length }
    }

    if (dryRun) return { done: true, checkpoint: cp }

    await recomputeTopicCounts()
    await finishRun(runId, {
      topics_created: cp.topics_created,
      claims_reflagged: cp.claims_reflagged,
    })
    return { done: true, checkpoint: cp }
  } catch (err) {
    await failRun(runId, err)
    throw err
  }
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
