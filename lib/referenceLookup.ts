/**
 * Study lookup for the reference layer: take one spoken citation, find the real paper.
 *
 * Why this file exists (2026-11-08 ten-episode test, 2026-11-09 fixes). The first resolver found the
 * right paper for 7 of 153 citations (5%). Five causes, fixed here:
 *
 *   1. It skipped about 75% of citations without searching, because a rule demanded a full title, or a
 *      journal plus a year or author. Speakers almost never give that. Now every citation that could be
 *      a scientific work is searched; only non-science items (a journalism book, a talk) are dropped,
 *      and the drop is a recorded decision (`skipped`), not a silent gate.
 *   2. A database that refused the request (OpenAlex answers "anonymous rate limited" with HTTP 429) was
 *      read as "no results", and the citation was marked not_found for good. Now PubMed (free, no key)
 *      goes first, a refusal or outage is retried with backoff, and a citation whose lookup FAILED is
 *      `deferred` (left pending, retried on the next pass), never `not_found`.
 *   3. The search was the speaker's raw words. Now a small model writes the search from the whole
 *      context: guest, episode, year, and the finding described ("Dixit lab, caloric restriction,
 *      thymus" finds the CALERIE paper).
 *   4. A shortcut reused an earlier answer for any two citations with the same year when neither had a
 *      title (key `(none):2013`), so a JAMA 2013 paper got a NEJM 2013 answer. A reused answer now needs
 *      a specific identity (DOI, real title, trial name, or author plus year); a bare year or journal
 *      never qualifies.
 *   5. The same work was searched every time it was mentioned (REDUCE-IT eight times in one episode).
 *      Now one identity is one lookup; later mentions reuse the answer.
 *
 * Precision is unchanged in kind: a model judge still has to pick the SAME specific work from the
 * candidates (abstract versus the finding described) at confidence 0.7 or more, otherwise the citation
 * is not linked. A wrong citation is worse than none.
 *
 * No Supabase here: everything outside the model and the network is injectable, so
 * tests/referenceLookup.test.ts runs it with fakes and a fake clock. lib/references.ts does the writes.
 */

import { claudeJson, CLAUDE_BULK_MODEL, CLAUDE_JUDGMENT_MODEL, ModelRefusalError } from './llm'
import { PipelineHaltError, UsageLimitError } from './usageLimit'

const CONTACT_MAILTO = process.env.REFERENCE_CONTACT_EMAIL || 'team@admissionsacademy.org'
const USER_AGENT = `LifestyleAcademy/1.0 (mailto:${CONTACT_MAILTO})`

/** The judge must be at least this sure, otherwise the citation stays unlinked. */
export const AUTO_ACCEPT_CONFIDENCE = 0.7

// ── Types ───────────────────────────────────────────────────

export type ParsedRef = {
  raw_text?: string
  type?: string | null
  title?: string | null
  authors?: string[] | null
  year?: number | null
  journal?: string | null
  doi?: string | null
  context?: string | null // the finding the speaker attributes to the work (the disambiguator)
}

export type ResolvedRef = {
  type: string
  title: string
  authors: string[]
  year: number | null
  journal: string | null
  doi: string | null
  url: string | null
  abstract?: string | null
  resolved_source: 'crossref' | 'pubmed' | 'openalex'
}

export type EpisodeInfo = { title: string | null; people: string[]; date?: string | null }

export type SearchPlan = {
  searchable: boolean
  skip_reason: 'not_scientific' | 'too_vague' | null
  pubmed: string
  plain: string
  trial_name: string | null
  first_author: string | null
  year: number | null
  journal: string | null
  variant: string | null
}

export type Judgement = { index: number | null; confidence: number }

export type DatabaseName = 'pubmed' | 'crossref' | 'openalex'
export type DatabaseReport = { name: DatabaseName; ok: boolean; count: number; error?: string }

