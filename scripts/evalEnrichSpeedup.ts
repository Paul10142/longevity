/**
 * Does the enrich-merge rewrite keep every detail when the CLI's thinking pass is skipped?
 *
 *   npx tsx --env-file=.env.local scripts/evalEnrichSpeedup.ts [--n 60] [--conc 3] [--numeric-only] [--reps 1] [--out <json>]
 *
 * `--numeric-only` keeps the gold pairs whose members contain a digit (37 of 92) — the only ones the
 * number guard can act on — and `--reps` runs each pair that many times, because a rewrite is not
 * deterministic and a dropped number is a rare event.
 *
 * Read-only (nothing is written anywhere but the console). Takes Paul's labelled gold pairs
 * (eval/dedup-goldset.json × the pairs file: the new insight and the claim it merged into),
 * runs the production rewrite (synthesizeEnrichedCanonical) twice per pair — as it ships, and with
 * ENRICH_NO_THINKING — and compares:
 *   - seconds per call;
 *   - the rewrite's own outcome (enriched / no change / rejected by the guard — a number invented
 *     that no member carried, or a number a member carried that the rewrite dropped);
 *   - numeric details present in a member but missing from the rewrite, before the guard
 *     (every digit, no exemptions) and after it (what reaches the canonical);
 *   - each rejection, with the numbers and both members, so false alarms can be read;
 *   - how different the two texts are, with the most different pairs printed in full.
 */
export {}

import { readFileSync, writeFileSync } from 'node:fs'

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

const args = process.argv.slice(2)
const num = (f: string, d: number) => { const i = args.indexOf(f); return i > -1 ? Number(args[i + 1]) : d }

type GoldPair = { id: string; new_statement: string; candidate_statement: string; candidate_context: string | null }

