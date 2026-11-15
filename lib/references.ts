/**
 * Reference layer (v3): capture third-party works a source cites, then resolve
 * them against PubMed / Crossref (OpenAlex as backup) so only VERIFIED references
 * are ever surfaced.
 *
 * Two stages, both jobs:
 *   extract_references  — per chunk, LLM pulls external-work mentions →
 *                         reference_mentions (immutable, raw).
 *   resolve_references  — lookups (lib/referenceLookup.ts) → deduped references_,
 *                         linked to the claims from the same chunk whose wording is
 *                         about the study (lib/claimLinking.ts). A mention nothing
 *                         matches is marked not_found and never shown as a cite;
 *                         one whose lookup or claim-picking FAILED stays pending and is retried.
 *
 * Scale notes: lookups are paced and cached (a trial cited 500× resolves once);
 * dedup uses a fingerprint + the match_references ANN, never all-pairs.
 */

import { supabaseAdmin } from './supabaseServer'
import { generateEmbedding } from './embeddings'
import { startOrResumeRun, finishRun, failRun } from './pipelineRuns'
import { claudeJson, CLAUDE_BULK_MODEL } from './llm'
import { selectAllPaged } from './pagination'
import {
  createReferenceLookup, normalizeTitle,
  type ParsedRef, type ResolvedRef, type EpisodeInfo, type MentionResult, type ReferenceLookup,
} from './referenceLookup'
import { selectInsightsAboutStudy, type InsightCandidate, type ClaimLinkResult } from './claimLinking'

// Bulk tier: scanning every chunk for citation mentions.
const REFERENCE_MODEL = CLAUDE_BULK_MODEL

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

// ── Extraction ──────────────────────────────────────────────
const EXTRACT_REF_SYSTEM = `
Extract explicit mentions of EXTERNAL published works cited in this transcript chunk: peer-reviewed studies, clinical trials, meta-analyses, guidelines, or books that the speakers refer to as evidence.

Include a work ONLY if the text actually references it (e.g. "a 2019 NEJM trial", "the PREDIMED study", "Attia's book Outlive", "a Cochrane review of…"). Do NOT invent details. Do NOT extract the speakers' own opinions, general statements, or vague allusions with no identifiable work.

For each, return:
- raw_text: the mention exactly as said
- type: journal_article | trial | guideline | book | preprint | other
- title, authors (array), year, journal, doi — ONLY the fields actually stated or clearly implied; omit unknown fields (do not guess).
- context: a one-sentence summary of the specific FINDING, population, or claim the speaker attributes to this work (this is used to identify the exact paper later — capture the substance, e.g. "a study of ~700 couples showing that paternal age affects miscarriage risk").

Return STRICT JSON: {"references":[{"raw_text":"...","type":"...","title":"...","year":2019,"journal":"...","authors":["..."],"doi":"...","context":"..."}]}
If none, return {"references":[]}.
`.trim()

type ExtractedRef = ParsedRef & { raw_text: string }

async function extractRefsFromChunk(content: string): Promise<ExtractedRef[]> {
  try {
    const parsed = await claudeJson<{ references?: ExtractedRef[] }>(
      EXTRACT_REF_SYSTEM,
      `Chunk:\n${content}`,
      4000,
      REFERENCE_MODEL
    )
    return (parsed.references ?? []).filter(r => r && typeof r.raw_text === 'string' && r.raw_text.trim().length > 3)
  } catch {
    return []
  }
}

export type ExtractRefCheckpoint = {
  chunk_index: number
  total_chunks: number
  mentions_created: number
  run_id?: string | null
}

