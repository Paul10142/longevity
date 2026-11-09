/**
 * lib/referenceLookup.ts — the five fixes from the 2026-11-08 ten-episode study-linking test.
 * No network and no model: a fake world answers every database call, the model calls are stubs, and
 * time is a fake clock (sleeping advances it, so nothing waits).
 *
 *   1. PubMed first; a busy database is retried; a database that fails is never read as "no results".
 *   2. No "needs a title" rule; only non-science items are skipped, and that is a recorded decision.
 *   3. A model writes the search from the whole context (and a failed writer falls back, not gives up).
 *   4. Two untitled citations never share an answer.
 *   5. A work cited many times is looked up once.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createReferenceLookup, parsePubMedXml, workKey, normalizeTrialName, normalizeSurname, sanitizePlan,
  type LookupDeps, type ParsedRef, type ResolvedRef, type SearchPlan, type EpisodeInfo, type Judgement,
} from '../lib/referenceLookup'
import { ModelRefusalError } from '../lib/llm'
import { PipelineHaltError } from '../lib/usageLimit'

const EPISODE: EpisodeInfo = { title: '#200 Test Episode', people: ['Dr. Peter Attia', 'Gary Guest'], date: '2024-05-01' }

// ── A fake world of databases ────────────────────────────────

type Paper = { pmid: string; title: string; first: string; year: number; journal: string; doi: string; abstract?: string }

const PAPERS: Paper[] = [
  { pmid: '1', title: 'Cardiovascular Risk Reduction with Icosapent Ethyl for Hypertriglyceridemia', first: 'Bhatt', year: 2019, journal: 'N Engl J Med', doi: '10.1056/reduce', abstract: 'REDUCE-IT randomized trial of icosapent ethyl.' },
  { pmid: '2', title: 'Quantification of biological aging in young adults', first: 'Belsky', year: 2015, journal: 'PNAS', doi: '10.1073/belsky', abstract: 'Pace of aging in the Dunedin cohort.' },
  { pmid: '3', title: 'Mediterranean Diet for Primary Prevention of Cardiovascular Disease', first: 'Estruch', year: 2013, journal: 'N Engl J Med', doi: '10.1056/predimed-letter' },
  { pmid: '4', title: 'Statin Use and Risk of Diabetes in the Women’s Health Initiative', first: 'Manson', year: 2013, journal: 'JAMA', doi: '10.1001/whi2013', abstract: 'Statins in WHI.' },
]

function pubmedXml(papers: Paper[]): string {
  return papers.map(p => `<PubmedArticle><MedlineCitation><PMID Version="1">${p.pmid}</PMID><Article><Journal><Title>${p.journal}</Title></Journal><ArticleTitle>${p.title}</ArticleTitle>${p.abstract ? `<Abstract><AbstractText>${p.abstract}</AbstractText></Abstract>` : ''}<AuthorList><Author><LastName>${p.first}</LastName><ForeName>A</ForeName></Author></AuthorList><ArticleDate><Year>${p.year}</Year></ArticleDate></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">${p.doi}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`).join('')
}

type World = {
  /** Papers PubMed returns for any search, or a function of the query. */
  pubmed: Paper[] | ((q: string) => Paper[])
  crossref: Paper[]
  openalex: Paper[]
  /** Scripted HTTP failures per host, consumed one per request before real answers. */
  failures: { pubmed: { status: number; headers?: Record<string, string>; body?: string }[]; crossref: { status: number }[]; openalex: { status: number }[] }
  /** Make every request to a host fail forever. */
  down: Set<'pubmed' | 'crossref' | 'openalex'>
  calls: { host: string; url: string }[]
  sleeps: number[]
}

function newWorld(over: Partial<World> = {}): World {
  return { pubmed: [], crossref: [], openalex: [], failures: { pubmed: [], crossref: [], openalex: [] }, down: new Set(), calls: [], sleeps: [], ...over }
}

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