export type MentionOutcome = 'resolved' | 'not_found' | 'skipped' | 'deferred'
export type MentionReason =
  | 'accepted' // judge picked a candidate
  | 'cache_hit' // the same work was already looked up this pass
  | 'not_scientific' // the writer says it is not a scientific work (journalism book, talk)
  | 'too_vague' // nothing to search with
  | 'no_candidates' // every database answered, none had anything
  | 'judge_rejected' // candidates found, none was clearly the work
  | 'lookup_failed' // a database failed and nothing else answered: try again later
  | 'model_failed' // the model call failed (not a refusal): try again later
  | 'model_refused' // the model declined this text: retrying will not help

export type MentionResult = {
  outcome: MentionOutcome
  reason: MentionReason
  accepted: ResolvedRef | null
  confidence: number
  /** Identity under which this answer is shared with other mentions of the same work (null = never shared). */
  key: string | null
  cacheHit: boolean
  plan: SearchPlan | null
  candidates: ResolvedRef[]
  judge: Judgement | null
  databases: DatabaseReport[]
}

export type LookupDeps = {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Model call: write the search for one citation. May throw. */
  planSearch: (input: PlanInput) => Promise<Partial<SearchPlan>>
  /** Model call: pick the candidate that is the same work. May throw. */
  judge: (input: JudgeInput) => Promise<Judgement>
}

export type PlanInput = { raw: string; parsed: ParsedRef; episode: EpisodeInfo }
export type JudgeInput = { raw: string; parsed: ParsedRef; episode: EpisodeInfo; candidates: ResolvedRef[] }

// ── Text helpers ────────────────────────────────────────────

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

/** A title long enough to name one work: three or more words of four letters or more. */
export function resolvableTitle(title?: string | null): boolean {
  return !!title && normalizeTitle(title).split(' ').filter(w => w.length > 3).length >= 3
}

