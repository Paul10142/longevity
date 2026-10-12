/**
 * Freeze the judge-speed-up accuracy sample (eval/judge-speedup-sample.json).
 *
 *   npx tsx --env-file=.env.local scripts/buildJudgeSample.ts [--corpus 80] [--twin 100] [--seed 7]
 *
 * READ-ONLY. Every pair is a real adjudication the pipeline makes or could make:
 * a NEW statement plus the candidate claims the gate would show the judge (>= 0.70
 * cosine, best first, at most 8), spanning every similarity band from 0.70 up.
 *
 * Sources, so the sample is not one population:
 *   gold    Paul's 92 labelled pairs (eval/dedup-goldset.json × the pairs file) — all
 *           SAME; one candidate each, as they were labelled.
 *   paul    merge_reviews Paul decided himself (decided_by = 'admin'): accepted =
 *           SAME, rejected = DIFFERENT. The only labelled NEGATIVES in the library.
 *   twin    the frozen twin benchmark (eval/twin-benchmark-20261011.json): the same
 *           episode extracted twice, so the right answer is mostly SAME. Production
 *           shape — a ranked list of up to 8.
 *   corpus  random raw insights run through match_claims exactly as consolidateSource
 *           does (own claim excluded): the library-wide mix, mostly different facts.
 *
 * The file is frozen: the baseline verdicts are recorded against it once, and every
 * speed-up is scored against those, so a changing corpus can never move the target.
 */
export {}

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const num = (f: string, d: number): number => {
  const i = args.indexOf(f)
  return i > -1 ? Number(args[i + 1]) : d
}

type Cand = { id: string; canonical_statement: string; context_note: string | null; similarity: number }
export type SamplePair = {
  id: string
  origin: 'gold' | 'paul' | 'twin' | 'corpus'
  band: string
  new_statement: string
  candidates: Cand[]
  /** Ground truth where a human supplied it; null where only the baseline judge speaks. */
  label: 'SAME' | 'DIFFERENT' | null
}

export const BANDS = ['>=0.86', '0.80-0.86', '0.75-0.80', '0.70-0.75'] as const
export function bandOf(sim: number): string {
  if (sim >= 0.86) return BANDS[0]
  if (sim >= 0.8) return BANDS[1]
  if (sim >= 0.75) return BANDS[2]
  return BANDS[3]
}

// Small deterministic PRNG so the sample can be rebuilt.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function evenly<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs
  const step = xs.length / n
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)])
}

