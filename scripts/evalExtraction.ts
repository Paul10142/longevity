/**
 * Extraction-fidelity harness (v4 spec §6.2, Paul's 2026-07-23 calibration).
 *
 *   npx tsx --env-file=.env.local scripts/evalExtraction.ts <command>
 *
 * The §6.1 dedup harness measures *merge* fidelity — did we wrongly fuse two
 * claims. It says nothing about whether `raw_insights.statement` (an LLM
 * paraphrase of one ~2400-char chunk) faithfully preserves what the source
 * actually said. A claim can dedup perfectly and still misstate its source, and
 * because consolidation only ever reads `statement`, an extraction error is
 * invisible from there on. This is the second axis.
 *
 * The cardinal failure is INVENTION: the statement asserting something the chunk
 * does not support. Principle 1 — the system contributes syntax, never substance
 * — is exactly this, and the fix for missing-but-true detail is the reference
 * layer, never editing the paraphrase. So the headline metric is the
 * INVENTION RATE, not overall accuracy.
 *
 * Commands:
 *   verify                  Zero-cost, zero-LLM provenance check over the whole
 *                           corpus: what fraction of insights carry a
 *                           direct_quote found character-for-character in their
 *                           chunk. Run this any time. DB only.
 *   sample [--n N]          Pull N insights + their chunk text into
 *                           eval/extraction-eval-pairs.json (default 40,
 *                           stratified across sources). DB only.
 *   run [--limit N]         Judge each pair with the LLM → eval/extraction-run.json.
 *                           Resumable. No DB.
 *   score                   Join the run with eval/extraction-goldset.json and
 *                           print invention rate, qualifier-drop rate,
 *                           coreference loss, and judge↔human κ. No DB, no LLM.
 *
 * `verify` and `sample` read the corpus, so run them when a rebuild is FINISHED —
 * mid-drain they measure a half-built corpus. `run` uses the same local `claude`
 * CLI the pipeline does; running both at once throttles the subscription.
 */

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { claudeJson, CLAUDE_JUDGMENT_MODEL } from '../lib/llm'

const EVAL_DIR = 'eval'
const PAIRS_FILE = `${EVAL_DIR}/extraction-eval-pairs.json`
const GOLDSET_FILE = `${EVAL_DIR}/extraction-goldset.json`
const RUN_FILE = `${EVAL_DIR}/extraction-run.json`

/** The judge's verdict space, one per failure mode in spec §6.2. */
type Verdict =
  | 'FAITHFUL'            // every load-bearing element traces to the chunk
  | 'ADDED_DETAIL'        // asserts something the chunk does not support (principle 1)
  | 'DROPPED_QUALIFIER'   // omits a stated qualifier that changes applicability
  | 'UNRESOLVED_REFERENCE'// depends on a referent this chunk never defines
  | 'UNSURE'

/** One insight to judge, with the chunk it was extracted from. Self-contained:
 *  the chunk text is embedded, so the file stays scoreable after a re-extraction
 *  deletes the underlying rows. */
type EvalItem = {
  id: string                 // `extract:<raw_insight_id>`
  source_title: string
  statement: string
  context_note: string | null
  qualifiers: Record<string, unknown> | null
  direct_quote: string | null
  quote_verified: boolean    // quote_char_start was non-null → found verbatim
  chunk_text: string
}

type RunResult = {
  id: string
  verdict: Verdict
  /** The specific span at fault — what was added, dropped, or left dangling. */
  offending: string
  reasoning: string
}

type GoldLabel = {
  id: string
  label: Verdict
  confirmed: boolean // false = proposed by Claude, awaiting Paul's sign-off
  labeled_by: string
  rationale: string
}

// ── io helpers ──────────────────────────────────────────────
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}
function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a'
}

async function loadDb() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured — need .env.local')
  return supabaseAdmin
}

// ── verify (DB, no LLM) ─────────────────────────────────────
/**
 * Deterministic provenance check. `extractFromChunk` stores `quote_char_start`
 * only when the model's `direct_quote` was located character-for-character in
 * the chunk (lib/extraction.ts) — so a null start on a non-null quote means the
 * model returned a quote that is NOT in the source text. That is a fabricated
 * quote, catchable for free, and it is the one fidelity signal that needs no
 * judge and no labels.
 */