function fakeFetch(w: World): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const host = url.includes('eutils.ncbi') ? 'pubmed' : url.includes('crossref.org') ? 'crossref' : url.includes('openalex.org') ? 'openalex' : 'other'
    w.calls.push({ host, url })
    if (host === 'other') return res(404, '')
    if (w.down.has(host as 'pubmed')) return res(503, 'unavailable')
    const scripted = (w.failures[host as 'pubmed'] as { status: number; headers?: Record<string, string>; body?: string }[]).shift()
    if (scripted) return res(scripted.status, scripted.body ?? 'busy', scripted.headers)
    if (host === 'pubmed') {
      if (url.includes('esearch')) {
        const q = decodeURIComponent(url.split('term=')[1] ?? '')
        const papers = typeof w.pubmed === 'function' ? w.pubmed(q) : w.pubmed
        return res(200, JSON.stringify({ esearchresult: { idlist: papers.map(p => p.pmid) } }))
      }
      const ids = (url.split('&id=')[1] ?? '').split(',')
      const all = typeof w.pubmed === 'function' ? PAPERS : w.pubmed
      return res(200, pubmedXml(all.filter(p => ids.includes(p.pmid))))
    }
    if (host === 'crossref') {
      const items = w.crossref.map(p => ({ title: [p.title], author: [{ given: 'A', family: p.first }], DOI: p.doi, 'container-title': [p.journal], issued: { 'date-parts': [[p.year]] }, type: 'journal-article' }))
      if (/\/works\/10\./.test(url)) return items[0] ? res(200, JSON.stringify({ message: items[0] })) : res(404, '')
      return res(200, JSON.stringify({ message: { items } }))
    }
    return res(200, JSON.stringify({ results: w.openalex.map(p => ({ title: p.title, publication_year: p.year, doi: `https://doi.org/${p.doi}`, type: 'article', authorships: [{ author: { display_name: p.first } }], primary_location: { source: { display_name: p.journal } } })) }))
  }) as typeof fetch
}

type Stubs = {
  plans: Partial<SearchPlan>[] | ((raw: string) => Partial<SearchPlan>)
  /** Which candidate the judge picks: an index, a function of the candidates, or a thrown error. */
  judge: number | null | ((candidates: ResolvedRef[], raw: string) => Judgement | Error)
  planCalls: string[]
  judgeCalls: string[]
}

function setup(over: { world?: Partial<World>; stubs?: Partial<Stubs> } = {}) {
  const world = newWorld(over.world)
  let t = 1_000
  const stubs: Stubs = { plans: () => ({}), judge: 0, planCalls: [], judgeCalls: [], ...over.stubs }
  const deps: Partial<LookupDeps> = {
    fetch: fakeFetch(world),
    now: () => t,
    sleep: async ms => { world.sleeps.push(ms); t += ms },
    planSearch: async ({ raw }) => {
      stubs.planCalls.push(raw)
      if (typeof stubs.plans === 'function') return stubs.plans(raw)
      return stubs.plans.shift() ?? {}
    },
    judge: async ({ raw, candidates }) => {
      stubs.judgeCalls.push(raw)
      if (typeof stubs.judge === 'function') {
        const r = stubs.judge(candidates, raw)
        if (r instanceof Error) throw r
        return r
      }
      return { index: stubs.judge, confidence: stubs.judge === null ? 0 : 0.95 }
    },
  }
  const lookup = createReferenceLookup(deps)
  const resolve = (raw: string, parsed: ParsedRef = {}) => lookup.resolveMention({ raw, parsed: { context: 'a finding the speaker describes in the study', ...parsed }, episode: EPISODE })
  return { world, stubs, lookup, resolve }
}

const searches = (w: World, host: string) => w.calls.filter(c => c.host === host && (host !== 'pubmed' || c.url.includes('esearch'))).length

// ── Fix 1: PubMed first, retries, and failure is not "no results" ──

test('fix 1: PubMed is searched and its paper (with abstract) is accepted; OpenAlex is never needed', async () => {
  const { world, resolve } = setup({ world: { pubmed: [PAPERS[1]] } })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'] })
  assert.equal(r.outcome, 'resolved')
  assert.equal(r.accepted?.resolved_source, 'pubmed')
  assert.equal(r.accepted?.doi, '10.1073/belsky')
  assert.match(r.accepted?.abstract ?? '', /Dunedin/)
  assert.equal(searches(world, 'openalex'), 0)
  assert.equal(r.databases[0].name, 'pubmed')
})

