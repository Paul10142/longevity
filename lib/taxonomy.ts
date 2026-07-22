/**
 * Taxonomy stage (v2): claims → topics, filed into a curated spine.
 *
 * The tree is anchored by human-curated top-level branches (`topics.is_spine`).
 * Tagging's job is PLACEMENT, not restructuring, and new branches are a gated
 * event rather than a side effect:
 *
 *   - Existing topic          → link the claim.
 *   - New child under an
 *     existing topic          → auto-created (the tree may deepen on its own).
 *   - New TOP-LEVEL branch    → never created here. Recorded in
 *                               `topic_proposals` for human approval, and the
 *                               claim is filed under its best existing parent.
 *
 * That last rule is the one that matters: previously a model naming a parent
 * that didn't exist got that parent auto-created as a new root, which is how
 * the tree grew 24 top-level topics. Roots now only come from humans.
 *
 * `claims.topic_fit` records how well the placement actually landed, so an
 * approximate filing is visible rather than silently indistinguishable from a
 * confident one.
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

type TopicRow = { id: string; name: string; slug: string; parent_id: string | null; is_spine?: boolean }

// In-memory topic cache for a tagging run (name → row), refreshed as we create.
type TopicCache = Map<string, TopicRow>

async function loadTopicCache(): Promise<TopicCache> {
  const { data } = await db().from('topics').select('id, name, slug, parent_id, is_spine').eq('status', 'active')
  const cache: TopicCache = new Map()
  for (const t of (data ?? []) as TopicRow[]) cache.set(t.name.toLowerCase(), t)
  return cache
}

/**
 * Record a wanted-but-not-created topic for human approval. Repeat suggestions
 * of the same name coalesce onto one pending row (accumulating the claims that
 * motivated it) so the reviewer gets one decision, not one per claim.
 */