async function main() {
  const random = rng(num('--seed', 7))
  const wantCorpus = num('--corpus', 80)
  const wantTwin = num('--twin', 100)
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const out: SamplePair[] = []

  // ── gold: Paul's 92 rulings ──────────────────────────────────────────────
  const goldFile = existsSync('eval/dedup-eval-pairs.json') ? 'eval/dedup-eval-pairs.json' : '/Users/paulclancy/_lifestyleacademy/eval/dedup-eval-pairs.json'
  const gold = JSON.parse(readFileSync('eval/dedup-goldset.json', 'utf8')) as { id: string; label: 'SAME' | 'DIFFERENT' }[]
  const pairs = JSON.parse(readFileSync(goldFile, 'utf8')) as {
    id: string; new_statement: string; candidate_claim_id: string; candidate_statement: string
    candidate_context: string | null; similarity: number | null
  }[]
  const labelById = new Map(gold.map(g => [g.id, g.label]))
  for (const p of pairs) {
    const label = labelById.get(p.id)
    if (!label) continue
    // These are the July merges: the file did not store their similarity, but the gate of the
    // day was 0.80, so that is the floor; the band says so rather than guessing a value.
    out.push({
      id: p.id, origin: 'gold', band: 'gold(>=0.80)', new_statement: p.new_statement, label,
      candidates: [{ id: p.candidate_claim_id, canonical_statement: p.candidate_statement, context_note: p.candidate_context, similarity: p.similarity ?? 0.8 }],
    })
  }

  console.log(`gold pairs: ${out.length}`)
  // ── paul: reviews he decided himself ─────────────────────────────────────
  const { data: reviews, error: revErr } = await db
    .from('merge_reviews')
    .select('id, status, similarity, claim_id, candidate_claim_id')
    .eq('decided_by', 'admin')
    .in('status', ['accepted', 'rejected'])
  if (revErr) throw new Error(revErr.message)
  const claimIds = [...new Set((reviews ?? []).flatMap((r: { claim_id: unknown; candidate_claim_id: unknown }) => [r.claim_id as string, r.candidate_claim_id as string]))]
  const claimById = new Map<string, { canonical_statement: string; context_note: string | null }>()
  for (let i = 0; i < claimIds.length; i += 100) {
    const { data, error } = await db.from('claims').select('id, canonical_statement, context_note').in('id', claimIds.slice(i, i + 100))
    if (error) throw new Error(error.message)
    for (const c of data ?? []) claimById.set(c.id as string, c as never)
  }
  for (const r of reviews ?? []) {
    const a = claimById.get(r.claim_id as string)
    const b = claimById.get(r.candidate_claim_id as string)
    const sim = Number(r.similarity)
    if (!a || !b || !(sim >= 0.7)) continue
    out.push({
      id: `paul:${r.id}`, origin: 'paul', band: bandOf(sim), new_statement: a.canonical_statement,
      label: r.status === 'accepted' ? 'SAME' : 'DIFFERENT',
      candidates: [{ id: r.candidate_claim_id as string, canonical_statement: b.canonical_statement, context_note: b.context_note, similarity: sim }],
    })
  }

  console.log(`after paul: ${out.length}`)
  // ── twin: frozen benchmark, production shape ─────────────────────────────
  const twin = JSON.parse(readFileSync('eval/twin-benchmark-20261011.json', 'utf8')) as {
    episodes: {
      captionClaims: { id: string; canonical_statement: string; context_note: string | null }[]
      deepgramInsights: { id: string; statement: string; candidates: { id: string; sim: number }[] }[]
    }[]
  }
  const twinPool: Record<string, SamplePair[]> = Object.fromEntries(BANDS.map(b => [b, []]))
  for (const e of twin.episodes) {
    const claims = new Map(e.captionClaims.map(c => [c.id, c]))
    for (const ins of e.deepgramInsights) {
      const cands = ins.candidates
        .filter(c => c.sim >= 0.7 && claims.has(c.id))
        .slice(0, 8)
        .map(c => ({ id: c.id, canonical_statement: claims.get(c.id)!.canonical_statement, context_note: claims.get(c.id)!.context_note, similarity: c.sim }))
      if (!cands.length) continue
      const band = bandOf(cands[0].similarity)
      twinPool[band].push({ id: `twin:${ins.id}`, origin: 'twin', band, new_statement: ins.statement, candidates: cands, label: null })
    }
  }
  for (const b of BANDS) out.push(...evenly(twinPool[b], Math.round(wantTwin / BANDS.length)))

  console.log(`after twin: ${out.length}`)
  // ── corpus: random insights through the real search ──────────────────────
  const { count } = await db.from('raw_insights').select('*', { count: 'exact', head: true })
  const total = count ?? 0
  const quota = Math.round(wantCorpus / BANDS.length)
  const got: Record<string, number> = Object.fromEntries(BANDS.map(b => [b, 0]))
  const seen = new Set<string>()
  // A batch of consecutive rows from a random offset: one query per ~25 insights
  // (a single-row ordered range over 33k vectors-bearing rows is what made the first
  // attempt crawl). Consecutive rows share a source, which is fine — only the band
  // is stratified — and the offsets are spread across the whole table.
  // Time-boxed: the top band (>= 0.86) is ~4% of the library, so it may not fill; the twin set
  // carries that band, and the report below says what was reached.
  const corpusDeadline = Date.now() + num('--corpus-secs', 420) * 1000
  for (let tries = 0; tries < 400 && Date.now() < corpusDeadline && BANDS.some(b => got[b] < quota); tries++) {
    const offset = Math.floor(random() * Math.max(1, total - 25))
    const { data: rows, error: rowErr } = await db.from('raw_insights').select('id, statement, embedding').range(offset, offset + 24)
    if (rowErr) { console.warn(`raw_insights page failed: ${rowErr.message}`); continue }
    for (const ins of (rows ?? []) as { id: string; statement: string; embedding: unknown }[]) {
      if (!BANDS.some(b => got[b] < quota)) break
      if (!ins.embedding || seen.has(ins.id) || random() > 0.5) continue
      seen.add(ins.id)
      const { data: hits, error } = await db.rpc('match_claims', { query_embedding: ins.embedding, match_threshold: 0.7, match_count: 9 })
      if (error) { console.warn(`match_claims: ${error.message}`); continue }
      const { data: own } = await db.from('claim_members').select('claim_id').eq('raw_insight_id', ins.id)
      const ownIds = new Set((own ?? []).map((o: { claim_id: unknown }) => o.claim_id as string))
      const cands = ((hits ?? []) as Cand[]).filter(h => !ownIds.has(h.id)).slice(0, 8)
      if (!cands.length) continue
      const band = bandOf(Number(cands[0].similarity))
      if (got[band] >= quota) continue
      got[band]++
      out.push({
        id: `corpus:${ins.id}`, origin: 'corpus', band, new_statement: ins.statement, label: null,
        candidates: cands.map(c => ({ id: c.id, canonical_statement: c.canonical_statement, context_note: c.context_note, similarity: Number(c.similarity) })),
      })
    }
    if (tries % 20 === 0) console.log(`corpus draw ${tries}: ${BANDS.map(b => `${b}:${got[b]}/${quota}`).join(' ')}`)
  }

  // Report and write.
  const byKey = new Map<string, number>()
  for (const p of out) byKey.set(`${p.origin} ${p.band}`, (byKey.get(`${p.origin} ${p.band}`) ?? 0) + 1)
  console.log(`pairs: ${out.length}`)
  for (const o of ['gold', 'paul', 'twin', 'corpus']) {
    console.log(`  ${o.padEnd(7)} ${(o === 'gold' ? [...BANDS, 'gold(>=0.80)'] : BANDS).map(b => `${b}:${byKey.get(`${o} ${b}`) ?? 0}`).join('  ')}`)
  }
  console.log(`  labelled SAME ${out.filter(p => p.label === 'SAME').length}, DIFFERENT ${out.filter(p => p.label === 'DIFFERENT').length}`)
  console.log(`  candidates per pair: mean ${(out.reduce((s, p) => s + p.candidates.length, 0) / out.length).toFixed(1)}`)
  writeFileSync(
    'eval/judge-speedup-sample.json',
    JSON.stringify({ built_at: new Date().toISOString(), note: 'Frozen accuracy sample for the judge speed-up (docs/judge-speedup.md). Read-only build; see scripts/buildJudgeSample.ts.', pairs: out }, null, 1) + '\n'
  )
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