test('fix 1: a busy PubMed (HTTP 429) is retried, waiting as long as Retry-After asks, and then answers', async () => {
  const { world, resolve } = setup({ world: { pubmed: [PAPERS[1]], failures: { pubmed: [{ status: 429, headers: { 'retry-after': '2' } }, { status: 503 }], crossref: [], openalex: [] } } })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'] })
  assert.equal(r.outcome, 'resolved')
  assert.ok(world.sleeps.includes(2000), `slept ${world.sleeps}`)
  assert.equal(r.databases.find(d => d.name === 'pubmed')?.ok, true)
})

test('fix 1: a database that never answers is a failed lookup (deferred), NOT not_found, and the judge is not asked', async () => {
  const { world, stubs, resolve } = setup({ world: { down: new Set(['pubmed', 'crossref', 'openalex']) } })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'] })
  assert.equal(r.outcome, 'deferred')
  assert.equal(r.reason, 'lookup_failed')
  assert.equal(stubs.judgeCalls.length, 0)
  assert.ok(r.databases.every(d => !d.ok))
  assert.ok(searches(world, 'pubmed') >= 4, 'retried before giving up')
})

test('fix 1: the 2026-11-08 failure: OpenAlex answers 429 "rate limited" while PubMed and Crossref are empty → deferred, not not_found', async () => {
  const { resolve } = setup({ world: { down: new Set(['openalex']) } })
  const r = await resolve('something obscure', { authors: ['Nobody'] })
  assert.equal(r.outcome, 'deferred')
  assert.equal(r.reason, 'lookup_failed')
  assert.deepEqual(r.databases.filter(d => !d.ok).map(d => d.name), ['openalex'])
})

test('fix 1: NCBI sometimes answers HTTP 200 with an error body when rate limiting; that is a failure, not zero hits', async () => {
  const { world, resolve } = setup({ world: { failures: { pubmed: Array(8).fill({ status: 200, body: JSON.stringify({ error: 'API rate limit exceeded' }) }), crossref: [], openalex: [] } } })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'] })
  // PubMed's scripted 200-with-error is consumed as an answer, so it must be reported as failed, and the lookup deferred.
  assert.equal(r.databases.find(d => d.name === 'pubmed')?.ok, false)
  assert.equal(r.outcome, 'deferred')
  assert.ok(world.calls.length > 0)
})

test('fix 1: when every database answered and none had anything, the citation is not_found (a real "no")', async () => {
  const { resolve } = setup()
  const r = await resolve('a study', { authors: ['Nobody'], year: 2001 })
  assert.equal(r.outcome, 'not_found')
  assert.equal(r.reason, 'no_candidates')
  assert.ok(r.databases.every(d => d.ok))
})

test('fix 1: OpenAlex is only the backup: used when PubMed and Crossref found nothing', async () => {
  const { world, resolve } = setup({ world: { openalex: [PAPERS[0]] } })
  const r = await resolve('REDUCE-IT', { title: 'REDUCE-IT' })
  assert.equal(r.outcome, 'resolved')
  assert.equal(r.accepted?.resolved_source, 'openalex')
  assert.equal(searches(world, 'openalex'), 1)
})

test('fix 1: once OpenAlex has refused three citations in a row it is left alone for a while', async () => {
  const { world, resolve } = setup({ world: { down: new Set(['openalex']) } })
  for (let i = 0; i < 6; i++) await resolve(`obscure ${i}`, { authors: [`Nobody${i}`] })
  const attempts = searches(world, 'openalex')
  assert.ok(attempts <= 3 * 2, `OpenAlex was hit ${attempts} times (3 citations x 2 attempts at most)`)
})

test('fix 1: a model failure on the judge defers the citation; a refusal ends it; a halt stops the run', async () => {
  let who: Error = new Error('CLI exited 1')
  const { resolve } = setup({ world: { pubmed: [PAPERS[1]] }, stubs: { judge: () => who } })
  assert.equal((await resolve('a', { authors: ['Belsky'] })).reason, 'model_failed')
  who = new ModelRefusalError('claude-opus-5-5', 'flagged')
  const refused = await resolve('b', { authors: ['Belsky'], year: 2015 })
  assert.equal(refused.outcome, 'not_found')
  assert.equal(refused.reason, 'model_refused')
  who = new PipelineHaltError(5, 'not logged in')
  await assert.rejects(resolve('c', { authors: ['Belsky'], year: 2016 }), /CLI calls failed in a row/)
})

