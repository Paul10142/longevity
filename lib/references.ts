/**
 * Reference layer (v3): capture third-party works a source cites, then resolve
 * them against CrossRef / PubMed so only VERIFIED references are ever surfaced.
 *
 * Two stages, both jobs:
 *   extract_references  — per chunk, LLM pulls external-work mentions →
 *                         reference_mentions (immutable, raw).
 *   resolve_references  — throttled + cached lookups → deduped references_,
 *                         links claims via chunk co-location. Unresolvable
 *                         mentions are marked not_found and never shown as cites.
 *
 * Scale notes: resolution is rate-limited and cached (a trial cited 500× resolves
 * once); dedup uses a fingerprint + the match_references ANN, never all-pairs.
 */

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'
import { generateEmbedding } from './embeddings'
import { startOrResumeRun, finishRun, failRun } from './pipelineRuns'

const REFERENCE_MODEL = 'gpt-5-mini'
const CONTACT_MAILTO = process.env.REFERENCE_CONTACT_EMAIL || 'team@admissionsacademy.org'
const USER_AGENT = `LifestyleAcademy/1.0 (mailto:${CONTACT_MAILTO})`
const MIN_EXTERNAL_INTERVAL_MS = 350 // gentle spacing for CrossRef/PubMed

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

// ── Rate limiter for external APIs ──────────────────────────
let lastExternalCall = 0
async function throttle(): Promise<void> {
  const wait = MIN_EXTERNAL_INTERVAL_MS - (Date.now() - lastExternalCall)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastExternalCall = Date.now()
}

// ── Extraction ──────────────────────────────────────────────
type ParsedRef = {
  raw_text: string
  type?: string
  title?: string
  authors?: string[]
  year?: number
  journal?: string
  doi?: string
  context?: string | null  // the finding/claim the work is cited to support (disambiguator)
}

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

async function extractRefsFromChunk(content: string): Promise<ParsedRef[]> {
  const completion = await getOpenAI().chat.completions.create({
    model: REFERENCE_MODEL,
    messages: [
      { role: 'system', content: EXTRACT_REF_SYSTEM },
      { role: 'user', content: `Chunk:\n${content}` },
    ],
    response_format: { type: 'json_object' },
  })
  const raw = completion.choices[0]?.message?.content
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { references?: ParsedRef[] }
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
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: ExtractRefCheckpoint }> {
  const started = Date.now()

  const runId = await startOrResumeRun('extract', sourceId, checkpoint?.run_id, { stage: 'references' })

  try {
  const { data: chunks, error } = await db()
    .from('chunks')
    .select('id, locator, content')
    .eq('source_id', sourceId)
    .order('locator', { ascending: true })
  if (error) throw new Error(`Failed to load chunks: ${error.message}`)
  const rows = (chunks ?? []) as { id: string; locator: string; content: string }[]

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

  await finishRun(runId, { stage: 'references', mentions: cp.mentions_created })
  return { done: true, checkpoint: cp }
  } catch (err) {
    await failRun(runId, err)
    throw err
  }
}

// ── Resolution (CrossRef → PubMed) ──────────────────────────
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}
function fingerprintOf(title: string, year: number | null, doi: string | null): string {
  if (doi) return `doi:${doi.toLowerCase()}`
  return `t:${normalizeTitle(title)}${year ? `:${year}` : ''}`
}
function resolvableTitle(title?: string): boolean {
  return !!title && normalizeTitle(title).split(' ').filter(w => w.length > 3).length >= 3
}
// Attempt resolution when the mention carries enough to identify a specific
// work: a DOI, a real title, or a journal anchored by a year/author. Precision
// is enforced downstream by the LLM judge + confidence threshold, so this gate
// only needs to skip hopelessly vague mentions ("a study showed…").
function canAttemptResolution(parsed: ParsedRef): boolean {
  if (parsed.doi || resolvableTitle(parsed.title)) return true
  if (parsed.journal && (parsed.year || (parsed.authors?.length ?? 0) > 0)) return true
  return false
}

type ResolvedRef = {
  type: string; title: string; authors: string[]; year: number | null
  journal: string | null; doi: string | null; url: string | null
  abstract?: string | null
  resolved_source: 'crossref' | 'pubmed' | 'openalex'
}

// ── Agentic resolution: gather candidates from several databases, then let an
//    LLM pick the true match on SUBSTANCE (abstract vs the described finding),
//    not just title tokens. Raises recall (find the paper from a description)
//    while keeping precision (never a topically-similar wrong paper).

