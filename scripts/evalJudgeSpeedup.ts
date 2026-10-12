/**
 * Does a faster judge still make the same merge decisions?
 *
 *   # 1. record a run over the frozen sample (resumable; bills the subscription)
 *   npx tsx --env-file=.env.local scripts/evalJudgeSpeedup.ts run --name baseline
 *   npx tsx --env-file=.env.local scripts/evalJudgeSpeedup.ts run --name effort-low --effort low
 *   # 2. score a run against the baseline
 *   npx tsx --env-file=.env.local scripts/evalJudgeSpeedup.ts compare --base baseline --variant effort-low
 *   # 3. time the ordered pipeline at concurrency 1 vs N on the same pairs
 *   npx tsx --env-file=.env.local scripts/evalJudgeSpeedup.ts bench --conc 4 --limit 40
 *   # 4. which pairs could skip the judge? (offline, from a recorded run)
 *   npx tsx --env-file=.env.local scripts/evalJudgeSpeedup.ts skiprule --base baseline
 *
 * Read-only: nothing is written to the database. Runs are stored in
 * eval/judge-speedup-runs/<name>.json. The sample is eval/judge-speedup-sample.json
 * (scripts/buildJudgeSample.ts); the baseline is the production judge as it ships
 * — Opus 5.5, no effort cap, the full candidate list.
 *
 * What counts as a flip. The pipeline acts on two things: whether the pair MERGES
 * (SAME at confidence >= 0.80, pairAction) and, if so, into WHICH candidate. A
 * variant is scored on both, plus the raw SAME/DIFFERENT/UNSURE verdict. A "new
 * false merge" is a pair the baseline kept apart and the variant merges: the
 * damaging direction, since a merge folds one claim into another. `--noise` runs
 * compare the baseline with a second baseline run, which is the judge's own
 * run-to-run wobble — the floor any variant is judged against.
 */
export {}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (f: string): string | undefined => {
  const i = argv.indexOf(f)
  return i > -1 ? argv[i + 1] : undefined
}
const num = (f: string, d: number): number => (flag(f) != null ? Number(flag(f)) : d)

const DIR = 'eval/judge-speedup-runs'
const SAMPLE = flag('--sample') ?? 'eval/judge-speedup-sample.json'

type Cand = { id: string; canonical_statement: string; context_note: string | null; similarity: number }
type Pair = {
  id: string; origin: string; band: string; new_statement: string; candidates: Cand[]
  label: 'SAME' | 'DIFFERENT' | null
}
type Rec = {
  id: string
  verdict: 'SAME' | 'DIFFERENT' | 'UNSURE' | 'ERROR'
  confidence: number
  enrich: boolean
  chosen: string | null // candidate id the verdict points at (SAME only)
  chosenRank: number | null // 1-based
  reasoning: string
  ms: number
  error?: string
}
type Run = { name: string; effort: string | null; k: number; conc: number; recs: Record<string, Rec> }

const loadPairs = (): Pair[] => (JSON.parse(readFileSync(SAMPLE, 'utf8')) as { pairs: Pair[] }).pairs
const runPath = (n: string) => `${DIR}/${n}.json`
const loadRun = (n: string): Run => JSON.parse(readFileSync(runPath(n), 'utf8')) as Run

const AUTO_MERGE = 0.8
const merges = (r: Rec) => r.verdict === 'SAME' && r.confidence >= AUTO_MERGE