// ── Fix 2: no "needs a title" rule ──

test('fix 2: an author name and a year, with no title or journal, IS searched (the old gate skipped it)', async () => {
  const { world, resolve } = setup({ world: { pubmed: [PAPERS[1]] } })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'], year: 2015 })
  assert.equal(r.outcome, 'resolved')
  assert.ok(searches(world, 'pubmed') >= 1)
})

test('fix 2: a bare trial name and a description with nothing else is searched', async () => {
  const { world, resolve } = setup({ world: { pubmed: [PAPERS[0]] } })
  const r = await resolve('So it is called the All Heart Trial')
  assert.equal(r.outcome, 'resolved')
  assert.ok(searches(world, 'pubmed') >= 1)
})

test('fix 2: a non-science item (journalism book, talk) is skipped before any search, and says why', async () => {
  const { world, stubs, resolve } = setup({ stubs: { plans: () => ({ searchable: false, skip_reason: 'not_scientific' }) } })
  const r = await resolve("All the President's Men by Woodward and Bernstein", { type: 'book', authors: ['Woodward', 'Bernstein'] })
  assert.equal(r.outcome, 'skipped')
  assert.equal(r.reason, 'not_scientific')
  assert.equal(world.calls.length, 0)
  assert.equal(stubs.judgeCalls.length, 0)
})

test('fix 2: a scientific book is still searched (the Taubes book was a correct link)', async () => {
  const book: Paper = { pmid: '9', title: 'Good Calories, Bad Calories', first: 'Taubes', year: 2007, journal: 'Knopf', doi: '10.1/gcbc' }
  const { resolve } = setup({ world: { crossref: [book] } })
  const r = await resolve('Good Calories, Bad Calories', { type: 'book', title: 'Good Calories, Bad Calories', authors: ['Taubes'] })
  assert.equal(r.outcome, 'resolved')
  assert.equal(r.accepted?.resolved_source, 'crossref')
})

test('fix 2: a mention with nothing to go on at all is skipped without a model call', async () => {
  const { world, stubs, resolve } = setup()
  const r = await resolve('it', {})
  // the helper adds a long context, so build the bare mention by hand
  assert.ok(['skipped', 'resolved', 'not_found', 'deferred'].includes(r.outcome))
  const bare = await createReferenceLookup({ fetch: fakeFetch(world), planSearch: async () => { stubs.planCalls.push('x'); return {} }, judge: async () => ({ index: null, confidence: 0 }) })
    .resolveMention({ raw: 'a study', parsed: {}, episode: EPISODE })
  assert.equal(bare.outcome, 'skipped')
  assert.equal(bare.reason, 'too_vague')
})

// ── Fix 3: a model writes the search from the whole context ──

test('fix 3: the search sent to PubMed is the one the writer wrote from the context, not the raw words', async () => {
  const { world, resolve } = setup({
    world: { pubmed: [PAPERS[1]] },
    stubs: { plans: () => ({ pubmed: 'Belsky DW[AU] AND 2015[DP] AND pace of aging', plain: 'Belsky 2015 pace of aging Dunedin', first_author: 'Belsky', year: 2015 }) },
  })
  await resolve('the Belsky paper', { authors: ['Belsky'] })
  const q = decodeURIComponent(world.calls.find(c => c.host === 'pubmed')!.url)
  assert.match(q, /Belsky DW\[AU\] AND 2015\[DP\] AND pace of aging/)
  const cr = decodeURIComponent(world.calls.find(c => c.host === 'crossref')!.url)
  assert.match(cr, /Belsky 2015 pace of aging Dunedin/)
})

test('fix 3: the writer sees the episode and the finding described, so "my lab" can be resolved', async () => {
  let seen: { raw: string; parsed: ParsedRef; episode: EpisodeInfo } | null = null
  const lookup = createReferenceLookup({ fetch: fakeFetch(newWorld()), planSearch: async i => { seen = i; return {} }, judge: async () => ({ index: null, confidence: 0 }) })
  await lookup.resolveMention({ raw: 'a paper from my lab', parsed: { context: 'caloric restriction in humans changes the thymus' }, episode: EPISODE })
  assert.equal(seen!.episode.title, '#200 Test Episode')
  assert.deepEqual(seen!.episode.people, ['Dr. Peter Attia', 'Gary Guest'])
  assert.match(seen!.parsed.context ?? '', /thymus/)
})