const AUTO_ACCEPT_CONFIDENCE = 0.7   // below this → not_found

function reconstructAbstract(inv?: Record<string, number[]>): string | null {
  if (!inv) return null
  const words: { pos: number; w: string }[] = []
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words.push({ pos: p, w })
  if (words.length === 0) return null
  return words.sort((a, b) => a.pos - b.pos).map(x => x.w).join(' ').slice(0, 1200)
}

async function openAlexCandidates(parsed: ParsedRef, rawText: string): Promise<ResolvedRef[]> {
  const query = (parsed.title || rawText).slice(0, 300)
  if (!query.trim()) return []
  try {
    await throttle()
    const res = await fetch(
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5&mailto=${encodeURIComponent(CONTACT_MAILTO)}`,
      { headers: { 'User-Agent': USER_AGENT } }
    )
    if (!res.ok) return []
    const j = await res.json()
    return (j.results ?? []).map((w: {
      title?: string; publication_year?: number; doi?: string; type?: string
      authorships?: { author?: { display_name?: string } }[]
      primary_location?: { source?: { display_name?: string } }
      abstract_inverted_index?: Record<string, number[]>
    }): ResolvedRef | null => {
      if (!w.title) return null
      const doi = w.doi ? w.doi.replace('https://doi.org/', '') : null
      return {
        type: w.type === 'book' ? 'book' : 'journal_article',
        title: w.title,
        authors: (w.authorships ?? []).map(a => a.author?.display_name).filter((x): x is string => !!x),
        year: w.publication_year ?? null,
        journal: w.primary_location?.source?.display_name ?? null,
        doi,
        url: doi ? `https://doi.org/${doi}` : null,
        abstract: reconstructAbstract(w.abstract_inverted_index),
        resolved_source: 'openalex',
      }
    }).filter((x: ResolvedRef | null): x is ResolvedRef => !!x)
  } catch {
    return []
  }
}

async function crossrefCandidates(parsed: ParsedRef, rawText: string): Promise<ResolvedRef[]> {
  try {
    if (parsed.doi) {
      await throttle()
      const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(parsed.doi)}`, { headers: { 'User-Agent': USER_AGENT } })
      if (res.ok) { const j = await res.json(); const c = crossrefItem(j.message); if (c) return [c] }
    }
    const query = (parsed.title || rawText).slice(0, 300)
    if (!query.trim()) return []
    await throttle()
    const res = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=3`,
      { headers: { 'User-Agent': USER_AGENT } }
    )
    if (!res.ok) return []
    const j = await res.json()
    return (j.message?.items ?? []).map(crossrefItem).filter((x: ResolvedRef | null): x is ResolvedRef => !!x)
  } catch {
    return []
  }
}

function crossrefItem(item: {
  title?: string[]; author?: { given?: string; family?: string }[]; DOI?: string
  'container-title'?: string[]; issued?: { 'date-parts'?: number[][] }; type?: string; URL?: string
}): ResolvedRef | null {
  const title = item.title?.[0]
  if (!title) return null
  const year = item.issued?.['date-parts']?.[0]?.[0] ?? null
  const authors = (item.author ?? []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean)
  const typeMap: Record<string, string> = { 'journal-article': 'journal_article', 'book': 'book', 'proceedings-article': 'journal_article' }
  return {
    type: typeMap[item.type ?? ''] ?? 'journal_article',
    title, authors, year,
    journal: item['container-title']?.[0] ?? null,
    doi: item.DOI ?? null,
    url: item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : null),
    resolved_source: 'crossref',
  }
}