async function verify(): Promise<void> {
  const db = await loadDb()
  const bySource = new Map<string, { title: string; total: number; quoted: number; located: number }>()

  const { data: sources } = await db.from('sources').select('id, title')
  for (const s of (sources ?? []) as { id: string; title: string }[]) {
    bySource.set(s.id, { title: s.title, total: 0, quoted: 0, located: 0 })
  }

  // Paged: PostgREST caps an unpaginated select at 1000 rows.
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('raw_insights')
      .select('source_id, direct_quote, quote_char_start')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load insights: ${error.message}`)
    const rows = (data ?? []) as { source_id: string; direct_quote: string | null; quote_char_start: number | null }[]
    for (const r of rows) {
      const agg = bySource.get(r.source_id)
      if (!agg) continue
      agg.total++
      if (r.direct_quote) agg.quoted++
      if (r.quote_char_start != null) agg.located++
    }
    if (rows.length < PAGE) break
  }

  console.log('\nQUOTE PROVENANCE — verbatim spans located in their chunk\n')
  console.log(`  ${'source'.padEnd(38)}${'insights'.padEnd(10)}${'quoted'.padEnd(10)}${'located'.padEnd(10)}rate`)
  let total = 0, quoted = 0, located = 0
  for (const agg of bySource.values()) {
    if (agg.total === 0) continue
    total += agg.total; quoted += agg.quoted; located += agg.located
    const title = agg.title.length > 36 ? `${agg.title.slice(0, 35)}…` : agg.title
    const rate = agg.quoted ? agg.located / agg.quoted : NaN
    console.log(`  ${title.padEnd(38)}${String(agg.total).padEnd(10)}${String(agg.quoted).padEnd(10)}${String(agg.located).padEnd(10)}${pct(rate)}`)
  }
  console.log(`\n  ${'TOTAL'.padEnd(38)}${String(total).padEnd(10)}${String(quoted).padEnd(10)}${String(located).padEnd(10)}${pct(quoted ? located / quoted : NaN)}`)
  const fabricated = quoted - located
  console.log(
    fabricated === 0
      ? '\n  ✓ every direct_quote appears verbatim in its chunk.\n'
      : `\n  ⚠ ${fabricated} quote(s) were NOT found in their chunk — the model did not copy verbatim.\n`
  )
  const unquoted = total - quoted
  if (unquoted) console.log(`  ${unquoted} insight(s) carry no quote at all (the prompt allows null when no single span supports it).\n`)
}

// ── sample (DB) ─────────────────────────────────────────────
async function sample(n: number): Promise<void> {
  if (existsSync(PAIRS_FILE) && existsSync(GOLDSET_FILE)) {
    throw new Error(
      `${PAIRS_FILE} already exists alongside a gold set — overwriting it would orphan the labels in ${GOLDSET_FILE}.\n` +
      `Delete both deliberately to start a new labelling pass.`
    )
  }
  const db = await loadDb()

  const { data: sources } = await db.from('sources').select('id, title')
  const titleById = new Map((( sources ?? []) as { id: string; title: string }[]).map(s => [s.id, s.title]))

  // Stratify: an equal slice per source, so one long podcast cannot dominate the
  // sample and hide a failure mode specific to another source's transcript style.
  const perSource = Math.max(1, Math.ceil(n / Math.max(1, titleById.size)))
  const items: EvalItem[] = []

  for (const [sourceId, title] of titleById) {
    const { data, error } = await db
      .from('raw_insights')
      .select('id, statement, context_note, qualifiers, direct_quote, quote_char_start, chunks(content)')
      .eq('source_id', sourceId)
      .not('chunk_id', 'is', null)
      .limit(perSource * 3) // over-fetch, then spread across the source
    if (error) throw new Error(`sample ${title}: ${error.message}`)

    type Row = {
      id: string; statement: string; context_note: string | null
      qualifiers: Record<string, unknown> | null
      direct_quote: string | null; quote_char_start: number | null
      chunks: { content: string } | null
    }
    const rows = (data ?? []) as Row[]
    // Even stride through the source rather than the first N — the opening
    // chunks of a transcript are unrepresentative (intros, framing).
    const stride = Math.max(1, Math.floor(rows.length / perSource))
    for (let i = 0; i < rows.length && items.filter(x => x.source_title === title).length < perSource; i += stride) {
      const r = rows[i]
      if (!r.chunks?.content) continue
      items.push({
        id: `extract:${r.id}`,
        source_title: title,
        statement: r.statement,
        context_note: r.context_note,
        qualifiers: r.qualifiers,
        direct_quote: r.direct_quote,
        quote_verified: r.quote_char_start != null,
        chunk_text: r.chunks.content,
      })
    }
  }

  writeJson(PAIRS_FILE, items)
  console.log(`Sampled ${items.length} insight(s) across ${titleById.size} source(s) → ${PAIRS_FILE}`)
  console.log(`  ${items.filter(i => i.quote_verified).length} carry a verbatim-located quote.`)
  console.log('Next: `run`, then label into eval/extraction-goldset.json, then `score`.')
}

// ── run (LLM) ───────────────────────────────────────────────
const JUDGE_SYSTEM = `
You audit whether a one-sentence INSIGHT faithfully represents the TRANSCRIPT CHUNK it was extracted from.

You are checking FAITHFULNESS TO WHAT THE SOURCE SAID — not medical correctness, not completeness. A statement can be medically incomplete and still faithful. A statement can be medically true and still UNFAITHFUL, if the chunk did not say it.

Return exactly one verdict:

- "ADDED_DETAIL" — the insight asserts a specific the chunk does not support: a number, dose, population, mechanism, or named entity that is absent from the chunk, OR a claim the chunk only gestures at. Being TRUE does not excuse it. This is the most serious verdict; look for it first.
- "DROPPED_QUALIFIER" — the chunk stated a qualifier that limits when the claim holds (population, dose, duration, comorbidity, "in athletes", "after age 50", "on a low-carb diet") and the insight states the claim without it, so it reads as more general than the source made it.
- "UNRESOLVED_REFERENCE" — the insight depends on something this chunk never defines ("that protocol", "this rebalancing", "the second mechanism"), because extraction sees one chunk at a time and the referent was established elsewhere.
- "FAITHFUL" — every load-bearing element traces to the chunk, and no stated qualifier was lost.
- "UNSURE" — the chunk is too garbled or the call is genuinely too close.

Ignore: paraphrasing, reordering, compression, and dropped conversational filler. Rewording is the job. Only flag changes that alter what a clinician would DO with the statement.

Return ONLY JSON:
{"verdict":"FAITHFUL|ADDED_DETAIL|DROPPED_QUALIFIER|UNRESOLVED_REFERENCE|UNSURE","offending":"the exact phrase at fault, or empty when FAITHFUL","reasoning":"one sentence"}
`.trim()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** An errored judgement is a MISSING measurement, never a verdict — counting it
 *  as FAITHFUL would flatter the engine, and as a failure would libel it. */
const isReal = (r: RunResult | undefined): r is RunResult => Boolean(r && !r.reasoning.startsWith('error:'))

async function judge(item: EvalItem, retries = 5): Promise<RunResult> {
  const user = [
    `TRANSCRIPT CHUNK:\n${item.chunk_text}`,
    `\nINSIGHT:\n${item.statement}`,
    item.context_note ? `\nCONTEXT NOTE:\n${item.context_note}` : '',
    item.direct_quote ? `\nQUOTE THE EXTRACTOR CITED:\n${item.direct_quote}` : '',
  ].join('\n')

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 30_000))
    try {
      const parsed = await claudeJson<{ verdict?: string; offending?: string; reasoning?: string }>(
        JUDGE_SYSTEM, user, 1200, CLAUDE_JUDGMENT_MODEL
      )
      const allowed: Verdict[] = ['FAITHFUL', 'ADDED_DETAIL', 'DROPPED_QUALIFIER', 'UNRESOLVED_REFERENCE', 'UNSURE']
      const verdict = allowed.includes(parsed.verdict as Verdict) ? (parsed.verdict as Verdict) : 'UNSURE'
      return { id: item.id, verdict, offending: parsed.offending ?? '', reasoning: parsed.reasoning ?? '' }
    } catch (err) {
      lastErr = err
    }
  }
  return { id: item.id, verdict: 'UNSURE', offending: '', reasoning: `error: ${lastErr instanceof Error ? lastErr.message : lastErr}` }
}

async function run(limit?: number): Promise<void> {
  if (!existsSync(PAIRS_FILE)) throw new Error(`${PAIRS_FILE} missing — run \`sample\` first`)
  let items = readJson<EvalItem[]>(PAIRS_FILE)
  if (limit) items = items.slice(0, limit)

  // Resume: keep prior REAL judgements, re-run only missing/errored ones.
  const prior = existsSync(RUN_FILE)
    ? new Map(readJson<RunResult[]>(RUN_FILE).map(r => [r.id, r]))
    : new Map<string, RunResult>()
  const results: RunResult[] = items.map(
    i => prior.get(i.id) ?? { id: i.id, verdict: 'UNSURE', offending: '', reasoning: 'error: pending' }
  )
  const todo = items.map((i, idx) => ({ i, idx })).filter(({ i }) => !isReal(prior.get(i.id)))
  console.log(`  ${items.length - todo.length}/${items.length} already judged; judging ${todo.length}`)

  let done = 0
  for (const { i, idx } of todo) {
    results[idx] = await judge(i)
    if (++done % 5 === 0 || done === todo.length) console.log(`  +${done}/${todo.length}`)
    writeJson(RUN_FILE, results) // checkpoint each step — CLI calls are slow
  }
  const errored = results.filter(r => !isReal(r)).length
  console.log(`Judged ${results.length} insight(s)${errored ? `, ${errored} STILL ERRORED` : ''} → ${RUN_FILE}`)
  summarize(results)
}