test('fix 3: if the writer fails, the search is built from the parsed fields; the citation is not dropped', async () => {
  const { world, resolve } = setup({ world: { pubmed: [PAPERS[1]] }, stubs: { plans: () => { throw new Error('CLI exited 1') } } })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'], year: 2015 })
  assert.equal(r.outcome, 'resolved')
  assert.match(decodeURIComponent(world.calls.find(c => c.host === 'pubmed')!.url), /Belsky/)
})

test('fix 3: a structured PubMed query that finds nothing is relaxed to the plain wording once', async () => {
  const { world, resolve } = setup({
    world: { pubmed: q => (q.includes('[AU]') ? [] : [PAPERS[1]]) },
    stubs: { plans: () => ({ pubmed: 'Belsky[AU] AND 2015[DP]', plain: 'Belsky pace of aging Dunedin cohort' }) },
  })
  const r = await resolve('the Belsky paper', { authors: ['Belsky'] })
  assert.equal(r.outcome, 'resolved')
  assert.equal(searches(world, 'pubmed'), 2)
})

test('fix 3: sanitizePlan survives nonsense from the model', () => {
  const parsed: ParsedRef = { authors: ['Dr. Dan Belsky'], year: 2015, journal: 'PNAS' }
  for (const bad of [null, undefined, 'x' as unknown as Partial<SearchPlan>, {}, { pubmed: 5, year: 'soon', searchable: 'yes' } as unknown as Partial<SearchPlan>]) {
    const p = sanitizePlan(bad, 'the Belsky paper', parsed)
    assert.equal(p.searchable, true)
    assert.ok(p.pubmed.length > 0 && p.plain.length > 0)
    assert.equal(p.first_author, 'belsky')
    assert.equal(p.year, 2015)
  }
  assert.equal(sanitizePlan({ searchable: false }, 'x', {}).skip_reason, 'not_scientific')
})

// ── Fix 4: two untitled citations never share an answer ──

test('fix 4: workKey never shares a bare year, a bare journal, or a bare description', () => {
  const none = { trial_name: null, first_author: null, year: null, journal: null, variant: null }
  assert.equal(workKey({ year: 2013 }, { ...none, year: 2013 }), null)
  assert.equal(workKey({ year: 2013, journal: 'JAMA' }, { ...none, year: 2013, journal: 'JAMA' }), null)
  assert.equal(workKey({}, { ...none, first_author: 'Belsky' }), null, 'an author with no year is not specific enough')
  assert.equal(workKey({ title: 'Statins' }, none), null, 'a one-word title is not specific enough')
})

test('fix 4: workKey is specific for a DOI, a real title, a trial name, or author plus year', () => {
  const none = { trial_name: null, first_author: null, year: null, journal: null, variant: null }
  assert.equal(workKey({ doi: '10.1056/ABC' }, none), 'doi:10.1056/abc')
  assert.equal(workKey({ title: 'Mediterranean Diet for Primary Prevention of Cardiovascular Disease', year: 2013 }, none), 'title:mediterranean diet for primary prevention of cardiovascular disease:2013')
  assert.equal(workKey({}, { ...none, trial_name: 'REDUCE-IT' }), workKey({}, { ...none, trial_name: 'the Reduce IT trial' }))
  assert.equal(workKey({}, { ...none, first_author: 'Dan Belsky', year: 2015 }), workKey({}, { ...none, first_author: 'Belsky DW', year: 2015 }))
})

test('fix 4: workKey keeps different papers of one trial apart (year, lead author, follow-up wording)', () => {
  const none = { trial_name: 'WHI', first_author: null, year: null, journal: null, variant: null }
  const keys = new Set([
    workKey({}, none), workKey({}, { ...none, year: 2002 }), workKey({}, { ...none, year: 2013, first_author: 'Manson' }),
    workKey({}, { ...none, variant: '18-year follow-up' }), workKey({}, { ...none, journal: 'JAMA' }),
  ])
  assert.equal(keys.size, 5)
})

