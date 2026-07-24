/**
 * Enrich-merge local verification (v4 spec §6 / §6.1; seeds task #8, the
 * merge-fidelity eval). NOT a production run — it never touches the database.
 *
 *   npx tsx scripts/testEnrichMerge.ts [--limit N] [--no-judge]
 *
 * Runs enrich-merge over the 30 `enrich` pairs in the dedup gold set and checks
 * the resulting canonical carries BOTH sides' detail. Each pair is treated as a
 * two-member claim: the candidate statement is the prior canonical (the seed the
 * live `attachMember` would keep), the new statement is the member whose detail
 * today gets buried. We synthesize the enriched canonical and score whether it
 * preserved everything:
 *
 *   - fidelity guard   — did the rewrite invent a numeric specific no member had?
 *                        (a reject keeps the prior canonical; that is correct
 *                        behaviour, but is surfaced so we can see it)
 *   - numeric coverage — are ALL numbers from BOTH sides present in the canonical?
 *                        This is the crisp detector of a lossy merge (a buried or
 *                        averaged-away dose/threshold drops a number).
 *   - both-sides judge — a Haiku pass confirming each side's concrete content
 *                        survived (covers the 19 pairs with no numbers). --no-judge
 *                        skips it.
 *
 * Uses the pure synthesis + guard from lib/enrichMerge (no Supabase). Defaults to
 * LLM_BACKEND=claude-code (bills the subscription, no API key). Checkpoints to
 * eval/enrich-merge-test.json so a throttled batch resumes without re-running.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { claudeJson, CLAUDE_BULK_MODEL } from '../lib/llm'
import { synthesizeEnrichedCanonical, numericSpecifics } from '../lib/enrichMerge'

const EVAL_DIR = 'eval'
const GOLDSET_FILE = `${EVAL_DIR}/dedup-goldset.json`
const PAIRS_FILE = `${EVAL_DIR}/dedup-eval-pairs.json`
const OUT_FILE = `${EVAL_DIR}/enrich-merge-test.json`

type GoldLabel = { id: string; label: string; desired_operation?: string; rationale?: string }
type EvalPair = {
  id: string
  new_statement: string
  new_quote: string | null
  candidate_statement: string
  candidate_context: string | null
  candidate_quote: string | null
}
type Judge = { a_preserved: boolean; b_preserved: boolean; dropped: string[] }
type Result = {
  id: string
  prior: string
  canonical: string
  changed: boolean
  rejected: boolean
  invented: string[]
  missing_a: string[] // numbers from the candidate side absent from the canonical
  missing_b: string[] // numbers from the new side absent from the canonical
  judge: Judge | null
  error: string | null
  rationale?: string
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Numbers in `wanted` that do not appear (as numeric literals) in `have`. */
function missingNumbers(wanted: string, have: string): string[] {
  const haveSet = new Set(numericSpecifics(have))
  return numericSpecifics(wanted).filter(n => !haveSet.has(n))
}

const JUDGE_SYSTEM = `
You verify that a MERGED medical claim preserved the concrete content of the two source statements it was merged from. Preserved means every load-bearing specific — number, dose, population, threshold, timeframe, caveat, mechanism, effect size, named condition, or recommendation — from each source appears in the merged claim (wording may differ). Do not require stylistic overlap; require the substance.

Return STRICT JSON: {"a_preserved":<bool>,"b_preserved":<bool>,"dropped":["<each concrete detail from A or B missing from the merged claim>"]}
`.trim()