async function runCmd() {
  const name = flag('--name')
  if (!name) throw new Error('--name required')
  const effort = (flag('--effort') as 'low' | 'medium' | 'high' | undefined) ?? null
  const k = num('--k', 8)
  const conc = num('--conc', 3)
  const limit = num('--limit', 100000)
  const pairs = loadPairs().slice(0, limit)
  mkdirSync(DIR, { recursive: true })
  const run: Run = existsSync(runPath(name))
    ? loadRun(name)
    : { name, effort, k, conc, recs: {} }
  const { adjudicate } = await import('../lib/consolidation')

  const todo = pairs.filter(p => !run.recs[p.id] || run.recs[p.id].verdict === 'ERROR')
  console.log(`${name}: ${pairs.length} pairs, ${todo.length} to do; effort=${effort ?? 'default'} k=${k} concurrency=${conc}`)
  let next = 0
  let done = 0
  const t0 = Date.now()
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++]
      const cands = p.candidates.slice(0, k)
      const t = Date.now()
      try {
        const v = await adjudicate(p.new_statement, cands, effort ? { effort } : {})
        const idx = v.candidate_index && v.candidate_index >= 1 && v.candidate_index <= cands.length ? v.candidate_index : null
        run.recs[p.id] = {
          id: p.id, verdict: v.verdict, confidence: v.confidence, enrich: v.enrich,
          chosen: v.verdict === 'SAME' ? cands[(idx ?? 1) - 1].id : null,
          chosenRank: v.verdict === 'SAME' ? (idx ?? 1) : null,
          reasoning: v.reasoning, ms: Date.now() - t,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 160) : String(err)
        run.recs[p.id] = { id: p.id, verdict: 'ERROR', confidence: 0, enrich: false, chosen: null, chosenRank: null, reasoning: '', ms: Date.now() - t, error: msg }
      }
      done++
      if (done % 10 === 0 || done === todo.length) {
        writeFileSync(runPath(name), JSON.stringify(run))
        const errs = Object.values(run.recs).filter(r => r.verdict === 'ERROR').length
        console.log(`  ${done}/${todo.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s  errors so far ${errs}`)
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  writeFileSync(runPath(name), JSON.stringify(run))
  const recs = Object.values(run.recs)
  const ok = recs.filter(r => r.verdict !== 'ERROR')
  const ms = ok.map(r => r.ms).sort((a, b) => a - b)
  console.log(`done: ${ok.length} judged, ${recs.length - ok.length} errors; per call mean ${(ms.reduce((s, x) => s + x, 0) / Math.max(1, ms.length) / 1000).toFixed(1)}s, median ${((ms[Math.floor(ms.length / 2)] ?? 0) / 1000).toFixed(1)}s, p90 ${((ms[Math.floor(ms.length * 0.9)] ?? 0) / 1000).toFixed(1)}s`)
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–')
const secs = (rs: Rec[]) => {
  const ms = rs.map(r => r.ms).sort((a, b) => a - b)
  return { mean: ms.reduce((s, x) => s + x, 0) / Math.max(1, ms.length) / 1000, median: (ms[Math.floor(ms.length / 2)] ?? 0) / 1000, p90: (ms[Math.floor(ms.length * 0.9)] ?? 0) / 1000 }
}

function compareCmd() {
  const baseN = flag('--base') ?? 'baseline'
  const varN = flag('--variant')
  if (!varN) throw new Error('--variant required')
  const base = loadRun(baseN)
  const vari = loadRun(varN)
  const pairs = loadPairs()
  const byId = new Map(pairs.map(p => [p.id, p]))
  const ids = pairs.map(p => p.id).filter(id => base.recs[id] && vari.recs[id] && base.recs[id].verdict !== 'ERROR' && vari.recs[id].verdict !== 'ERROR')
  const excluded = pairs.length - ids.length

  let verdictAgree = 0, actionAgree = 0, chosenAgree = 0, bothMerge = 0
  const flips: { id: string; why: string[] }[] = []
  const newMerges: string[] = [], lostMerges: string[] = []
  const bandStats = new Map<string, { n: number; agree: number }>()
  for (const id of ids) {
    const b = base.recs[id], v = vari.recs[id], p = byId.get(id)!
    const why: string[] = []
    if (b.verdict === v.verdict) verdictAgree++; else why.push('verdict')
    if (merges(b) === merges(v)) actionAgree++; else why.push(merges(v) ? 'NEW MERGE' : 'lost merge')
    if (merges(b) && merges(v)) {
      bothMerge++
      if (b.chosen === v.chosen) chosenAgree++; else why.push('different target')
    }
    const bs = bandStats.get(p.band) ?? { n: 0, agree: 0 }
    bs.n++; if (merges(b) === merges(v) && (!merges(b) || b.chosen === v.chosen)) bs.agree++
    bandStats.set(p.band, bs)
    if (merges(b) && !merges(v)) lostMerges.push(id)
    if (!merges(b) && merges(v)) newMerges.push(id)
    if (why.length) flips.push({ id, why: why.map(w => ((w === 'NEW MERGE' || w === 'lost merge') && b.verdict === 'SAME' && v.verdict === 'SAME' ? `${w} (boundary hop)` : w)) })
  }
  const decisionAgree = ids.filter(id => {
    const b = base.recs[id], v = vari.recs[id]
    return merges(b) === merges(v) && (!merges(b) || b.chosen === v.chosen)
  }).length

  console.log(`\n=== ${varN} vs ${baseN} — ${ids.length} pairs compared (${excluded} excluded: error or not run) ===`)
  console.log(`variant: effort=${vari.effort ?? 'default'}, k=${vari.k}`)
  console.log(`raw verdict agreement (SAME/DIFFERENT/UNSURE):      ${verdictAgree}/${ids.length}  ${pct(verdictAgree, ids.length)}`)
  console.log(`merge decision agreement (merge vs keep apart):      ${actionAgree}/${ids.length}  ${pct(actionAgree, ids.length)}`)
  console.log(`merge into the same claim, where both merge:         ${chosenAgree}/${bothMerge}  ${pct(chosenAgree, bothMerge)}`)
  console.log(`full decision agreement (merge/keep AND same target): ${decisionAgree}/${ids.length}  ${pct(decisionAgree, ids.length)}`)
  // Split the flips by what moved. A BOUNDARY HOP is SAME on both sides with the confidence
  // straddling the 0.80 bar (0.72/0.78 vs 0.80): the judge agrees the pair is the same fact and
  // only its self-reported confidence wobbled. A REAL FLIP is SAME against DIFFERENT/UNSURE.
  const hop = (id: string) => base.recs[id].verdict === 'SAME' && vari.recs[id].verdict === 'SAME'
  const realNew = newMerges.filter(id => !hop(id))
  const realLost = lostMerges.filter(id => !hop(id))
  console.log(`NEW FALSE MERGES, strict (baseline DIFFERENT/UNSURE, variant merges): ${realNew.length}`)
  console.log(`lost merges, strict (baseline merged, variant says DIFFERENT/UNSURE):  ${realLost.length}`)
  console.log(`boundary hops (SAME both sides, confidence across the 0.80 bar):      +${newMerges.length - realNew.length} merge / -${lostMerges.length - realLost.length} keep apart`)

  console.log('\nby similarity band (decision agreement):')
  for (const [b, s] of [...bandStats.entries()].sort()) console.log(`  ${b.padEnd(10)} ${String(s.agree).padStart(3)}/${String(s.n).padEnd(3)} ${pct(s.agree, s.n)}`)

  // Against Paul's labels, where a human supplied one.
  const lab = (r: Rec) => (merges(r) ? 'SAME' : 'DIFFERENT')
  const labelled = ids.filter(id => byId.get(id)!.label)
  if (labelled.length) {
    const ok = (run: Run) => labelled.filter(id => lab(run.recs[id]) === byId.get(id)!.label).length
    console.log(`\nagainst Paul's labels (${labelled.length} pairs, SAME=${labelled.filter(id => byId.get(id)!.label === 'SAME').length}, DIFFERENT=${labelled.filter(id => byId.get(id)!.label === 'DIFFERENT').length}): baseline ${ok(base)}/${labelled.length}, variant ${ok(vari)}/${labelled.length}`)
    const fm = (run: Run) => labelled.filter(id => byId.get(id)!.label === 'DIFFERENT' && merges(run.recs[id])).length
    console.log(`  false merges vs Paul's DIFFERENT labels: baseline ${fm(base)}, variant ${fm(vari)}`)
  }

  const sb = secs(ids.map(id => base.recs[id])), sv = secs(ids.map(id => vari.recs[id]))
  console.log(`\nseconds per judge call (same pairs): baseline mean ${sb.mean.toFixed(1)} / median ${sb.median.toFixed(1)} / p90 ${sb.p90.toFixed(1)};  variant mean ${sv.mean.toFixed(1)} / median ${sv.median.toFixed(1)} / p90 ${sv.p90.toFixed(1)}  → ${((1 - sv.mean / sb.mean) * 100).toFixed(0)}% faster`)

  console.log(`\nEVERY FLIP (${flips.length}):`)
  for (const f of flips) {
    const p = byId.get(f.id)!, b = base.recs[f.id], v = vari.recs[f.id]
    const tgt = (r: Rec) => (r.chosenRank ? `→#${r.chosenRank}` : '')
    console.log(`\n[${f.why.join(', ')}] ${f.id}  (${p.origin}, ${p.band}, top sim ${p.candidates[0].similarity.toFixed(3)}${p.label ? `, Paul: ${p.label}` : ''})`)
    console.log(`  baseline: ${b.verdict}${tgt(b)} @${b.confidence.toFixed(2)} enrich=${b.enrich} — ${b.reasoning.slice(0, 200)}`)
    console.log(`  variant:  ${v.verdict}${tgt(v)} @${v.confidence.toFixed(2)} enrich=${v.enrich} — ${v.reasoning.slice(0, 200)}`)
    console.log(`  NEW:  ${p.new_statement.slice(0, 260)}`)
    for (const r of new Set([b.chosenRank, v.chosenRank].filter((x): x is number => !!x))) console.log(`  #${r}:   ${p.candidates[r - 1].canonical_statement.slice(0, 260)}`)
    if (!b.chosenRank && !v.chosenRank) console.log(`  #1:   ${p.candidates[0].canonical_statement.slice(0, 260)}`)
  }
}

function skipRuleCmd() {
  const base = loadRun(flag('--base') ?? 'baseline')
  const pairs = loadPairs()
  console.log('If a pair whose BEST candidate scores >= S were merged into that candidate with no judge call,')
  console.log('how often would that match what the judge actually decided? (offline, from the recorded baseline)\n')
  console.log('   S    pairs  judge: merge→#1   merge→other   kept apart   rule would be wrong  share of all pairs')
  const rs = pairs.filter(p => base.recs[p.id] && base.recs[p.id].verdict !== 'ERROR')
  for (const S of [0.84, 0.86, 0.88, 0.9, 0.92, 0.94]) {
    const hit = rs.filter(p => p.candidates[0].similarity >= S)
    const m1 = hit.filter(p => merges(base.recs[p.id]) && base.recs[p.id].chosenRank === 1).length
    const mo = hit.filter(p => merges(base.recs[p.id]) && base.recs[p.id].chosenRank !== 1).length
    const kept = hit.length - m1 - mo
    console.log(`${S.toFixed(2)} ${String(hit.length).padStart(7)} ${String(m1).padStart(14)} ${String(mo).padStart(13)} ${String(kept).padStart(12)} ${String(mo + kept).padStart(15)}   ${pct(hit.length, rs.length).padStart(10)}`)
  }
  const ranks = rs.filter(p => merges(base.recs[p.id])).map(p => base.recs[p.id].chosenRank as number)
  console.log(`\nrank of the candidate the judge merged into (${ranks.length} merges): ` + [1, 2, 3, 4, 5, 6, 7, 8].map(r => `#${r}:${ranks.filter(x => x === r).length}`).join('  '))
}

async function benchCmd() {
  const conc = num('--conc', 4)
  const limit = num('--limit', 40)
  const pairs = loadPairs().filter(p => p.origin === 'twin' || p.origin === 'corpus').slice(0, limit)
  const { runOrdered } = await import('../lib/judgePipeline')
  const { adjudicate } = await import('../lib/consolidation')
  const effort = (flag('--effort') as 'low' | 'medium' | undefined) ?? undefined
  const t0 = Date.now()
  let n = 0
  const { stats } = await runOrdered<Pair, Cand, unknown>(pairs, {
    concurrency: conc,
    search: async p => p.candidates,
    judge: (p, c) => adjudicate(p.new_statement, c, effort ? { effort } : {}).catch(e => ({ verdict: 'ERROR', e: String(e) })),
    apply: async () => { n++ },
  })
  const wall = (Date.now() - t0) / 1000
  console.log(`concurrency ${conc}${effort ? `, effort ${effort}` : ''}: ${n} facts in ${wall.toFixed(0)}s = ${(wall / n).toFixed(1)} s per fact (judged ${stats.judged}, reused ${stats.reused}, stale ${stats.stale})`)
}

async function main() {
  if (cmd === 'run') return runCmd()
  if (cmd === 'compare') return compareCmd()
  if (cmd === 'skiprule') return skipRuleCmd()
  if (cmd === 'bench') return benchCmd()
  throw new Error('usage: evalJudgeSpeedup.ts run|compare|skiprule|bench …')
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