/** Stage: extract reference mentions from a source's chunks. Checkpointed. */
export async function extractReferences(
  sourceId: string,
  checkpoint: Partial<ExtractRefCheckpoint> | undefined,
  onProgress: (cp: ExtractRefCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000,
  opts: { trackRun?: boolean } = {}
): Promise<{ done: boolean; checkpoint: ExtractRefCheckpoint }> {
  const started = Date.now()

  // trackRun=false (the linking test) writes only reference tables: no pipeline_runs row.
  const trackRun = opts.trackRun !== false
  const runId = trackRun ? await startOrResumeRun('extract', sourceId, checkpoint?.run_id, { stage: 'references' }) : null

  try {
  // Paged — a long transcript can exceed the 1000-row server cap on its own,
  // and a truncated read would silently skip reference extraction for its tail.
  const rows = await selectAllPaged<{ id: string; locator: string; content: string }>(
    (from, to) => db()
      .from('chunks')
      .select('id, locator, content')
      .eq('source_id', sourceId)
      .order('locator', { ascending: true })
      .range(from, to)
  )

  let cp: ExtractRefCheckpoint = {
    chunk_index: checkpoint?.chunk_index ?? 0,
    total_chunks: rows.length,
    mentions_created: checkpoint?.mentions_created ?? 0,
    run_id: runId,
  }

  for (let i = cp.chunk_index; i < rows.length; i++) {
    if (Date.now() - started > timeBudgetMs) return { done: false, checkpoint: { ...cp, chunk_index: i } }
    const chunk = rows[i]
    const refs = await extractRefsFromChunk(chunk.content)
    if (refs.length > 0) {
      const toInsert = refs.map(r => ({
        source_id: sourceId,
        chunk_id: chunk.id,
        run_id: runId,
        locator: chunk.locator,
        raw_text: r.raw_text.trim(),
        parsed: {
          type: r.type ?? null, title: r.title ?? null, authors: r.authors ?? null,
          year: r.year ?? null, journal: r.journal ?? null, doi: r.doi ?? null,
          context: r.context ?? null,
        },
      }))
      const { error: insErr } = await db().from('reference_mentions').insert(toInsert)
      if (insErr) throw new Error(`Failed to insert reference_mentions: ${insErr.message}`)
      cp.mentions_created += toInsert.length
    }
    cp = { ...cp, chunk_index: i + 1 }
    await onProgress(cp)
  }

  if (runId) await finishRun(runId, { stage: 'references', mentions: cp.mentions_created })
  return { done: true, checkpoint: cp }
  } catch (err) {
    if (runId) await failRun(runId, err)
    throw err
  }
}

// ── Resolution ──────────────────────────────────────────────
// The lookup itself (PubMed first, retries, search writer, judge, one lookup per work) lives in
// lib/referenceLookup.ts so it can be tested without a database. This file does the reads and writes.
function fingerprintOf(title: string, year: number | null, doi: string | null): string {
  if (doi) return `doi:${doi.toLowerCase()}`
  return `t:${normalizeTitle(title)}${year ? `:${year}` : ''}`
}

/** Find-or-create a canonical reference (dedup by fingerprint/DOI). */
async function upsertReference(r: ResolvedRef): Promise<string> {
  const fingerprint = fingerprintOf(r.title, r.year, r.doi)

  const { data: existing } = await db()
    .from('references_')
    .select('id')
    .eq('fingerprint', fingerprint)
    .limit(1)
  if (existing && existing.length > 0) return existing[0].id

  const embedding = await generateEmbedding(`${r.title}${r.journal ? ` ${r.journal}` : ''}${r.year ? ` ${r.year}` : ''}`)
  const { data: created, error } = await db()
    .from('references_')
    .insert({
      type: r.type, title: r.title, authors: r.authors, year: r.year, journal: r.journal,
      doi: r.doi, url: r.url, fingerprint, resolved_source: r.resolved_source, embedding,
    })
    .select('id')
    .single()
  if (error) {
    // Concurrent insert of the same fingerprint — fetch the winner.
    const { data: race } = await db().from('references_').select('id').eq('fingerprint', fingerprint).limit(1)
    if (race && race.length > 0) return race[0].id
    throw new Error(`Failed to upsert reference: ${error.message}`)
  }
  return created!.id as string
}

/** An extracted statement from a chunk that has become (part of) a claim, with the claims it belongs to. */
type ChunkInsight = InsightCandidate & { claimIds: string[] }

/** The statements of one chunk that belong to a claim. These are the only claims a citation in the chunk can reach. */
async function claimedInsightsOfChunk(chunkId: string | null): Promise<ChunkInsight[]> {
  if (!chunkId) return []
  const { data: raws } = await db().from('raw_insights').select('id, statement, direct_quote').eq('chunk_id', chunkId)
  const rows = (raws ?? []) as { id: string; statement: string; direct_quote: string | null }[]
  if (rows.length === 0) return []
  const { data: members } = await db().from('claim_members').select('raw_insight_id, claim_id').in('raw_insight_id', rows.map(r => r.id))
  const claimsOf = new Map<string, string[]>()
  for (const m of (members ?? []) as { raw_insight_id: string; claim_id: string }[]) {
    claimsOf.set(m.raw_insight_id, [...(claimsOf.get(m.raw_insight_id) ?? []), m.claim_id])
  }
  return rows
    .filter(r => claimsOf.has(r.id))
    .map(r => ({ id: r.id, statement: r.statement, quote: r.direct_quote, claimIds: claimsOf.get(r.id)! }))
}

/** Link a resolved reference to exactly these claims. */
async function linkReferenceToClaims(claimIds: string[], referenceId: string): Promise<void> {
  const unique = Array.from(new Set(claimIds))
  if (unique.length === 0) return
  const rows = unique.map(claim_id => ({ claim_id, reference_id: referenceId }))
  await db().from('claim_references').upsert(rows, { onConflict: 'claim_id,reference_id' })
}

export type ResolveCheckpoint = { processed: number; resolved: number; not_found: number; /** citations whose lookup failed this pass; still pending */ deferred?: number }

/** What the resolver saw for one mention — used by the linking test to explain failures. */
export type ResolveTrace = {
  mention_id: string
  attempted: boolean
  candidates: ResolvedRef[]
  judge: MentionResult['judge']
  accepted_index: number | null
  outcome: MentionResult['outcome']
  reason: MentionResult['reason']
  /** Which claims the study was attached to (resolved mentions only). */
  claim_link: { outcome: ClaimLinkResult['outcome']; considered: number; linked_claims: number } | null
}

// Past this many failed lookups in one pass the databases are down: stop instead of hammering them.
// The citations stay pending and the next resolve_references job picks them up.
const MAX_DEFERRED_PER_PASS = 20

type EpisodeRow = { title: string | null; authors: string[] | null; date: string | null }

/** Episode details (title, guests) help the lookup work out who "my lab" or "the Belsky paper" means. */
async function episodeFor(sourceId: string, memo: Map<string, EpisodeInfo>): Promise<EpisodeInfo> {
  const hit = memo.get(sourceId)
  if (hit) return hit
  const { data } = await db().from('sources').select('title, authors, date').eq('id', sourceId).maybeSingle()
  const row = data as EpisodeRow | null
  const info: EpisodeInfo = { title: row?.title ?? null, people: row?.authors ?? [], date: row?.date ?? null }
  memo.set(sourceId, info)
  return info
}

/**
 * Stage: resolve pending reference mentions. A work cited many times is looked up once. A citation whose
 * lookup FAILED (database down or refusing, model error) stays pending; only a real "nothing found" or a
 * judge rejection becomes not_found.
 */
export async function resolveReferences(
  onProgress: (cp: ResolveCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000,
  opts: { sourceIds?: string[]; trace?: (t: ResolveTrace) => void; lookup?: ReferenceLookup } = {}
): Promise<{ done: boolean; checkpoint: ResolveCheckpoint }> {
  const started = Date.now()
  const lookup = opts.lookup ?? createReferenceLookup()
  const episodes = new Map<string, EpisodeInfo>()
  const deferred = new Set<string>()
  const cp: ResolveCheckpoint = { processed: 0, resolved: 0, not_found: 0, deferred: 0 }

  while (Date.now() - started < timeBudgetMs) {
    let q = db()
      .from('reference_mentions')
      .select('id, source_id, chunk_id, raw_text, parsed')
      .eq('resolution_status', 'pending')
    if (opts.sourceIds) q = q.in('source_id', opts.sourceIds) // linking test: only the named sources
    if (deferred.size > 0) q = q.not('id', 'in', `(${[...deferred].join(',')})`)
    const { data: batch } = await q
      .order('created_at', { ascending: true })
      .limit(15)
    const mentions = (batch ?? []) as { id: string; source_id: string; chunk_id: string | null; raw_text: string; parsed: ParsedRef | null }[]
    if (mentions.length === 0) return { done: true, checkpoint: cp }

    for (const m of mentions) {
      if (Date.now() - started > timeBudgetMs) return { done: false, checkpoint: cp }
      const episode = await episodeFor(m.source_id, episodes)
      const result = await lookup.resolveMention({ raw: m.raw_text, parsed: m.parsed ?? {}, episode })

      // A found study is attached only to the claims whose wording is about it (lib/claimLinking.ts).
      let claimLink: ResolveTrace['claim_link'] = null
      let claimIds: string[] = []
      let linkFailed = false
      if (result.outcome === 'resolved' && result.accepted) {
        const insights = await claimedInsightsOfChunk(m.chunk_id)
        const picked = await selectInsightsAboutStudy({ raw: m.raw_text, parsed: m.parsed ?? {}, episode, study: result.accepted, insights })
        linkFailed = picked.outcome === 'failed'
        const chosen = new Set(picked.selectedIds)
        claimIds = insights.filter(i => chosen.has(i.id)).flatMap(i => i.claimIds)
        claimLink = { outcome: picked.outcome, considered: picked.considered, linked_claims: new Set(claimIds).size }
      }
      opts.trace?.({
        mention_id: m.id, attempted: result.outcome !== 'skipped', candidates: result.candidates, judge: result.judge,
        accepted_index: result.accepted ? result.candidates.findIndex(c => c === result.accepted) : null,
        outcome: result.outcome, reason: result.reason, claim_link: claimLink,
      })

      // A failed lookup, or a failed attempt to pick the claims, leaves the citation pending to be retried.
      if (result.outcome === 'deferred' || linkFailed) {
        deferred.add(m.id)
        cp.deferred = deferred.size
        if (deferred.size >= MAX_DEFERRED_PER_PASS) {
          await onProgress(cp)
          return { done: true, checkpoint: cp }
        }
        continue
      }
      if (result.outcome === 'resolved' && result.accepted) {
        const referenceId = await upsertReference(result.accepted)
        await db().from('reference_mentions').update({
          resolution_status: 'resolved', reference_id: referenceId, match_confidence: result.confidence,
        }).eq('id', m.id)
        await linkReferenceToClaims(claimIds, referenceId)
        cp.resolved++
      } else {
        await db().from('reference_mentions').update({ resolution_status: 'not_found' }).eq('id', m.id)
        cp.not_found++
      }
      cp.processed++
    }
    await onProgress(cp)
  }
  return { done: false, checkpoint: cp }
}
