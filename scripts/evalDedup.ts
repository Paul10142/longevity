/**
 * Dedup-accuracy measurement harness (v4 spec §6.1, guiding doc §D Phase 0).
 *
 *   npx tsx scripts/evalDedup.ts <command>
 *
 * Proves the consolidation engine before anything is built on it. The headline
 * metric is the FALSE-MERGE RATE — the fraction of the merges a prompt makes
 * that ground truth says should have stayed separate. A false merge silently
 * averages away a clinical distinction (dose/population/threshold) and no article
 * score catches it, so it matters more than a missed merge.
 *
 * Commands:
 *   extract                 Pull the consolidator's actual merge decisions from
 *                           the DB into eval/dedup-eval-pairs.json. Needs
 *                           .env.local (Supabase). This is the only DB command.
 *   run <v1|v2> [--limit N] Re-adjudicate every pair with the chosen prompt via
 *                           the LLM, writing eval/dedup-run-<v>.json. Needs the
 *                           LLM backend (LLM_BACKEND=claude-code uses the local
 *                           `claude` CLI and no API key). No DB.
 *   score                   Join the runs + gold set and print the metrics:
 *                           false-merge rate (baseline v1 vs fixed v2), recall,
 *                           judge-vs-human agreement (κ), and the auto-accept
 *                           confidence threshold. No DB, no LLM.
 *
 * The gold set (eval/dedup-goldset.json) is the human-labelled ground truth and
 * a DURABLE, checked-in asset: it certifies an automated judge (agreement) and
 * sets the auto-accept threshold, which is how human review volume stays flat as
 * the corpus grows (the path to running consolidation unattended — "Route 3").
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { claudeJson, CLAUDE_JUDGMENT_MODEL } from '../lib/llm'
import { ADJUDICATION_V1, ADJUDICATION_V2 } from '../lib/adjudicationPrompts'

const EVAL_DIR = 'eval'
const PAIRS_FILE = `${EVAL_DIR}/dedup-eval-pairs.json`
const GOLDSET_FILE = `${EVAL_DIR}/dedup-goldset.json`
const runFile = (v: PromptVersion) => `${EVAL_DIR}/dedup-run-${v}.json`

type PromptVersion = 'v1' | 'v2'
type Verdict = 'SAME' | 'DIFFERENT' | 'UNSURE'
type Label = 'SAME' | 'DIFFERENT'

/** One adjudication the eval re-runs: a new insight vs the single existing claim
 *  the ANN/consolidator paired it with. Single-candidate framing is deliberate —
 *  it isolates the fidelity question "should THESE two be one claim?". */
type EvalPair = {
  id: string
  kind: 'merge' | 'recall'
  new_statement: string
  new_quote: string | null
  candidate_claim_id: string
  candidate_statement: string
  candidate_context: string | null
  candidate_quote: string | null
  similarity: number | null
  stored_confidence: number | null
  consolidator_verdict: 'SAME' | 'DIFFERENT'
}

type GoldLabel = {
  id: string
  label: Label
  confirmed: boolean // false = proposed by Claude, awaiting Paul's confirmation
  labeled_by: string
  rationale: string
}

type RunResult = {
  id: string
  verdict: Verdict
  candidate_index: number | null
  confidence: number
  reasoning: string
}

// ── io helpers ──────────────────────────────────────────────
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

// ── extract (DB) ────────────────────────────────────────────
/** Pull the consolidator's real merge decisions. Every `matched_by='auto'`
 *  claim_member is a merge the current (v1) prompt made: the member insight was
 *  judged SAME as its claim's seed. We emit each as a pair to be re-judged and
 *  labelled. (DIFFERENT decisions aren't persisted, so recall pairs are
 *  reconstructed by ANN over the seeds — a follow-up; merges are the headline.) */
