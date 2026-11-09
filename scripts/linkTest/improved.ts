/**
 * READ-ONLY prototype (writes nothing to the database): would cheap changes find more real studies?
 * Changes tried on mentions the current resolver gave up on:
 *   1. no "needs a title" gate; 2. an LLM writes the search query from the mention + the finding described + the guest;
 *   3. PubMed first (free, no key), CrossRef second; 4. the same strict judge, now seeing the guest and episode.
 *   tsx scripts/linkTest/improved.ts <dump.json> <cats.json> <out.json> [perCategory]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { claudeJson, CLAUDE_BULK_MODEL, CLAUDE_JUDGMENT_MODEL } from '../../lib/llm'

const UA = 'LifestyleAcademy/1.0 (mailto:team@admissionsacademy.org)'
let last = 0
async function throttle() { const w = 400 - (Date.now() - last); if (w > 0) await new Promise(r => setTimeout(r, w)); last = Date.now() }
type Cand = { title: string; authors: string[]; journal: string | null; year: number | null; doi: string | null; pmid?: string; abstract?: string; src: string }

async function pubmed(q: string): Promise<Cand[]> {
  try {
    await throttle()
    const s = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=8&sort=relevance&term=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA } })).json()
    const ids: string[] = s.esearchresult?.idlist ?? []
    if (!ids.length) return []
    await throttle()
    const x = await (await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(',')}`, { headers: { 'User-Agent': UA } })).text()
    return x.split('<PubmedArticle>').slice(1).map(b => {
      const g = (re: RegExp) => (b.match(re)?.[1] ?? '').replace(/<[^>]+>/g, '').trim()
      const abs = [...b.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map(m => m[1].replace(/<[^>]+>/g, '')).join(' ').slice(0, 600)
      return {
        title: g(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/), journal: g(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/) || null,
        year: Number(g(/<PubDate>\s*<Year>(\d{4})/)) || null, pmid: g(/<PMID[^>]*>(\d+)<\/PMID>/),
        doi: g(/<ArticleId IdType="doi">([^<]+)</) || null, abstract: abs,
        authors: [...b.matchAll(/<LastName>([^<]+)<\/LastName>/g)].slice(0, 3).map(m => m[1]), src: 'pubmed',
      }
    })
  } catch { return [] }
}
async function crossref(q: string): Promise<Cand[]> {
  try {
    await throttle()
    const j = await (await fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=4`, { headers: { 'User-Agent': UA } })).json()
    return (j.message?.items ?? []).filter((i: any) => i.title?.[0]).map((i: any) => ({
      title: i.title[0], authors: (i.author ?? []).slice(0, 3).map((a: any) => a.family).filter(Boolean), journal: i['container-title']?.[0] ?? null,
      year: i.issued?.['date-parts']?.[0]?.[0] ?? null, doi: i.DOI ?? null, src: 'crossref',
    }))
  } catch { return [] }
}

async function main() {
  const d = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const cats = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const per = Number(process.argv[5] ?? 12)
  const srcTitle: Record<string, string> = {}
  for (const s of d.sources) srcTitle[s.id.slice(0, 8)] = `${s.title} (guests/hosts: ${(s.authors ?? []).join(', ')})`
  const picked: any[] = []
  const count: Record<string, number> = {}
  for (const r of cats.rows) { count[r.cat] = (count[r.cat] ?? 0) + 1; if (count[r.cat] <= per) picked.push(r) }
  const out: any[] = []
  for (const r of picked) {
    const m = d.mentions[r.i]; const p = m.parsed ?? {}
    const ep = srcTitle[m.src]
    let q: any = null
    try {
      q = await claudeJson<{ pubmed: string; plain: string; note?: string }>(
        'You turn a spoken reference to a medical study into search queries. Return STRICT JSON {"pubmed": <PubMed query using author[AU], year[DP], title words, trial names and design terms (randomized/meta-analysis/cohort); keep it specific, not long>, "plain": <a short natural-language query: first author surname, year, topic, design, journal if known>}. Use the episode and guest to resolve who is meant. Never invent an author or year that is not given or strongly implied.',
        `Spoken: "${m.raw}"\nParsed fields: ${JSON.stringify(p)}\nEpisode: ${ep}`, 600, CLAUDE_BULK_MODEL)
    } catch { /* fall through */ }
    const queries = q ? [q.pubmed, q.plain] : [m.raw]
    const [a, b] = await Promise.all([pubmed(queries[0]), crossref(queries[1] ?? queries[0])])
    const seen = new Set<string>(); const cands: Cand[] = []
    for (const c of [...a, ...b]) { const k = c.doi?.toLowerCase() ?? c.title.toLowerCase(); if (!seen.has(k)) { seen.add(k); cands.push(c) } }
    const list = cands.slice(0, 10).map((c, i) => `[${i}] "${c.title}" — ${c.authors.join(', ') || 'n/a'}, ${c.journal ?? 'n/a'}, ${c.year ?? 'n/a'}${c.abstract ? `\n    abstract: ${c.abstract.slice(0, 450)}` : ''}`).join('\n')
    let j: any = { index: null, confidence: 0 }
    if (cands.length) {
      try {
        j = await claudeJson<{ index: number | null; confidence: number }>(
          'A speaker on a medical podcast referred to an external published work. Choose which candidate (if any) is the SAME specific work. Match on substance: the described finding, population, topic and era must fit the candidate\'s abstract and metadata, and the speaker\'s author/year/journal clues must not conflict. For a named trial or cohort, accept only the primary results publication of that trial unless the speaker describes a follow-up. If the speaker only named a topic, a cohort with many papers, or no candidate clearly fits, return index null. Return STRICT JSON {"index": <number or null>, "confidence": <0..1>}.',
          `Speaker said: "${m.raw}"\nFinding described: ${p.context ?? 'n/a'}\nEpisode: ${ep}\n\nCandidates:\n${list}`, 800, CLAUDE_JUDGMENT_MODEL)
      } catch { /* none */ }
    }
    const ok = typeof j.index === 'number' && j.index >= 0 && j.index < Math.min(cands.length, 10) && j.confidence >= 0.7
    out.push({ i: r.i, cat: r.cat, src: m.src, raw: m.raw, context: p.context, queries, nCands: cands.length, judge: j, accepted: ok ? cands[j.index] : null, top: cands.slice(0, 3).map(c => `${c.title} | ${c.authors.join(', ')} | ${c.journal} | ${c.year}`) })
    console.log(r.i, ok ? 'ACCEPT' : 'no', (m.raw ?? '').slice(0, 50), '=>', ok ? cands[j.index].title.slice(0, 70) : `(${cands.length} cands)`)
    writeFileSync(process.argv[4], JSON.stringify(out, null, 1))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