function foldAscii(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** "REDUCE-IT trial" / "the Reduce IT study" → "reduceit". Spaces and hyphens vanish so spellings meet. */
export function normalizeTrialName(s?: string | null): string | null {
  if (!s) return null
  const n = foldAscii(s).toLowerCase()
    .replace(/\b(the|trial|trials|study|studies|cohort|investigators)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
  return n.length >= 2 ? n : null
}

/**
 * "Dan Belsky" / "Dr. Belsky" / "Belsky DW" / "JoAnn Manson, M.D." → the surname, lowercase ("belsky", "manson").
 * Text after a comma is dropped (a degree, or the given name of "Surname, Given"); trailing initials and titles too.
 */
export function normalizeSurname(s?: string | null): string | null {
  if (!s) return null
  const tokens = foldAscii(s.split(',')[0]).split(/\s+/)
    .filter(t => t && !/^(dr|prof|professor|mr|mrs|ms|md|m\.d|phd|ph\.d|jr|sr|ii|iii)\.?$/i.test(t) && !/^[A-Z]{1,3}\.?$/.test(t) && !/^([A-Z]\.)+$/.test(t))
  const last = tokens.length ? tokens[tokens.length - 1].toLowerCase().replace(/[^a-z]/g, '') : ''
  return last.length >= 2 ? last : null
}

function words(s?: string | null): string | null {
  if (!s) return null
  const n = normalizeTitle(s)
  return n || null
}

/**
 * The identity under which two mentions may share ONE lookup (fixes 4 and 5).
 *
 * Shared only when the mention names a specific work: a DOI, a real title, a named trial, or a lead
 * author with a year. A bare year, journal or description returns null, so two untitled "2013" citations
 * never share an answer. Everything that tells two papers of one trial apart (year, lead author, journal,
 * "10-year follow-up") is part of the key, so "the WHI" and "the WHI 2013 reanalysis" are looked up
 * separately.
 */
export function workKey(parsed: ParsedRef, plan: Pick<SearchPlan, 'trial_name' | 'first_author' | 'year' | 'journal' | 'variant'> | null): string | null {
  if (parsed.doi) return `doi:${parsed.doi.toLowerCase().trim()}`
  if (resolvableTitle(parsed.title)) return `title:${normalizeTitle(parsed.title!)}${parsed.year ? `:${parsed.year}` : ''}`
  if (!plan) return null
  const trial = normalizeTrialName(plan.trial_name)
  const author = normalizeSurname(plan.first_author)
  const year = plan.year ?? parsed.year ?? null
  if (!trial && !(author && year)) return null
  return ['work', trial ?? '', author ?? '', year ?? '', words(plan.journal ?? parsed.journal) ?? '', words(plan.variant) ?? ''].join('|')
}

// ── Network: retries, pacing, failure reporting ─────────────

type Fetched = { ok: true; status: number; body: string } | { ok: false; status: number; error: string }

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null
  const n = Number(h)
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null
}

/** A pacer that keeps calls to one host at least `minMs` apart, even when many run at once. */
function makePacer(minMs: number, deps: Pick<LookupDeps, 'now' | 'sleep'>) {
  let next = 0
  return async () => {
    const t = deps.now()
    const start = Math.max(t, next)
    next = start + minMs
    if (start > t) await deps.sleep(start - t)
  }
}

type HostConfig = { pace: () => Promise<void>; attempts: number }

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * GET with backoff. A busy or broken database (429, 5xx, a dropped connection) is retried, honouring
 * Retry-After; if it never answers, the result says so (`ok: false`). It never pretends to be an empty answer.
 */
async function getWithRetry(url: string, host: HostConfig, deps: LookupDeps): Promise<Fetched> {
  let lastError = 'no attempt'
  let lastStatus = 0
  for (let attempt = 1; attempt <= host.attempts; attempt++) {
    await host.pace()
    try {
      const res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      lastStatus = res.status
      if (res.ok) return { ok: true, status: res.status, body: await res.text() }
      lastError = `HTTP ${res.status}`
      if (!RETRY_STATUS.has(res.status)) return { ok: false, status: res.status, error: lastError }
      if (attempt < host.attempts) {
        const wait = Math.min(parseRetryAfter(res.headers?.get?.('retry-after') ?? null) ?? 1500 * 2 ** (attempt - 1), 30_000)
        await deps.sleep(wait)
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      if (attempt < host.attempts) await deps.sleep(Math.min(1500 * 2 ** (attempt - 1), 30_000))
    }
  }
  return { ok: false, status: lastStatus, error: lastError }
}

// ── Databases ───────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse the XML PubMed's efetch returns. Exported for tests. */
export function parsePubMedXml(xml: string): ResolvedRef[] {
  const out: ResolvedRef[] = []
  for (const block of xml.split('<PubmedArticle>').slice(1)) {
    const one = (re: RegExp) => decodeEntities(block.match(re)?.[1] ?? '')
    const title = one(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)
    if (!title) continue
    const pmid = one(/<PMID[^>]*>(\d+)<\/PMID>/)
    const doi = one(/<ArticleId IdType="doi">([^<]+)</) || null
    const yearText = one(/<PubDate>\s*<Year>(\d{4})/) || one(/<ArticleDate[^>]*>\s*<Year>(\d{4})/) || one(/<MedlineDate>\s*(\d{4})/)
    const abstract = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map(m => decodeEntities(m[1])).join(' ').slice(0, 1200)
    const authors: string[] = []
    for (const a of block.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/g)) {
      const last = decodeEntities(a[1].match(/<LastName>([\s\S]*?)<\/LastName>/)?.[1] ?? '')
      const fore = decodeEntities(a[1].match(/<ForeName>([\s\S]*?)<\/ForeName>/)?.[1] ?? '')
      const collective = decodeEntities(a[1].match(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/)?.[1] ?? '')
      const name = last ? [fore, last].filter(Boolean).join(' ') : collective
      if (name) authors.push(name)
      if (authors.length >= 12) break
    }
    out.push({
      type: 'journal_article',
      title,
      authors,
      year: Number(yearText) || null,
      journal: one(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/) || null,
      doi,
      url: doi ? `https://doi.org/${doi}` : pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
      abstract: abstract || null,
      resolved_source: 'pubmed',
    })
  }
  return out
}

type DbResult = { report: DatabaseReport; items: ResolvedRef[] }

async function searchPubMed(query: string, hosts: Hosts, deps: LookupDeps): Promise<DbResult> {
  const q = query.trim().slice(0, 400)
  const fail = (error: string): DbResult => ({ report: { name: 'pubmed', ok: false, count: 0, error }, items: [] })
  if (!q) return { report: { name: 'pubmed', ok: true, count: 0 }, items: [] }
  const key = process.env.NCBI_API_KEY ? `&api_key=${encodeURIComponent(process.env.NCBI_API_KEY)}` : ''
  const common = `tool=lifestyleacademy&email=${encodeURIComponent(CONTACT_MAILTO)}${key}`
  const s = await getWithRetry(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=8&sort=relevance&${common}&term=${encodeURIComponent(q)}`,
    hosts.pubmed, deps)
  if (!s.ok) return fail(s.error)
  let ids: string[]
  try {
    const j = JSON.parse(s.body)
    // NCBI sometimes answers HTTP 200 with an error body when it is rate limiting: that is a failure, not "no hits".
    if (j.error || j.esearchresult?.ERROR || !Array.isArray(j.esearchresult?.idlist)) return fail(String(j.error ?? j.esearchresult?.ERROR ?? 'unexpected PubMed answer'))
    ids = j.esearchresult.idlist
  } catch {
    return fail('PubMed answer was not JSON')
  }
  if (ids.length === 0) return { report: { name: 'pubmed', ok: true, count: 0 }, items: [] }
  const f = await getWithRetry(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&${common}&id=${ids.join(',')}`,
    hosts.pubmed, deps)
  if (!f.ok) return fail(f.error)
  const items = parsePubMedXml(f.body)
  return { report: { name: 'pubmed', ok: true, count: items.length }, items }
}

function crossrefItem(item: {
  title?: string[]; author?: { given?: string; family?: string }[]; DOI?: string
  'container-title'?: string[]; issued?: { 'date-parts'?: number[][] }; type?: string; URL?: string
}): ResolvedRef | null {
  const title = item.title?.[0]
  if (!title) return null
  const typeMap: Record<string, string> = { 'journal-article': 'journal_article', book: 'book', 'proceedings-article': 'journal_article' }
  return {
    type: typeMap[item.type ?? ''] ?? 'journal_article',
    title: decodeEntities(title),
    authors: (item.author ?? []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    year: item.issued?.['date-parts']?.[0]?.[0] ?? null,
    journal: item['container-title']?.[0] ?? null,
    doi: item.DOI ?? null,
    url: item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : null),
    resolved_source: 'crossref',
  }
}

async function searchCrossref(query: string, doi: string | null, hosts: Hosts, deps: LookupDeps): Promise<DbResult> {
  const fail = (error: string): DbResult => ({ report: { name: 'crossref', ok: false, count: 0, error }, items: [] })
  if (doi) {
    const d = await getWithRetry(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, hosts.crossref, deps)
    if (d.ok) {
      try {
        const c = crossrefItem(JSON.parse(d.body).message)
        if (c) return { report: { name: 'crossref', ok: true, count: 1 }, items: [c] }
      } catch { /* fall through to the text search */ }
    }
  }
  const q = query.trim().slice(0, 300)
  if (!q) return { report: { name: 'crossref', ok: true, count: 0 }, items: [] }
  const r = await getWithRetry(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=4&mailto=${encodeURIComponent(CONTACT_MAILTO)}`, hosts.crossref, deps)
  if (!r.ok) return fail(r.error)
  try {
    const items = ((JSON.parse(r.body).message?.items ?? []) as Parameters<typeof crossrefItem>[0][]).map(crossrefItem).filter((x): x is ResolvedRef => !!x)
    return { report: { name: 'crossref', ok: true, count: items.length }, items }
  } catch {
    return fail('Crossref answer was not JSON')
  }
}

function reconstructAbstract(inv?: Record<string, number[]>): string | null {
  if (!inv) return null
  const ws: { pos: number; w: string }[] = []
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) ws.push({ pos: p, w })
  return ws.length ? ws.sort((a, b) => a.pos - b.pos).map(x => x.w).join(' ').slice(0, 1200) : null
}

/** OpenAlex: last-resort backup. It meters anonymous traffic by IP and answers 429 once the day's budget is gone. */
async function searchOpenAlex(query: string, hosts: Hosts, deps: LookupDeps): Promise<DbResult> {
  const fail = (error: string): DbResult => ({ report: { name: 'openalex', ok: false, count: 0, error }, items: [] })
  const q = query.trim().slice(0, 300)
  if (!q) return { report: { name: 'openalex', ok: true, count: 0 }, items: [] }
  const key = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : ''
  const r = await getWithRetry(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=5&mailto=${encodeURIComponent(CONTACT_MAILTO)}${key}`, hosts.openalex, deps)
  if (!r.ok) return fail(r.error)
  try {
    const results = (JSON.parse(r.body).results ?? []) as {
      title?: string; publication_year?: number; doi?: string; type?: string
      authorships?: { author?: { display_name?: string } }[]
      primary_location?: { source?: { display_name?: string } }
      abstract_inverted_index?: Record<string, number[]>
    }[]
    const items: ResolvedRef[] = []
    for (const w of results) {
      if (!w.title) continue
      const doi = w.doi ? w.doi.replace('https://doi.org/', '') : null
      items.push({
        type: w.type === 'book' ? 'book' : 'journal_article',
        title: decodeEntities(w.title),
        authors: (w.authorships ?? []).map(a => a.author?.display_name).filter((x): x is string => !!x),
        year: w.publication_year ?? null,
        journal: w.primary_location?.source?.display_name ?? null,
        doi,
        url: doi ? `https://doi.org/${doi}` : null,
        abstract: reconstructAbstract(w.abstract_inverted_index),
        resolved_source: 'openalex',
      })
    }
    return { report: { name: 'openalex', ok: true, count: items.length }, items }
  } catch {
    return fail('OpenAlex answer was not JSON')
  }
}

type Hosts = { pubmed: HostConfig; crossref: HostConfig; openalex: HostConfig }

export type Gathered = { candidates: ResolvedRef[]; databases: DatabaseReport[] }

/** Merge candidate lists, first list wins a tie (PubMed first: its records carry abstracts). */
function mergeCandidates(...lists: ResolvedRef[][]): ResolvedRef[] {
  const seen = new Set<string>()
  const out: ResolvedRef[] = []
  for (const c of lists.flat()) {
    const key = c.doi ? `doi:${c.doi.toLowerCase()}` : `t:${normalizeTitle(c.title)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out.slice(0, 10)
}

// ── Model calls (the defaults; tests inject fakes) ──────────

const PLAN_SYSTEM = `
You turn a spoken reference to a published work, made on a health and longevity podcast, into search queries for PubMed and Crossref.

Return STRICT JSON:
{"searchable": <true|false>, "skip_reason": <null | "not_scientific" | "too_vague">,
 "pubmed": <a PubMed query: lead author[AU], year[DP], distinctive title words, trial acronym, design terms (randomized controlled trial, meta-analysis, cohort). Specific, not long.>,
 "plain": <a short natural-language query: lead author surname, year, topic, design, journal if known>,
 "trial_name": <the acronym or name of a named trial or study when the speaker names one, else null>,
 "first_author": <surname of the lead author when stated or strongly implied by the guest or episode, else null>,
 "year": <publication year when stated or clearly implied, else null>,
 "journal": <journal when stated, else null>,
 "variant": <null, or a few words when the speaker means a specific follow-up, subgroup, reanalysis or meta-analysis of a named work>}

searchable is false ONLY when the mention cannot be a scientific, clinical or nutrition-science publication: a non-science book, a film, a news story, a general talk, a person or company, or an allusion with no identifiable work at all ("a study showed it"). A scientific or medical book IS searchable. When unsure, set searchable true: a separate check rejects wrong matches.
Use the episode title and the people in it to work out who "we", "my lab" or "the Belsky paper" means. Never invent an author or year that is not stated or strongly implied.
`.trim()

const JUDGE_SYSTEM = `
A speaker on a medical podcast referred to an external published work. Choose which candidate (if any) is the SAME specific work.
Match on substance: the described finding, population, topic and era must fit the candidate's abstract and metadata, and the speaker's author, year and journal clues must not conflict.
For a named trial or cohort, accept only the primary results publication of that trial unless the speaker describes a follow-up.
If the speaker only named a topic, a cohort with many papers, or no candidate clearly fits, return index null.
Return STRICT JSON {"index": <number or null>, "confidence": <0..1>}.
`.trim()

function episodeLine(e: EpisodeInfo): string {
  return `Episode: ${e.title ?? 'unknown'} (people: ${e.people.join(', ') || 'unknown'}${e.date ? `; published ${e.date}` : ''})`
}

async function defaultPlanSearch(input: PlanInput): Promise<Partial<SearchPlan>> {
  return claudeJson<Partial<SearchPlan>>(
    PLAN_SYSTEM,
    `Spoken: "${input.raw}"\nParsed fields: ${JSON.stringify({ ...input.parsed, raw_text: undefined })}\n${episodeLine(input.episode)}`,
    700,
    CLAUDE_BULK_MODEL
  )
}

async function defaultJudge(input: JudgeInput): Promise<Judgement> {
  const list = input.candidates
    .map((c, i) => `[${i}] "${c.title}" — ${(c.authors ?? []).slice(0, 3).join(', ') || 'n/a'}, ${c.journal ?? 'n/a'}, ${c.year ?? 'n/a'}${c.abstract ? `\n    abstract: ${c.abstract.slice(0, 450)}` : ''}`)
    .join('\n')
  const j = await claudeJson<{ index?: number | null; confidence?: number }>(
    JUDGE_SYSTEM,
    `Speaker said: "${input.raw}"\nFinding described: ${input.parsed.context ?? 'n/a'}\n${episodeLine(input.episode)}\n\nCandidates:\n${list}`,
    800,
    CLAUDE_JUDGMENT_MODEL
  )
  const index = typeof j.index === 'number' && Number.isInteger(j.index) && j.index >= 0 && j.index < input.candidates.length ? j.index : null
  return { index, confidence: typeof j.confidence === 'number' ? j.confidence : 0 }
}

export function defaultDeps(): LookupDeps {
  return {
    fetch: (...a) => fetch(...a),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    planSearch: defaultPlanSearch,
    judge: defaultJudge,
  }
}

// ── Search plan: sanitize the model's answer, or fall back to the parsed fields ──

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null
}

/** The search to run when the model gave nothing usable: built from what the extractor parsed. */
export function fallbackPlan(raw: string, parsed: ParsedRef): SearchPlan {
  const surname = parsed.authors?.length ? normalizeSurname(parsed.authors[0]) : null
  const base = [parsed.title, parsed.authors?.slice(0, 2).join(' '), parsed.year, parsed.journal].filter(Boolean).join(' ').trim() || raw
  return {
    searchable: true, skip_reason: null,
    pubmed: base.slice(0, 300), plain: base.slice(0, 300),
    trial_name: null, first_author: surname, year: parsed.year ?? null, journal: parsed.journal ?? null, variant: null,
  }
}

export function sanitizePlan(p: Partial<SearchPlan> | null | undefined, raw: string, parsed: ParsedRef): SearchPlan {
  const fb = fallbackPlan(raw, parsed)
  if (!p || typeof p !== 'object') return fb
  const year = typeof p.year === 'number' && p.year > 1900 && p.year < 2100 ? Math.round(p.year) : null
  const skip = p.skip_reason === 'not_scientific' || p.skip_reason === 'too_vague' ? p.skip_reason : null
  const searchable = p.searchable === false
  return {
    searchable: !searchable,
    skip_reason: searchable ? skip ?? 'not_scientific' : null,
    pubmed: str(p.pubmed) ?? fb.pubmed,
    plain: str(p.plain) ?? fb.plain,
    trial_name: str(p.trial_name),
    first_author: str(p.first_author) ?? fb.first_author,
    year: year ?? parsed.year ?? null,
    journal: str(p.journal) ?? parsed.journal ?? null,
    variant: str(p.variant),
  }
}

// ── The lookup ──────────────────────────────────────────────

function isFatal(e: unknown): boolean {
  return e instanceof PipelineHaltError || e instanceof UsageLimitError
}

type CacheEntry = { accepted: ResolvedRef | null; confidence: number; reason: MentionReason }

export type ReferenceLookup = {
  resolveMention(input: { raw: string; parsed: ParsedRef; episode: EpisodeInfo }): Promise<MentionResult>
  /** How many distinct works have an answer this pass (for logs and tests). */
  cacheSize(): number
}

export function createReferenceLookup(overrides: Partial<LookupDeps> = {}): ReferenceLookup {
  const deps: LookupDeps = { ...defaultDeps(), ...overrides }
  const pubmedMs = process.env.NCBI_API_KEY ? 120 : 340
  const hosts: Hosts = {
    pubmed: { pace: makePacer(pubmedMs, deps), attempts: 4 },
    crossref: { pace: makePacer(150, deps), attempts: 3 },
    // A refused anonymous OpenAlex request stays refused for the day: try once more, then give up fast.
    openalex: { pace: makePacer(400, deps), attempts: 2 },
  }
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<MentionResult>>()
  // Stop calling OpenAlex for a while once it has refused three requests in a row.
  const openAlexBreaker = { consecutiveFailures: 0, pausedUntil: 0 }

  async function gather(plan: SearchPlan, parsed: ParsedRef, raw: string): Promise<Gathered> {
    const databases: DatabaseReport[] = []
    const pubmedQuery = plan.pubmed || plan.plain || raw
    const plainQuery = plan.plain || plan.pubmed || raw

    // PubMed first (free, no key). Crossref runs beside it for books, DOI lookups and anything PubMed lacks.
    const [pm, cr] = await Promise.all([
      searchPubMed(pubmedQuery, hosts, deps),
      searchCrossref(plainQuery, parsed.doi ?? null, hosts, deps),
    ])
    databases.push(pm.report, cr.report)
    let pubmedItems = pm.items
    // The structured PubMed query found nothing: relax to the plain-language wording once.
    if (pm.report.ok && pubmedItems.length === 0 && plainQuery !== pubmedQuery) {
      const again = await searchPubMed(plainQuery, hosts, deps)
      databases.push({ ...again.report })
      pubmedItems = again.items
    }
    let candidates = mergeCandidates(pubmedItems, cr.items)

    // Backup: OpenAlex, only when the two main databases produced nothing at all.
    if (candidates.length === 0) {
      if (deps.now() < openAlexBreaker.pausedUntil) {
        databases.push({ name: 'openalex', ok: false, count: 0, error: 'paused after repeated refusals' })
      } else {
        const oa = await searchOpenAlex(plainQuery, hosts, deps)
        databases.push(oa.report)
        if (oa.report.ok) openAlexBreaker.consecutiveFailures = 0
        else if (++openAlexBreaker.consecutiveFailures >= 3) openAlexBreaker.pausedUntil = deps.now() + 5 * 60_000
        candidates = mergeCandidates(oa.items)
      }
    }
    return { candidates, databases }
  }

  async function resolveMention(input: { raw: string; parsed: ParsedRef; episode: EpisodeInfo }): Promise<MentionResult> {
    const { raw, episode } = input
    const parsed = input.parsed ?? {}
    const base: MentionResult = {
      outcome: 'not_found', reason: 'no_candidates', accepted: null, confidence: 0, key: null,
      cacheHit: false, plan: null, candidates: [], judge: null, databases: [],
    }
    const fromCache = (key: string, hit: CacheEntry, plan: SearchPlan | null): MentionResult => ({
      ...base, outcome: hit.accepted ? 'resolved' : 'not_found', reason: hit.accepted ? 'cache_hit' : hit.reason,
      accepted: hit.accepted, confidence: hit.confidence, key, cacheHit: true, plan,
    })

    // Nothing to go on at all: no model call, no search.
    const hasHandle = !!(parsed.doi || parsed.title || parsed.authors?.length || parsed.year || parsed.journal || (parsed.context ?? '').trim().length >= 20 || raw.trim().length >= 15)
    if (!hasHandle) return { ...base, outcome: 'skipped', reason: 'too_vague' }

    // A DOI or a real title already says which work this is: reuse before spending a model call.
    const earlyKey = workKey(parsed, null)
    if (earlyKey && cache.has(earlyKey)) return fromCache(earlyKey, cache.get(earlyKey)!, null)

    let plan: SearchPlan
    try {
      plan = sanitizePlan(await deps.planSearch({ raw, parsed, episode }), raw, parsed)
    } catch (e) {
      if (isFatal(e)) throw e
      if (e instanceof ModelRefusalError) return { ...base, outcome: 'not_found', reason: 'model_refused' }
      plan = fallbackPlan(raw, parsed) // a failed writer costs recall, not the citation
    }
    if (!plan.searchable) return { ...base, outcome: 'skipped', reason: plan.skip_reason ?? 'not_scientific', plan }

    const key = earlyKey ?? workKey(parsed, plan)
    if (key && cache.has(key)) return fromCache(key, cache.get(key)!, plan)

    // Another mention of the same work is being looked up right now (mentions can run side by side):
    // wait for its answer instead of searching again.
    if (key) {
      const running = inflight.get(key)
      if (running) {
        await running.catch(() => undefined)
        if (cache.has(key)) return fromCache(key, cache.get(key)!, plan)
      }
    }

    const work = searchAndJudge({ raw, parsed, episode }, plan, key, base)
    if (key) inflight.set(key, work)
    try {
      return await work
    } finally {
      if (key && inflight.get(key) === work) inflight.delete(key)
    }
  }

  async function searchAndJudge(
    input: { raw: string; parsed: ParsedRef; episode: EpisodeInfo },
    plan: SearchPlan,
    key: string | null,
    base: MentionResult
  ): Promise<MentionResult> {
    const { raw, parsed, episode } = input
    const { candidates, databases } = await gather(plan, parsed, raw)
    const result: MentionResult = { ...base, key, plan, candidates, databases }

    if (candidates.length === 0) {
      // A database that failed is not an empty answer: try this citation again later.
      if (databases.some(d => !d.ok)) return { ...result, outcome: 'deferred', reason: 'lookup_failed' }
      if (key) cache.set(key, { accepted: null, confidence: 0, reason: 'no_candidates' })
      return result
    }

    let judge: Judgement
    try {
      judge = await deps.judge({ raw, parsed, episode, candidates })
    } catch (e) {
      if (isFatal(e)) throw e
      if (e instanceof ModelRefusalError) return { ...result, outcome: 'not_found', reason: 'model_refused' }
      return { ...result, outcome: 'deferred', reason: 'model_failed' }
    }
    result.judge = judge
    if (judge.index !== null && judge.confidence >= AUTO_ACCEPT_CONFIDENCE) {
      const accepted = candidates[judge.index]
      if (key) cache.set(key, { accepted, confidence: judge.confidence, reason: 'accepted' })
      return { ...result, outcome: 'resolved', reason: 'accepted', accepted, confidence: judge.confidence }
    }
    if (key) cache.set(key, { accepted: null, confidence: judge.confidence, reason: 'judge_rejected' })
    return { ...result, outcome: 'not_found', reason: 'judge_rejected' }
  }

  return { resolveMention, cacheSize: () => cache.size }
}