async function proposeTopic(
  name: string,
  parentName: string | null,
  parent: TopicRow | null,
  claimId: string
): Promise<void> {
  const { data: existing } = await db()
    .from('topic_proposals')
    .select('id, claim_ids')
    .eq('status', 'pending')
    .ilike('name', name)
    .maybeSingle()

  if (existing) {
    const ids: string[] = existing.claim_ids ?? []
    if (ids.includes(claimId)) return
    const next = [...ids, claimId]
    await db()
      .from('topic_proposals')
      .update({ claim_ids: next, claim_count: next.length, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    return
  }

  const { error } = await db().from('topic_proposals').insert({
    name,
    proposed_parent_name: parentName,
    proposed_parent_id: parent?.id ?? null,
    claim_ids: [claimId],
    claim_count: 1,
  })
  // A concurrent worker may have inserted the same pending name; the partial
  // unique index rejects the duplicate, which is the desired outcome.
  if (error && !/duplicate key/i.test(error.message)) {
    console.error(`[taxonomy] failed to record topic proposal "${name}":`, error.message)
  }
}

/**
 * Create a topic as a CHILD of an existing one. There is deliberately no path
 * here to create a root — `parent` is required, so no call site can widen the
 * tree at the top. Roots come from the curated spine seeder or an approved
 * proposal.
 */
async function createChildTopic(name: string, parent: TopicRow, cache: TopicCache): Promise<TopicRow> {
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
    .insert({ name, slug, parent_id: parent.id, created_by: 'ai', embedding })
    .select('id, name, slug, parent_id, is_spine')
    .single()
  if (error || !created) throw new Error(`Failed to create topic "${name}": ${error?.message}`)

  const row = created as TopicRow
  cache.set(name.toLowerCase(), row)
  return row
}

type Placement =
  | { kind: 'linked'; topic: TopicRow; fit: 'good' | 'approximate' }
  | { kind: 'proposed' }

/**
 * Resolve one model-suggested (name, parent) pair to an actual topic.
 *
 * The gate: a name that already exists is reused; a new name under an existing
 * parent is created; anything that would need a NEW root is recorded as a
 * proposal and the claim falls back to the named parent when we have one.
 */
async function placeTopic(
  name: string,
  parentName: string | null,
  claimId: string,
  cache: TopicCache
): Promise<Placement> {
  const existing = cache.get(name.toLowerCase())
  if (existing) return { kind: 'linked', topic: existing, fit: 'good' }

  const parent = parentName ? cache.get(parentName.toLowerCase()) ?? null : null

  if (parent) {
    // New subject, but it has a real home — let the tree deepen on its own.
    const created = await createChildTopic(name, parent, cache)
    return { kind: 'linked', topic: created, fit: 'good' }
  }

  // Would require a new root. Record it, and file the claim under the best
  // thing we do have rather than forcing a branch or dropping the claim.
  await proposeTopic(name, parentName, null, claimId)
  return { kind: 'proposed' }
}

type Assignment = {
  claim_index: number
  topics: { name: string; parent?: string | null }[]
}

const TAXONOMY_SYSTEM = `
You file health/medical CLAIMS into an EXISTING topic taxonomy.

Your job is placement, not redesign. The taxonomy has a curated top-level
structure that is deliberately small and stable. Filing a claim into a topic
that already exists is always the preferred outcome — a slightly imperfect fit
in an existing topic beats a new topic.

For each claim, assign 1-2 topics capturing what it is ABOUT (its subject), not
its format.

Rules:
- Assign an existing topic whenever one is a reasonable home. "Reasonable" is a
  low bar on purpose: if a claim is broadly about the subject, file it there.
- Only when NO existing topic is reasonable, propose a new one — and it MUST
  name an existing "parent" it belongs under. A new topic with no valid parent
  will be rejected and held for human review, so always pick the best parent.
- Never propose a new top-level area. The top level is fixed.
- Topic names are concise Title Case noun phrases (2-4 words). No sentences.
- Assign at most 2 topics per claim. Prefer 1 unless it genuinely spans two.

File by SUBJECT, not by the kind of statement it is. Two traps:
- "Research & Evidence" is only for claims about how evidence is produced or
  judged IN GENERAL — study design, confounding, statistical interpretation,
  replication, funding bias. A claim reporting what a specific study FOUND
  belongs with the subject it is about. "An RCT showed testosterone raises
  hematocrit" is a testosterone claim, not a research-methods claim.
- The same holds for "Public Health & Policy": population-level policy belongs
  there, but a policy claim that is really about a lever ("bariatric surgery
  access improves outcomes") files under that lever.

Return STRICT JSON:
{"assignments":[{"claim_index":1,"topics":[{"name":"Insulin Resistance","parent":"Metabolic Health"}]}]}
`.trim()

/**
 * Render the curated spine (and its children) so the model can see the real
 * shape of the tree rather than a handful of ANN name matches. Reuse is only
 * realistic if it knows what already exists.
 */
function renderSpine(cache: TopicCache): string {
  const all = Array.from(cache.values())
  const roots = all.filter(t => t.parent_id === null).sort((a, b) => a.name.localeCompare(b.name))
  if (roots.length === 0) return '(no topics yet)'

  return roots
    .map(root => {
      const children = all
        .filter(t => t.parent_id === root.id)
        .map(t => t.name)
        .sort()
      const marker = root.is_spine ? '' : ' [unreviewed]'
      return children.length
        ? `- ${root.name}${marker}\n    ${children.join(' · ')}`
        : `- ${root.name}${marker}`
    })
    .join('\n')
}

async function assignBatch(
  claims: ClaimForTagging[],
  candidatesByClaim: Map<number, string[]>,
  cache: TopicCache
): Promise<Assignment[]> {
  const body = claims
    .map((c, i) => {
      const cands = candidatesByClaim.get(i) ?? []
      const hint = cands.length ? `\n   closest existing: ${cands.join('; ')}` : ''
      return `${i + 1}. ${c.canonical_statement}${c.context_note ? ` (${c.context_note})` : ''}${hint}`
    })
    .join('\n')

  try {
    const parsed = await claudeJson<{ assignments?: Assignment[] }>(
      TAXONOMY_SYSTEM,
      `Existing taxonomy (file into this):\n${renderSpine(cache)}\n\nAssign topics to these claims:\n${body}`,
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
  proposals_queued: number
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
    proposals_queued: checkpoint?.proposals_queued ?? 0,
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

    const assignments = await assignBatch(claims, candidatesByClaim, cache)
    const byIndex = new Map<number, Assignment>()
    for (const a of assignments) byIndex.set(a.claim_index, a)

    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i]
      const assignment = byIndex.get(i + 1)
      const topics = (assignment?.topics ?? []).slice(0, 2)

      let linked = 0
      let bestFit: 'good' | 'approximate' | null = null

      for (const t of topics) {
        if (!t?.name) continue
        const placement = await placeTopic(t.name, t.parent ?? null, claim.id, cache)

        if (placement.kind === 'proposed') {
          // Wanted a new root. The proposal is queued; fall back to the named
          // parent if it exists so the claim still gets a home.
          const fallback = t.parent ? cache.get(t.parent.toLowerCase()) : undefined
          if (!fallback) continue
          const { error: fbErr } = await db()
            .from('claim_topics')
            .upsert({ claim_id: claim.id, topic_id: fallback.id, assigned_by: 'ai' }, { onConflict: 'claim_id,topic_id' })
          if (!fbErr) {
            linked++
            cp = { ...cp, links_created: cp.links_created + 1 }
            bestFit = bestFit === 'good' ? 'good' : 'approximate'
            cp = { ...cp, proposals_queued: cp.proposals_queued + 1 }
          }
          continue
        }

        const { error: linkErr } = await db()
          .from('claim_topics')
          .upsert({ claim_id: claim.id, topic_id: placement.topic.id, assigned_by: 'ai' }, { onConflict: 'claim_id,topic_id' })
        if (!linkErr) {
          linked++
          cp = { ...cp, links_created: cp.links_created + 1 }
          if (placement.fit === 'good') bestFit = 'good'
          else if (bestFit === null) bestFit = 'approximate'
        }
      }

      await db()
        .from('claims')
        .update({ needs_tagging: false, topic_fit: linked > 0 ? bestFit ?? 'approximate' : 'unfiled' })
        .eq('id', claim.id)
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
  proposals_queued: number
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
      proposals_queued: checkpoint?.proposals_queued ?? 0,
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

        // Same gate as tagging: a proposal with a real parent deepens the tree
        // on its own; one that would need a new root waits for approval.
        const parentRow = parent ? cache.get(parent.toLowerCase()) ?? null : null
        try {
          if (parentRow) {
            await createChildTopic(name, parentRow, cache)
            createdHere++
            cp = { ...cp, topics_created: cp.topics_created + 1 }
          } else {
            await proposeTopic(name, parent, null, batch.claimIds[0] ?? '')
            cp = { ...cp, proposals_queued: cp.proposals_queued + 1 }
          }
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