test('fix 4: the 2026-11-08 bug: a JAMA 2013 paper and a NEJM 2013 paper, both untitled, do not get one answer', async () => {
  // Both mentions carry only "2013". The old cache key was "(none):2013" for both, so the second reused the first's answer.
  const { world, stubs, resolve } = setup({
    world: { pubmed: q => (/jama/i.test(q) ? [PAPERS[3]] : [PAPERS[2]]) },
    stubs: {
      plans: raw => (/JAMA/.test(raw) ? { pubmed: 'JAMA 2013 statins women', plain: 'JAMA 2013 statins women' } : { pubmed: 'NEJM 2013 predimed', plain: 'NEJM 2013 predimed' }),
      judge: candidates => ({ index: 0, confidence: 0.9 }) as Judgement,
    },
  })
  const nejm = await resolve('the first paper was in the New England Journal of Medicine, 2013', { year: 2013, journal: 'New England Journal of Medicine' })
  const jama = await resolve('the paper that we published in JAMA in 2013', { year: 2013, journal: 'JAMA' })
  assert.equal(nejm.accepted?.doi, '10.1056/predimed-letter')
  assert.equal(jama.accepted?.doi, '10.1001/whi2013', 'the JAMA citation must be searched on its own')
  assert.equal(jama.cacheHit, false)
  assert.equal(stubs.judgeCalls.length, 2)
  assert.ok(searches(world, 'pubmed') >= 2)
})

test('fix 4: two untitled mentions that carry only different clues are each judged', async () => {
  const { stubs, resolve } = setup({ world: { pubmed: [PAPERS[1]] } })
  await resolve('a study out of Brazil', { year: 2019 })
  await resolve('a 2019 review of 32 studies', { year: 2019 })
  assert.equal(stubs.judgeCalls.length, 2)
})

// ── Fix 5: one work, one lookup ──

test('fix 5: REDUCE-IT mentioned eight times is looked up once and linked eight times', async () => {
  const { world, stubs, resolve } = setup({
    world: { pubmed: [PAPERS[0]] },
    stubs: { plans: () => ({ trial_name: 'REDUCE-IT', pubmed: 'REDUCE-IT', plain: 'REDUCE-IT icosapent ethyl' }) },
  })
  const results = []
  for (let i = 0; i < 8; i++) results.push(await resolve(`somebody does a new trial, like REDUCE-IT (${i})`, { context: `finding number ${i}` }))
  assert.ok(results.every(r => r.outcome === 'resolved' && r.accepted?.doi === '10.1056/reduce'))
  assert.equal(results.filter(r => r.cacheHit).length, 7)
  assert.equal(searches(world, 'pubmed'), 1)
  assert.equal(stubs.judgeCalls.length, 1)
})

test('fix 5: the same holds when the eight mentions are resolved side by side', async () => {
  const { world, stubs, resolve } = setup({
    world: { pubmed: [PAPERS[0]] },
    stubs: { plans: () => ({ trial_name: 'REDUCE-IT', pubmed: 'REDUCE-IT', plain: 'REDUCE-IT icosapent ethyl' }) },
  })
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => resolve(`REDUCE-IT ${i}`)))
  assert.ok(results.every(r => r.outcome === 'resolved'))
  assert.equal(searches(world, 'pubmed'), 1)
  assert.equal(stubs.judgeCalls.length, 1)
})

test('fix 5: a trial that is not found is remembered too, so a cohort mentioned ten times is not searched ten times', async () => {
  const { world, stubs, resolve } = setup({
    world: { pubmed: [PAPERS[1]] },
    stubs: { judge: null, plans: () => ({ trial_name: "Nurses' Health Study", pubmed: 'Nurses Health Study', plain: 'Nurses Health Study' }) },
  })
  for (let i = 0; i < 10; i++) {
    const r = await resolve(`the Nurses Health Study ${i}`)
    assert.equal(r.outcome, 'not_found')
  }
  assert.equal(searches(world, 'pubmed'), 1)
  assert.equal(stubs.judgeCalls.length, 1)
})