// ── score ───────────────────────────────────────────────────
function cohenKappa(a: string[], b: string[]): number {
  const n = a.length
  if (n === 0) return NaN
  const labels = Array.from(new Set([...a, ...b]))
  let agree = 0
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++
  const po = agree / n
  const pe = labels.reduce((sum, l) => {
    const pa = a.filter(x => x === l).length / n
    const pb = b.filter(x => x === l).length / n
    return sum + pa * pb
  }, 0)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}

/** Distribution + the headline rates. Used by `run` (unlabelled) and `score`. */
function summarize(results: RunResult[]): void {
  const real = results.filter(isReal)
  if (real.length === 0) return
  const count = (v: Verdict) => real.filter(r => r.verdict === v).length
  console.log(`\n  over ${real.length} judged insight(s):`)
  console.log(`  INVENTION RATE:       ${pct(count('ADDED_DETAIL') / real.length)}  (${count('ADDED_DETAIL')} assert what the chunk does not support)`)
  console.log(`  dropped qualifier:    ${pct(count('DROPPED_QUALIFIER') / real.length)}  (${count('DROPPED_QUALIFIER')})`)
  console.log(`  unresolved reference: ${pct(count('UNRESOLVED_REFERENCE') / real.length)}  (${count('UNRESOLVED_REFERENCE')})`)
  console.log(`  faithful:             ${pct(count('FAITHFUL') / real.length)}  (${count('FAITHFUL')})`)
  console.log(`  unsure:               ${count('UNSURE')}`)

  const worst = real.filter(r => r.verdict === 'ADDED_DETAIL')
  if (worst.length) {
    console.log(`\n  inventions (principle-1 violations):`)
    for (const w of worst.slice(0, 15)) console.log(`    - ${w.id}  «${w.offending.slice(0, 70)}»  ${w.reasoning.slice(0, 80)}`)
  }
}