async function extract(): Promise<void> {
  process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured — need .env.local')
  const db = supabaseAdmin

  // Auto-merged members + the claim they were folded into.
  const { data: merges, error } = await db
    .from('claim_members')
    .select('raw_insight_id, claim_id, match_confidence, matched_by, raw_insights(statement, direct_quote), claims(canonical_statement, context_note)')
    .eq('matched_by', 'auto')
  if (error) throw new Error(`load merges: ${error.message}`)

  // One representative seed quote per claim (the member the claim was seeded from).
  const claimIds = Array.from(new Set((merges ?? []).map((m: { claim_id: string }) => m.claim_id)))
  const seedQuoteByClaim = new Map<string, string | null>()
  for (let i = 0; i < claimIds.length; i += 200) {
    const batch = claimIds.slice(i, i + 200)
    const { data: seeds } = await db
      .from('claim_members')
      .select('claim_id, matched_by, raw_insights(direct_quote)')
      .in('claim_id', batch)
      .eq('matched_by', 'seed')
    for (const s of (seeds ?? []) as { claim_id: string; raw_insights: { direct_quote: string | null } | null }[]) {
      if (!seedQuoteByClaim.has(s.claim_id)) seedQuoteByClaim.set(s.claim_id, s.raw_insights?.direct_quote ?? null)
    }
  }

  const pairs: EvalPair[] = (merges ?? []).map((m: {
    raw_insight_id: string; claim_id: string; match_confidence: number | null
    raw_insights: { statement: string; direct_quote: string | null } | null
    claims: { canonical_statement: string; context_note: string | null } | null
  }) => ({
    id: `merge:${m.raw_insight_id}`,
    kind: 'merge',
    new_statement: m.raw_insights?.statement ?? '',
    new_quote: m.raw_insights?.direct_quote ?? null,
    candidate_claim_id: m.claim_id,
    candidate_statement: m.claims?.canonical_statement ?? '',
    candidate_context: m.claims?.context_note ?? null,
    candidate_quote: seedQuoteByClaim.get(m.claim_id) ?? null,
    similarity: null,
    stored_confidence: m.match_confidence,
    consolidator_verdict: 'SAME',
  }))

  writeJson(PAIRS_FILE, pairs)
  console.log(`Extracted ${pairs.length} merge pair(s) → ${PAIRS_FILE}`)
  console.log('Next: label them (eval/dedup-goldset.json), then `run v1`, `run v2`, `score`.')
}

// ── run (LLM) ───────────────────────────────────────────────
const PROMPT: Record<PromptVersion, string> = { v1: ADJUDICATION_V1, v2: ADJUDICATION_V2 }

async function adjudicatePair(promptText: string, pair: EvalPair): Promise<RunResult> {
  const candidate = `1. ${pair.candidate_statement}${pair.candidate_context ? ` (${pair.candidate_context})` : ''}`
  try {
    const parsed = await claudeJson<{ verdict?: string; candidate_index?: number | null; confidence?: number; reasoning?: string }>(
      promptText,
      `NEW insight:\n${pair.new_statement}\n\nEXISTING claims:\n${candidate}`,
      2000,
      CLAUDE_JUDGMENT_MODEL
    )
    const verdict: Verdict = parsed.verdict === 'SAME' || parsed.verdict === 'UNSURE' ? parsed.verdict : 'DIFFERENT'
    return {
      id: pair.id,
      verdict,
      candidate_index: typeof parsed.candidate_index === 'number' ? parsed.candidate_index : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: parsed.reasoning ?? '',
    }
  } catch (err) {
    return { id: pair.id, verdict: 'DIFFERENT', confidence: 0, candidate_index: null, reasoning: `error: ${err instanceof Error ? err.message : err}` }
  }
}

async function run(version: PromptVersion, limit?: number): Promise<void> {
  process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
  if (!existsSync(PAIRS_FILE)) throw new Error(`${PAIRS_FILE} missing — run \`extract\` first`)
  let pairs = readJson<EvalPair[]>(PAIRS_FILE)
  if (limit) pairs = pairs.slice(0, limit)
  const results: RunResult[] = []
  for (let i = 0; i < pairs.length; i++) {
    results.push(await adjudicatePair(PROMPT[version], pairs[i]))
    if ((i + 1) % 10 === 0 || i === pairs.length - 1) console.log(`  ${version}: ${i + 1}/${pairs.length}`)
    writeJson(runFile(version), results) // checkpoint each step — CLI calls are slow
  }
  const same = results.filter(r => r.verdict === 'SAME').length
  console.log(`Ran ${version} on ${results.length} pair(s): ${same} SAME, ${results.length - same} not-SAME → ${runFile(version)}`)
}

// ── score ───────────────────────────────────────────────────
function cohenKappa(a: boolean[], b: boolean[]): number {
  const n = a.length
  if (n === 0) return NaN
  let agree = 0, aTrue = 0, bTrue = 0
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++
    if (a[i]) aTrue++
    if (b[i]) bTrue++
  }
  const po = agree / n
  const pe = (aTrue / n) * (bTrue / n) + (1 - aTrue / n) * (1 - bTrue / n)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a'
}

