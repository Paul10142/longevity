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
}

const EXTRACT_REF_SYSTEM = `
Extract explicit mentions of EXTERNAL published works cited in this transcript chunk: peer-reviewed studies, clinical trials, meta-analyses, guidelines, or books that the speakers refer to as evidence.

Include a work ONLY if the text actually references it (e.g. "a 2019 NEJM trial", "the PREDIMED study", "Attia's book Outlive", "a Cochrane review of…"). Do NOT invent details. Do NOT extract the speakers' own opinions, general statements, or vague allusions with no identifiable work.

For each, return:
- raw_text: the mention exactly as said
- type: journal_article | trial | guideline | book | preprint | other
- title, authors (array), year, journal, doi — ONLY the fields actually stated or clearly implied; omit unknown fields (do not guess).

Return STRICT JSON: {"references":[{"raw_text":"...","type":"...","title":"...","year":2019,"journal":"...","authors":["..."],"doi":"..."}]}
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

export type ExtractRefCheckpoint = { chunk_index: number; total_chunks: number; mentions_created: number }

/** Stage: extract reference mentions from a source's chunks. Checkpointed. */
export async function extractReferences(
  sourceId: string,
  checkpoint: Partial<ExtractRefCheckpoint> | undefined,
  onProgress: (cp: ExtractRefCheckpoint) => Promise<void>,
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: ExtractRefCheckpoint }> {
  const started = Date.now()

  const { data: chunks, error } = await db()
    .from('chunks')
    .select('id, locator, content')
    .eq('source_id', sourceId)
    .order('locator', { ascending: true })
  if (error) throw new Error(`Failed to load chunks: ${error.message}`)
  const rows = (chunks ?? []) as { id: string; locator: string; content: string }[]

  const run = await db()
    .from('pipeline_runs')
    .insert({ source_id: sourceId, kind: 'extract', status: 'running', stats: { stage: 'references' } })
    .select('id')
    .single()
  const runId = run.data?.id

  let cp: ExtractRefCheckpoint = {
    chunk_index: checkpoint?.chunk_index ?? 0,
    total_chunks: rows.length,
    mentions_created: checkpoint?.mentions_created ?? 0,
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
        },
      }))
      const { error: insErr } = await db().from('reference_mentions').insert(toInsert)
      if (insErr) throw new Error(`Failed to insert reference_mentions: ${insErr.message}`)
      cp.mentions_created += toInsert.length
    }
    cp = { ...cp, chunk_index: i + 1 }
    await onProgress(cp)
  }

  if (runId) {
    await db().from('pipeline_runs').update({
      status: 'success', finished_at: new Date().toISOString(),
      stats: { stage: 'references', mentions: cp.mentions_created },
    }).eq('id', runId)
  }
  return { done: true, checkpoint: cp }
}

// ── Resolution (CrossRef → PubMed) ──────────────────────────
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}
function fingerprintOf(title: string, year: number | null, doi: string | null): string {
  if (doi) return `doi:${doi.toLowerCase()}`
  return `t:${normalizeTitle(title)}${year ? `:${year}` : ''}`
}
function titleOverlap(a: string, b: string): number {
  const at = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 3))
  const bt = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 3))
  if (at.size === 0 || bt.size === 0) return 0
  let hit = 0
  for (const w of at) if (bt.has(w)) hit++
  return hit / Math.min(at.size, bt.size)
}

// Minimum-specificity gate: only attempt resolution when the mention is
// identifiable enough to VERIFY. A DOI, or a real title (>= 3 substantive
// words). Vague mentions ("a NEJM paper about 700 couples") never resolve —
// presenting a wrong citation as verified is worse than none.
const MIN_TITLE_OVERLAP = 0.6
function resolvableTitle(title?: string): boolean {
  return !!title && normalizeTitle(title).split(' ').filter(w => w.length > 3).length >= 3
}
function canAttemptResolution(parsed: ParsedRef): boolean {
  return !!parsed.doi || resolvableTitle(parsed.title)
}
// A candidate is acceptable only if it strongly matches the mention's title and
// (when both known) the publication year.
function candidateMatches(parsed: ParsedRef, candTitle: string, candYear: number | null): boolean {
  if (!parsed.title) return false // never accept a fuzzy match without a title to check
  if (titleOverlap(parsed.title, candTitle) < MIN_TITLE_OVERLAP) return false
  if (parsed.year && candYear && Math.abs(parsed.year - candYear) > 1) return false
  return true
}

type ResolvedRef = {
  type: string; title: string; authors: string[]; year: number | null
  journal: string | null; doi: string | null; url: string | null
  resolved_source: 'crossref' | 'pubmed'
}

async function resolveViaCrossref(parsed: ParsedRef): Promise<ResolvedRef | null> {
  await throttle()
  try {
    if (parsed.doi) {
      const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(parsed.doi)}`, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (res.ok) {
        const j = await res.json()
        return crossrefItem(j.message)
      }
    }
    const query = [parsed.title, (parsed.authors ?? [])[0], parsed.year].filter(Boolean).join(' ')
    if (!query.trim()) return null
    const res = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=1`,
      { headers: { 'User-Agent': USER_AGENT } }
    )
    if (!res.ok) return null
    const j = await res.json()
    const item = j.message?.items?.[0]
    if (!item) return null
    const candidate = crossrefItem(item)
    if (!candidate) return null
    // Only accept a strong, year-consistent title match (never a fuzzy top hit).
    if (!candidateMatches(parsed, candidate.title, candidate.year)) return null
    return candidate
  } catch {
    return null
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

async function resolveViaPubmed(parsed: ParsedRef): Promise<ResolvedRef | null> {
  const term = [parsed.title, parsed.year].filter(Boolean).join(' ')
  if (!term.trim()) return null
  try {
    await throttle()
    const esearch = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=1&term=${encodeURIComponent(term)}`,
      { headers: { 'User-Agent': USER_AGENT } }
    )
    if (!esearch.ok) return null
    const sj = await esearch.json()
    const pmid = sj.esearchresult?.idlist?.[0]
    if (!pmid) return null
    await throttle()
    const esum = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}`,
      { headers: { 'User-Agent': USER_AGENT } }
    )
    if (!esum.ok) return null
    const uj = await esum.json()
    const doc = uj.result?.[pmid]
    if (!doc?.title) return null
    const year = doc.pubdate ? parseInt(String(doc.pubdate).slice(0, 4), 10) : null
    if (!candidateMatches(parsed, doc.title, Number.isFinite(year) ? year : null)) return null
    const doi = (doc.articleids ?? []).find((x: { idtype: string; value: string }) => x.idtype === 'doi')?.value ?? null
    return {
      type: 'journal_article',
      title: doc.title.replace(/\.$/, ''),
      authors: (doc.authors ?? []).map((a: { name: string }) => a.name).filter(Boolean),
      year: Number.isFinite(year) ? year : null,
      journal: doc.fulljournalname ?? doc.source ?? null,
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      resolved_source: 'pubmed',
    }
  } catch {
    return null
  }
}

/**
 * Final trust gate: confirm the database record is actually the specific work
 * the speaker referred to (not just a topically-similar paper). Catches the
 * "generic topic phrase → arbitrary real paper" failure mode. Only YES accepts.
 */
async function verifyMatch(rawText: string, r: ResolvedRef): Promise<boolean> {
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: REFERENCE_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'A speaker referred to an external published work. A citation database returned a candidate record. Decide if the candidate is plausibly the SAME specific work the speaker meant. If the speaker only named a general topic, technique, or field (not a specific identifiable work), answer NO. Answer with STRICT JSON {"same": true|false}.',
        },
        {
          role: 'user',
          content: `Speaker referred to: "${rawText}"\n\nCandidate record:\nTitle: ${r.title}\nJournal: ${r.journal ?? '—'}\nYear: ${r.year ?? '—'}\nAuthors: ${(r.authors ?? []).slice(0, 3).join(', ') || '—'}`,
        },
      ],
      response_format: { type: 'json_object' },
    })
    const raw = completion.choices[0]?.message?.content
    if (!raw) return false
    return JSON.parse(raw).same === true
  } catch {
    return false
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
  const cache = new Map<string, string | null>() // fingerprint-ish key → reference_id or null(not_found)
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

      let referenceId: string | null
      if (!canAttemptResolution(parsed)) {
        // Too vague to verify — do not guess a citation.
        referenceId = null
      } else {
        const cacheKey = fingerprintOf(parsed.title ?? parsed.doi ?? '(none)', parsed.year ?? null, parsed.doi ?? null)
        if (cache.has(cacheKey)) {
          referenceId = cache.get(cacheKey)!
        } else {
          const resolved = (await resolveViaCrossref(parsed)) ?? (await resolveViaPubmed(parsed))
          // Final LLM gate: accept only if the candidate is truly the work meant.
          referenceId = resolved && (await verifyMatch(m.raw_text, resolved)) ? await upsertReference(resolved) : null
          cache.set(cacheKey, referenceId)
        }
      }

      if (referenceId) {
        await db().from('reference_mentions').update({ resolution_status: 'resolved', reference_id: referenceId }).eq('id', m.id)
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