async function main() {
  const { synthesizeEnrichedCanonical, numericSpecifics } = await import('../lib/enrichMerge')
  const pairsFile = '/Users/paulclancy/_lifestyleacademy/eval/dedup-eval-pairs.json'
  const gold = new Set((JSON.parse(readFileSync('eval/dedup-goldset.json', 'utf8')) as { id: string }[]).map(g => g.id))
  const numericOnly = args.includes('--numeric-only')
  const reps = num('--reps', 1)
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'eval/judge-speedup-runs/enrich-eval-guard.json'
  const all = (JSON.parse(readFileSync(pairsFile, 'utf8')) as GoldPair[])
    .filter(p => gold.has(p.id))
    .filter(p => !numericOnly || /\d/.test(p.candidate_statement + p.new_statement))
  const n = Math.min(num('--n', 60), all.length)
  const step = all.length / n
  const base = Array.from({ length: n }, (_, i) => all[Math.floor(i * step)])
  const pairs = Array.from({ length: reps }, () => base).flat()
  const conc = num('--conc', 3)

  type Out = { ms: number; canonical: string; proposed: string; reason: string; changed: boolean; rejected: boolean; invented: string[]; missing: string[] }
  const results: { p: GoldPair; a: Out; b: Out }[] = []
  let next = 0
  const one = async (p: GoldPair, noThinking: boolean): Promise<Out> => {
    const t = Date.now()
    const r = await synthesizeEnrichedCanonical(p.candidate_statement, [p.candidate_statement, p.new_statement], { noThinking })
    return { ms: Date.now() - t, canonical: r.canonical, proposed: r.proposed ?? '', reason: r.reason, changed: r.changed, rejected: r.rejected, invented: r.invented, missing: r.missing }
  }
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < pairs.length) {
      const p = pairs[next++]
      // Alternate which variant goes first so neither systematically meets a warm or cold queue.
      const first = next % 2 === 0
      const x = await one(p, first)
      const y = await one(p, !first)
      results.push({ p, a: first ? y : x, b: first ? x : y })
    }
  }))

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
  const failed = (o: Out) => o.reason.startsWith('synthesis failed')
  const ok = results.filter(r => !failed(r.a) && !failed(r.b))
  // Every digit a member carries that the text lacks — no year/citation exemptions, no spelled-out or
  // range equivalence. The yardstick the first eval used ("dropped before"); the guard's own, kinder
  // rule is `missing` on each result.
  const dropped = (members: string[], out: string) => {
    const have = new Set(numericSpecifics(out))
    return [...new Set(members.flatMap(numericSpecifics))].filter(x => !have.has(x))
  }
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9.]+/g) ?? [])
  const jaccard = (a: string, b: string) => { const A = words(a), B = words(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / Math.max(1, A.size + B.size - i) }

  console.log(`${results.length} pairs (${results.length - ok.length} with a failed call, excluded)`)
  console.log(`seconds per call: as shipped ${(mean(ok.map(r => r.a.ms)) / 1000).toFixed(1)}  →  no thinking ${(mean(ok.map(r => r.b.ms)) / 1000).toFixed(1)}`)
  const tally = (pick: (r: (typeof ok)[number]) => Out) => ({
    enriched: ok.filter(r => pick(r).changed).length,
    same: ok.filter(r => !pick(r).changed && !pick(r).rejected).length,
    rejected: ok.filter(r => pick(r).rejected).length,
  })
  const ta = tally(r => r.a), tb = tally(r => r.b)
  console.log(`outcome (enriched / no change / rejected by guard): shipped ${ta.enriched}/${ta.same}/${ta.rejected}   no thinking ${tb.enriched}/${tb.same}/${tb.rejected}`)
  const mem = (r: (typeof ok)[number]) => [r.p.candidate_statement, r.p.new_statement]
  const rewrote = (o: Out) => o.proposed !== ''
  const row = (name: string, pick: (r: (typeof ok)[number]) => Out) => {
    const o = ok.filter(r => rewrote(pick(r)))
    const dropBefore = o.filter(r => dropped(mem(r), pick(r).proposed).length).length
    const dropAfter = o.filter(r => !pick(r).rejected && dropped(mem(r), pick(r).canonical).length).length
    const byMissing = o.filter(r => pick(r).missing.length).length
    const byInvented = o.filter(r => pick(r).invented.length).length
    const both = o.filter(r => pick(r).missing.length && pick(r).invented.length).length
    console.log(`${name}: ${o.length} rewrites; rejected ${o.filter(r => pick(r).rejected).length} (dropped a number: ${byMissing}, invented one: ${byInvented}, both: ${both});` +
      ` rewrites dropping a digit before the guard ${dropBefore}, in the canonical after it ${dropAfter}`)
  }
  row('shipped    ', r => r.a)
  row('no thinking', r => r.b)
  writeFileSync(outFile, JSON.stringify(results.map(r => ({ id: r.p.id, member1: r.p.candidate_statement, member2: r.p.new_statement, shipped: r.a, noThinking: r.b })), null, 1))
  console.log('\nREJECTIONS BY THE MISSING-NUMBER CHECK:')
  for (const [name, pick] of [['shipped', (r: (typeof ok)[number]) => r.a], ['no thinking', (r: (typeof ok)[number]) => r.b]] as const) {
    for (const r of ok.filter(x => pick(x).missing.length)) {
      console.log(`\n[${name}] ${r.p.id}  missing ${JSON.stringify(pick(r).missing)}  invented ${JSON.stringify(pick(r).invented)}`)
      console.log(`  MEMBER 1: ${r.p.candidate_statement}`)
      console.log(`  MEMBER 2: ${r.p.new_statement}`)
      console.log(`  REWRITE:  ${pick(r).proposed}`)
    }
  }
  console.log('')
  console.log(`identical text: ${ok.filter(r => r.a.canonical === r.b.canonical).length}/${ok.length};  mean word overlap ${mean(ok.map(r => jaccard(r.a.canonical, r.b.canonical))).toFixed(2)}`)
  console.log(`mean length (chars): shipped ${mean(ok.map(r => r.a.canonical.length)).toFixed(0)}  no thinking ${mean(ok.map(r => r.b.canonical.length)).toFixed(0)}`)

  // Detail coverage: the share of the members' distinctive words (5+ letters, minus filler) that the
  // rewrite still contains. A dropped example or caveat shows up as lost words; a re-phrasing does not
  // move it much. Compared pair by pair, so the question is "did removing thinking lose more?".
  const STOP = new Set(['which', 'their', 'there', 'these', 'those', 'about', 'because', 'while', 'where', 'other', 'being', 'would', 'could', 'should', 'often', 'more', 'most', 'than', 'that', 'with', 'from', 'have', 'into', 'over', 'such', 'also', 'both', 'between', 'across'])
  const content = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).map(w => w.replace(/(ing|ed|es|s)$/, '')).filter(w => !STOP.has(w)))
  const coverage = (members: string[], out: string) => {
    const want = new Set(members.flatMap(m => [...content(m)]))
    const have = content(out)
    let k = 0; for (const w of want) if (have.has(w)) k++
    return k / Math.max(1, want.size)
  }
  const cov = ok.map(r => ({ r, a: coverage([r.p.candidate_statement, r.p.new_statement], r.a.canonical), b: coverage([r.p.candidate_statement, r.p.new_statement], r.b.canonical) }))
  console.log(`detail coverage (share of the members' distinctive words kept): shipped ${mean(cov.map(c => c.a)).toFixed(3)}  no thinking ${mean(cov.map(c => c.b)).toFixed(3)}`)
  console.log(`  pairs where no-thinking keeps >=10 points less: ${cov.filter(c => c.a - c.b >= 0.1).length}/${cov.length};  keeps >=10 points more: ${cov.filter(c => c.b - c.a >= 0.1).length}/${cov.length}`)

  const worst = [...ok].sort((x, y) => jaccard(x.a.canonical, x.b.canonical) - jaccard(y.a.canonical, y.b.canonical)).slice(0, 6)
  console.log('\nMOST DIFFERENT PAIRS:')
  for (const r of worst) {
    console.log(`\n${r.p.id}  overlap ${jaccard(r.a.canonical, r.b.canonical).toFixed(2)}`)
    console.log(`  MEMBER 1: ${r.p.candidate_statement}`)
    console.log(`  MEMBER 2: ${r.p.new_statement}`)
    console.log(`  shipped:      ${r.a.canonical}`)
    console.log(`  no thinking:  ${r.b.canonical}`)
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