function scorePrompt(label: string, results: RunResult[], gold: Map<string, GoldLabel>): void {
  const rows = results
    .map(r => ({ r, g: gold.get(r.id) }))
    .filter((x): x is { r: RunResult; g: GoldLabel } => Boolean(x.g))
  if (rows.length === 0) {
    console.log(`\n[${label}] no labelled pairs to score.`)
    return
  }
  const provisional = rows.some(x => !x.g.confirmed)
  const saidSame = (r: RunResult) => r.verdict === 'SAME'
  const goldSame = (g: GoldLabel) => g.label === 'SAME'

  const mergesMade = rows.filter(x => saidSame(x.r))
  const falseMerges = mergesMade.filter(x => !goldSame(x.g))
  const goldSameRows = rows.filter(x => goldSame(x.g))
  const caughtMerges = goldSameRows.filter(x => saidSame(x.r))

  const falseMergeRate = mergesMade.length ? falseMerges.length / mergesMade.length : 0
  const recall = goldSameRows.length ? caughtMerges.length / goldSameRows.length : NaN
  const kappa = cohenKappa(rows.map(x => saidSame(x.r)), rows.map(x => goldSame(x.g)))

  console.log(`\n[${label}] over ${rows.length} labelled pair(s)${provisional ? '  (PROVISIONAL — includes unconfirmed labels)' : ''}`)
  console.log(`  merges made:        ${mergesMade.length}`)
  console.log(`  FALSE-MERGE RATE:   ${pct(falseMergeRate)}  (${falseMerges.length}/${mergesMade.length} merges are truly DIFFERENT)`)
  console.log(`  recall on merges:   ${pct(recall)}  (${caughtMerges.length}/${goldSameRows.length} true-SAME pairs merged)`)
  console.log(`  judge↔human κ:      ${Number.isFinite(kappa) ? kappa.toFixed(2) : 'n/a'}`)

  // Auto-accept threshold: the confidence above which SAME verdicts are never
  // wrong on this gold set — the band the engine can merge unattended (§C3).
  const sameByConf = mergesMade.map(x => ({ conf: x.r.confidence, wrong: !goldSame(x.g) })).sort((a, b) => b.conf - a.conf)
  let cutoff: number | null = null, covered = 0
  for (let i = 0; i < sameByConf.length; i++) {
    if (sameByConf[i].wrong) break
    cutoff = sameByConf[i].conf
    covered = i + 1
  }
  if (cutoff !== null) {
    console.log(`  auto-accept ≥ ${cutoff.toFixed(2)}:  ${covered}/${mergesMade.length} merges safe to auto-accept (0 false merges above the line)`)
  } else if (mergesMade.length) {
    console.log(`  auto-accept:        none — the highest-confidence merge is already a false merge`)
  }

  if (falseMerges.length) {
    console.log(`  false merges (${label}):`)
    for (const x of falseMerges.slice(0, 20)) console.log(`    - ${x.r.id}  conf ${x.r.confidence.toFixed(2)}  «${x.r.reasoning.slice(0, 90)}»`)
  }
}

function score(): void {
  if (!existsSync(GOLDSET_FILE)) throw new Error(`${GOLDSET_FILE} missing — label the pairs first`)
  const goldArr = readJson<GoldLabel[]>(GOLDSET_FILE)
  const gold = new Map(goldArr.map(g => [g.id, g]))
  const confirmed = goldArr.filter(g => g.confirmed).length
  console.log(`Gold set: ${goldArr.length} label(s), ${confirmed} confirmed, ${goldArr.length - confirmed} proposed.`)

  const v1 = existsSync(runFile('v1')) ? readJson<RunResult[]>(runFile('v1')) : null
  const v2 = existsSync(runFile('v2')) ? readJson<RunResult[]>(runFile('v2')) : null
  if (v1) scorePrompt('v1 — current (baseline)', v1, gold)
  if (v2) scorePrompt('v2 — fixed (§A2)', v2, gold)

  // Before/after flips: the merges the fix splits (v1 SAME → v2 DIFFERENT).
  if (v1 && v2) {
    const v2ById = new Map(v2.map(r => [r.id, r]))
    const flips = v1.filter(a => a.verdict === 'SAME' && v2ById.get(a.id)?.verdict !== 'SAME')
    console.log(`\nFlips (v1 SAME → v2 not-SAME): ${flips.length}`)
    for (const f of flips.slice(0, 40)) {
      const g = gold.get(f.id)
      const correct = g ? (g.label === 'DIFFERENT' ? '✓ correct split' : '✗ wrong split') : '(unlabelled)'
      console.log(`  - ${f.id}  ${correct}  «${(v2ById.get(f.id)?.reasoning ?? '').slice(0, 80)}»`)
    }
  }
}

// ── main ────────────────────────────────────────────────────
async function main() {
  const [cmd, arg, flag, flagVal] = process.argv.slice(2)
  const limit = flag === '--limit' ? Number(flagVal) : undefined
  switch (cmd) {
    case 'extract': await extract(); return
    case 'run': {
      if (arg !== 'v1' && arg !== 'v2') throw new Error('usage: run <v1|v2> [--limit N]')
      await run(arg, limit); return
    }
    case 'score': score(); return
    default:
      console.log('usage: npx tsx scripts/evalDedup.ts <extract|run v1|run v2|score>')
      process.exit(1)
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