/** Gather + dedup candidates across databases. */
async function gatherCandidates(parsed: ParsedRef, rawText: string): Promise<ResolvedRef[]> {
  const [oa, cr] = await Promise.all([openAlexCandidates(parsed, rawText), crossrefCandidates(parsed, rawText)])
  const all = [...oa, ...cr]
  const seen = new Set<string>()
  const deduped: ResolvedRef[] = []
  for (const c of all) {
    const key = c.doi ? `doi:${c.doi.toLowerCase()}` : `t:${normalizeTitle(c.title)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
  }
  return deduped.slice(0, 8)
}

type Judgement = { index: number | null; confidence: number }

/**
 * LLM judge: given the speaker's mention (+ the finding they described) and a
 * list of candidate works with abstracts, pick the one that is the SAME specific
 * work, or none. Matching on substance is what distinguishes a real citation
 * from a topically-similar paper.
 */
async function judgeCandidates(rawText: string, context: string | null, candidates: ResolvedRef[]): Promise<Judgement> {
  if (candidates.length === 0) return { index: null, confidence: 0 }
  const list = candidates
    .map((c, i) => `[${i}] "${c.title}" — ${(c.authors ?? []).slice(0, 3).join(', ') || 'unknown authors'}, ${c.journal ?? 'n/a'}, ${c.year ?? 'n/a'}${c.abstract ? `\n    abstract: ${c.abstract.slice(0, 500)}` : ''}`)
    .join('\n')
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: REFERENCE_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'A speaker referred to an external published work. Choose which candidate (if any) is the SAME specific work — match on substance: the described finding, population, topic, and era should fit the candidate\'s abstract/metadata. If the speaker only named a general topic/technique (not a specific identifiable work), or no candidate clearly fits, return index null. Return STRICT JSON {"index": <number or null>, "confidence": <0..1>}.',
        },
        {
          role: 'user',
          content: `Speaker referred to: "${rawText}"${context ? `\nFinding described: ${context}` : ''}\n\nCandidates:\n${list}`,
        },
      ],
      response_format: { type: 'json_object' },
    })
    const raw = completion.choices[0]?.message?.content
    if (!raw) return { index: null, confidence: 0 }
    const j = JSON.parse(raw)
    const index = typeof j.index === 'number' && j.index >= 0 && j.index < candidates.length ? j.index : null
    return { index, confidence: typeof j.confidence === 'number' ? j.confidence : 0 }
  } catch {
    return { index: null, confidence: 0 }
  }
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

/** Link a resolved reference to the claims that live in the same chunk. */
async function linkReferenceToClaims(chunkId: string | null, referenceId: string): Promise<void> {
  if (!chunkId) return
  const { data: raws } = await db().from('raw_insights').select('id').eq('chunk_id', chunkId)
  const rawIds = (raws ?? []).map((r: { id: string }) => r.id)
  if (rawIds.length === 0) return
  const { data: members } = await db().from('claim_members').select('claim_id').in('raw_insight_id', rawIds)
  const claimIds = Array.from(new Set((members ?? []).map((m: { claim_id: string }) => m.claim_id)))
  if (claimIds.length === 0) return
  const rows = claimIds.map(claim_id => ({ claim_id, reference_id: referenceId }))
  await db().from('claim_references').upsert(rows, { onConflict: 'claim_id,reference_id' })
}

export type ResolveCheckpoint = { processed: number; resolved: number; not_found: number }

/** Stage: resolve pending reference mentions. Throttled + cached + deduped. */
export async function resolveReferences(
  onProgress: (cp: ResolveCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: ResolveCheckpoint }> {
  const started = Date.now()
  const cache = new Map<string, { id: string | null; conf: number }>() // key → {reference_id|null, confidence}
  const cp: ResolveCheckpoint = { processed: 0, resolved: 0, not_found: 0 }

  while (Date.now() - started < timeBudgetMs) {
    const { data: batch } = await db()
      .from('reference_mentions')
      .select('id, chunk_id, raw_text, parsed')
      .eq('resolution_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(15)
    const mentions = (batch ?? []) as { id: string; chunk_id: string | null; raw_text: string; parsed: ParsedRef }[]
    if (mentions.length === 0) return { done: true, checkpoint: cp }

    for (const m of mentions) {
      if (Date.now() - started > timeBudgetMs) return { done: false, checkpoint: cp }
      const parsed = m.parsed || ({} as ParsedRef)

      let referenceId: string | null = null
      let confidence = 0
      if (canAttemptResolution(parsed)) {
        const cacheKey = fingerprintOf(parsed.title ?? parsed.doi ?? '(none)', parsed.year ?? null, parsed.doi ?? null)
        if (cache.has(cacheKey)) {
          const hit = cache.get(cacheKey)!
          referenceId = hit.id
          confidence = hit.conf
        } else {
          const candidates = await gatherCandidates(parsed, m.raw_text)
          const j = await judgeCandidates(m.raw_text, parsed.context ?? null, candidates)
          if (j.index !== null && j.confidence >= AUTO_ACCEPT_CONFIDENCE) {
            referenceId = await upsertReference(candidates[j.index])
            confidence = j.confidence
          }
          cache.set(cacheKey, { id: referenceId, conf: confidence })
        }
      }

      if (referenceId) {
        await db().from('reference_mentions').update({
          resolution_status: 'resolved', reference_id: referenceId, match_confidence: confidence,
        }).eq('id', m.id)
        await linkReferenceToClaims(m.chunk_id, referenceId)
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