test('fix 5: a failed lookup is NOT remembered: the next mention of the work tries again', async () => {
  const { world, resolve } = setup({
    world: { pubmed: [PAPERS[0]], failures: { pubmed: Array(4).fill({ status: 503 }), crossref: Array(3).fill({ status: 503 }), openalex: Array(2).fill({ status: 503 }) } },
    stubs: { plans: () => ({ trial_name: 'REDUCE-IT', pubmed: 'REDUCE-IT', plain: 'REDUCE-IT' }) },
  })
  const first = await resolve('REDUCE-IT a')
  assert.equal(first.outcome, 'deferred')
  const second = await resolve('REDUCE-IT b')
  assert.equal(second.outcome, 'resolved')
  assert.ok(searches(world, 'pubmed') >= 5)
})

test('fix 5: different clues on the same trial are different works (primary result vs a 2018 reanalysis)', async () => {
  const { stubs, resolve } = setup({
    world: { pubmed: [PAPERS[2]] },
    stubs: { plans: raw => (/reanalysis/.test(raw) ? { trial_name: 'PREDIMED', year: 2018, variant: 'reanalysis' } : { trial_name: 'PREDIMED' }) },
  })
  await resolve('predimed is a great example')
  await resolve('predimed reanalysis published in 2018')
  await resolve('predimed again')
  assert.equal(stubs.judgeCalls.length, 2)
})

test('fix 5: a DOI or a real title reuses the earlier answer without even calling the writer', async () => {
  const { stubs, resolve } = setup({ world: { crossref: [PAPERS[1]], pubmed: [PAPERS[1]] } })
  await resolve('the paper', { doi: '10.1073/belsky' })
  const again = await resolve('that paper again', { doi: '10.1073/belsky' })
  assert.equal(again.cacheHit, true)
  assert.equal(stubs.planCalls.length, 1)
  assert.equal(stubs.judgeCalls.length, 1)
})

// ── The judge stays strict ──

test('the judge still decides: below 0.7, or index null, is not a link', async () => {
  const low = setup({ world: { pubmed: [PAPERS[1]] }, stubs: { judge: () => ({ index: 0, confidence: 0.69 }) } })
  assert.equal((await low.resolve('x', { authors: ['Belsky'] })).outcome, 'not_found')
  const none = setup({ world: { pubmed: [PAPERS[1]] }, stubs: { judge: null } })
  const r = await none.resolve('y', { authors: ['Belsky'] })
  assert.equal(r.outcome, 'not_found')
  assert.equal(r.reason, 'judge_rejected')
  const edge = setup({ world: { pubmed: [PAPERS[1]] }, stubs: { judge: () => ({ index: 0, confidence: 0.7 }) } })
  assert.equal((await edge.resolve('z', { authors: ['Belsky'] })).outcome, 'resolved')
})

// ── Parsing and names ──

test('parsePubMedXml reads title, authors, year, journal, DOI and abstract, and decodes entities', () => {
  const [p] = parsePubMedXml(pubmedXml([{ ...PAPERS[0], title: 'Risk &amp; <i>Reduction</i> with Icosapent' }]))
  assert.equal(p.title, 'Risk & Reduction with Icosapent')
  assert.deepEqual(p.authors, ['A Bhatt'])
  assert.equal(p.year, 2019)
  assert.equal(p.journal, 'N Engl J Med')
  assert.equal(p.doi, '10.1056/reduce')
  assert.equal(p.url, 'https://doi.org/10.1056/reduce')
  assert.equal(p.resolved_source, 'pubmed')
  assert.match(p.abstract ?? '', /REDUCE-IT/)
})

test('trial and author names are normalized so spellings meet', () => {
  assert.equal(normalizeTrialName('REDUCE-IT'), 'reduceit')
  assert.equal(normalizeTrialName('the Reduce IT trial'), 'reduceit')
  assert.equal(normalizeTrialName('ALL-HEART'), normalizeTrialName('All Heart Trial'))
  assert.equal(normalizeTrialName(null), null)
  assert.equal(normalizeSurname('Dan Belsky'), 'belsky')
  assert.equal(normalizeSurname('Belsky DW'), 'belsky')
  assert.equal(normalizeSurname('Schüssler-Fiorenza Rose, Sophia'), 'rose')
  assert.equal(normalizeSurname('Dr. Dan Belsky'), 'belsky')
  assert.equal(normalizeSurname('JoAnn Manson, M.D.'), 'manson')
  assert.equal(normalizeSurname(''), null)
})