function score(): void {
  if (!existsSync(RUN_FILE)) throw new Error(`${RUN_FILE} missing — run \`run\` first`)
  const results = readJson<RunResult[]>(RUN_FILE)
  summarize(results)

  if (!existsSync(GOLDSET_FILE)) {
    console.log(`\n  (no ${GOLDSET_FILE} yet — the rates above are the JUDGE's, uncertified.`)
    console.log(`   Label a sample to Paul's standard, then re-run \`score\` for judge↔human κ.)\n`)
    return
  }
  const goldArr = readJson<GoldLabel[]>(GOLDSET_FILE)
  const gold = new Map(goldArr.map(g => [g.id, g]))
  const confirmed = goldArr.filter(g => g.confirmed).length
  console.log(`\nGold set: ${goldArr.length} label(s), ${confirmed} confirmed, ${goldArr.length - confirmed} proposed.`)

  const rows = results.filter(isReal).map(r => ({ r, g: gold.get(r.id) })).filter(
    (x): x is { r: RunResult; g: GoldLabel } => Boolean(x.g)
  )
  if (rows.length === 0) {
    console.log('  no labelled overlap to score.')
    return
  }
  if (rows.some(x => !x.g.confirmed)) console.log('  (PROVISIONAL — includes unconfirmed labels)')

  // Agreement on the binary that matters operationally: is this insight faithful
  // enough to ship, or does it need a human? Multi-class κ is also reported.
  const judgeFaithful = rows.map(x => (x.r.verdict === 'FAITHFUL' ? 'ok' : 'flag'))
  const humanFaithful = rows.map(x => (x.g.label === 'FAITHFUL' ? 'ok' : 'flag'))
  console.log(`  judge↔human κ (flag/ok):  ${cohenKappa(judgeFaithful, humanFaithful).toFixed(2)}`)
  console.log(`  judge↔human κ (verdict):  ${cohenKappa(rows.map(x => x.r.verdict), rows.map(x => x.g.label)).toFixed(2)}`)

  const missedInvention = rows.filter(x => x.g.label === 'ADDED_DETAIL' && x.r.verdict !== 'ADDED_DETAIL')
  if (missedInvention.length) {
    console.log(`\n  ⚠ judge MISSED ${missedInvention.length} invention(s) Paul caught — the judge is not yet trustworthy unattended:`)
    for (const m of missedInvention.slice(0, 10)) console.log(`    - ${m.r.id}  judge said ${m.r.verdict}`)
  }
  console.log()
}

// ── main ────────────────────────────────────────────────────
async function main() {
  const [cmd, flag, flagVal] = process.argv.slice(2)
  const num = flag === '--n' || flag === '--limit' ? Number(flagVal) : undefined
  switch (cmd) {
    case 'verify': await verify(); return
    case 'sample': await sample(num ?? 40); return
    case 'run': await run(num); return
    case 'score': score(); return
    default:
      console.log('usage: npx tsx --env-file=.env.local scripts/evalExtraction.ts <verify|sample [--n N]|run [--limit N]|score>')
      process.exit(1)
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