async function judgeBothSides(merged: string, a: string, b: string, retries = 4): Promise<Judge> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 20_000))
    try {
      const p = await claudeJson<Partial<Judge>>(
        JUDGE_SYSTEM,
        `MERGED claim:\n${merged}\n\nSOURCE A:\n${a}\n\nSOURCE B:\n${b}`,
        1500,
        CLAUDE_BULK_MODEL
      )
      return { a_preserved: p.a_preserved === true, b_preserved: p.b_preserved === true, dropped: Array.isArray(p.dropped) ? p.dropped : [] }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

async function runPair(pair: EvalPair, gold: GoldLabel, useJudge: boolean, retries = 4): Promise<Result> {
  const prior = pair.candidate_statement
  const members = [pair.candidate_statement, pair.new_statement]
  const quotes = [pair.candidate_quote, pair.new_quote].filter((q): q is string => Boolean(q))

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 20_000))
    try {
      const r = await synthesizeEnrichedCanonical(prior, members, { memberQuotes: quotes })
      // A synthesis failure is reported inside r.reason (prior kept, not changed);
      // treat it as retryable rather than a real result.
      if (!r.changed && !r.rejected && /synthesis failed|empty synthesis/.test(r.reason)) {
        throw new Error(r.reason)
      }
      const canonical = r.canonical
      const judge = useJudge && !r.rejected ? await judgeBothSides(canonical, pair.candidate_statement, pair.new_statement) : null
      return {
        id: pair.id,
        prior,
        canonical,
        changed: r.changed,
        rejected: r.rejected,
        invented: r.invented,
        missing_a: missingNumbers(pair.candidate_statement, canonical),
        missing_b: missingNumbers(pair.new_statement, canonical),
        judge,
        error: null,
        rationale: gold.rationale,
      }
    } catch (err) {
      lastErr = err
    }
  }
  return {
    id: pair.id, prior, canonical: prior, changed: false, rejected: false, invented: [],
    missing_a: [], missing_b: [], judge: null,
    error: `error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    rationale: gold.rationale,
  }
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a'
}

async function main() {
  process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
  const args = process.argv.slice(2)
  const useJudge = !args.includes('--no-judge')
  const li = args.indexOf('--limit')
  const limit = li >= 0 ? Number(args[li + 1]) : undefined

  const gold = readJson<GoldLabel[]>(GOLDSET_FILE).filter(g => g.desired_operation === 'enrich')
  const pairsById = new Map(readJson<EvalPair[]>(PAIRS_FILE).map(p => [p.id, p]))
  let enrichGold = gold.filter(g => pairsById.has(g.id))
  if (limit) enrichGold = enrichGold.slice(0, limit)
  console.log(`Enrich pairs to test: ${enrichGold.length}${limit ? ` (limited)` : ''}  |  judge: ${useJudge ? 'on' : 'off'}`)

  // Resume: keep prior non-errored results, re-run only missing/errored.
  const prior = existsSync(OUT_FILE) ? new Map(readJson<Result[]>(OUT_FILE).map(r => [r.id, r])) : new Map<string, Result>()
  const results: Result[] = []
  let done = 0
  for (const g of enrichGold) {
    const cached = prior.get(g.id)
    if (cached && !cached.error && (!useJudge || cached.judge)) {
      results.push(cached)
    } else {
      results.push(await runPair(pairsById.get(g.id)!, g, useJudge))
      writeJson(OUT_FILE, [...prior.values(), ...results.filter(r => !prior.has(r.id))].reduce((acc, r) => {
        const i = acc.findIndex(x => x.id === r.id); if (i >= 0) acc[i] = r; else acc.push(r); return acc
      }, [] as Result[]))
    }
    if (++done % 5 === 0 || done === enrichGold.length) console.log(`  ${done}/${enrichGold.length}`)
  }
  writeJson(OUT_FILE, results)

  // ── report ──
  const errored = results.filter(r => r.error)
  const scored = results.filter(r => !r.error)
  const rejected = scored.filter(r => r.rejected)
  // "numeric-complete": pairs where NO number from either side is missing.
  const numericComplete = scored.filter(r => r.missing_a.length === 0 && r.missing_b.length === 0)
  const judged = scored.filter(r => r.judge)
  const bothPreserved = judged.filter(r => r.judge!.a_preserved && r.judge!.b_preserved)
  // Overall pass: guard did not reject, no number dropped, and (if judged) both sides preserved.
  const carriedBoth = scored.filter(
    r => !r.rejected && r.missing_a.length === 0 && r.missing_b.length === 0 && (!r.judge || (r.judge.a_preserved && r.judge.b_preserved))
  )

  console.log(`\n── enrich-merge over ${scored.length} enrich pair(s) ${errored.length ? `(${errored.length} errored, excluded)` : ''} ──`)
  console.log(`  fidelity guard clean (no invented specifics):  ${scored.length - rejected.length}/${scored.length}`)
  console.log(`  numeric-complete (no number dropped, both sides): ${numericComplete.length}/${scored.length}`)
  if (useJudge) console.log(`  both-sides preserved (Haiku judge):            ${bothPreserved.length}/${judged.length}`)
  console.log(`  CARRIED BOTH SIDES (overall):                  ${carriedBoth.length}/${scored.length}  (${pct(carriedBoth.length / scored.length)})`)

  const misses = scored.filter(r => !carriedBoth.includes(r))
  if (misses.length) {
    console.log(`\n  misses / notes:`)
    for (const r of misses) {
      const bits: string[] = []
      if (r.rejected) bits.push(`GUARD REJECT invented[${r.invented.join(',')}]`)
      if (r.missing_a.length) bits.push(`dropped A#[${r.missing_a.join(',')}]`)
      if (r.missing_b.length) bits.push(`dropped B#[${r.missing_b.join(',')}]`)
      if (r.judge && !r.judge.a_preserved) bits.push('judge: A not preserved')
      if (r.judge && !r.judge.b_preserved) bits.push('judge: B not preserved')
      if (r.judge?.dropped.length) bits.push(`judge dropped: ${r.judge.dropped.slice(0, 3).join('; ')}`)
      console.log(`    - ${r.id}\n        ${bits.join('  |  ')}`)
      console.log(`        canonical: ${r.canonical.slice(0, 220)}`)
    }
  }
  if (errored.length) {
    console.log(`\n  errored (re-run to repair): ${errored.map(r => r.id).join(', ')}`)
  }
  console.log(`\nWrote ${OUT_FILE}`)
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
