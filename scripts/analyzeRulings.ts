/**
 * Analyze Paul's dedup rulings (2026-07-25) — the step right after the review
 * worksheet.
 *
 *   npx tsx --env-file=.env.local scripts/analyzeRulings.ts <rulings.json> [--write]
 *
 * Takes the JSON exported from the review worksheet
 * (https://claude.ai/code/artifact/65be336b-…) and answers the one open
 * question: does the live engine's 64% enrich rate match Paul's judgement, or is
 * it over-flagging? Pure comparison — NO AI, so it runs while the backends are
 * down.
 *
 * The worksheet exports, per pair:
 *   { id, ruling: "merge" | "enrich" | "keep", note, prior_v3, v3_enrich }
 *
 * With `--write`, it folds the rulings into eval/dedup-goldset.json as confirmed
 * labels (paul_verdict + desired_operation, confirmed:true), so the 57 provisional
 * labels become settled ground truth and never need re-ruling.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

type Ruling = { id: string; ruling: 'merge' | 'enrich' | 'keep'; note?: string; prior_v3?: string; v3_enrich?: boolean }
type V3 = { id: string; verdict: string; enrich?: boolean; confidence?: number }
type Gold = {
  id: string; label: string; confirmed: boolean; labeled_by: string; rationale?: string
  paul_verdict?: string; desired_operation?: string
}

const GOLD = 'eval/dedup-goldset.json'
const V3RUN = 'eval/dedup-run-v3.json'

function pct(n: number, d: number): string { return d ? `${Math.round((n / d) * 100)}%` : '—' }

function main() {
  const rulingsPath = process.argv[2]
  const write = process.argv.includes('--write')
  if (!rulingsPath) throw new Error('usage: analyzeRulings.ts <exported-rulings.json> [--write]')
  if (!existsSync(rulingsPath)) throw new Error(`no file at ${rulingsPath} — export from the worksheet first`)

  const rulings = JSON.parse(readFileSync(rulingsPath, 'utf8')) as Ruling[]
  const v3 = new Map((JSON.parse(readFileSync(V3RUN, 'utf8')) as V3[]).map(r => [r.id, r]))

  const n = rulings.length
  const merge = rulings.filter(r => r.ruling === 'merge').length
  const enrich = rulings.filter(r => r.ruling === 'enrich').length
  const keep = rulings.filter(r => r.ruling === 'keep').length

  console.log(`\nPAUL'S RULINGS — ${n} pair(s)\n`)
  console.log(`  merge (same, no detail buried):  ${merge}  (${pct(merge, n)})`)
  console.log(`  enrich (merge + keep the detail): ${enrich}  (${pct(enrich, n)})`)
  console.log(`  keep separate (truly different):  ${keep}  (${pct(keep, n)})`)

  // ── the false-merge check ────────────────────────────────
  // v3 merged every pair (it is the live auto-merger). A "keep separate" ruling
  // is therefore a pair the engine merged that Paul says it should NOT have — a
  // real false merge, the one thing the all-SAME gold set could never surface.
  if (keep > 0) {
    console.log(`\n  ⚠ ${keep} FALSE MERGE(S): the engine auto-merged these, Paul says keep separate:`)
    for (const r of rulings.filter(r => r.ruling === 'keep')) {
      console.log(`     - ${r.id}${r.note ? `  «${r.note}»` : ''}`)
    }
    console.log(`     → these are the pairs to fix the adjudicator on; false-merge rate ${pct(keep, n)}.`)
  } else {
    console.log(`\n  ✓ 0 false merges — Paul agrees every auto-merge should have merged.`)
  }

  // ── the 64%-vs-33% question ──────────────────────────────
  // Among the pairs Paul agrees should merge (merge + enrich), what fraction did
  // HE say need enriching, vs what the engine flagged?
  const paulMerged = rulings.filter(r => r.ruling === 'merge' || r.ruling === 'enrich')
  const paulEnrichRate = paulMerged.length ? enrich / paulMerged.length : 0
  const v3EnrichOnMerged = paulMerged.filter(r => v3.get(r.id)?.enrich).length
  const v3EnrichRate = paulMerged.length ? v3EnrichOnMerged / paulMerged.length : 0

  console.log(`\nTHE ENRICH QUESTION — over the ${paulMerged.length} pair(s) both agree to merge:`)
  console.log(`  Paul says enrich:   ${enrich}  (${pct(enrich, paulMerged.length)})`)
  console.log(`  Engine flags enrich:${v3EnrichOnMerged}  (${pct(v3EnrichOnMerged, paulMerged.length)})`)

  // Where they disagree, in each direction.
  const overFlag = paulMerged.filter(r => v3.get(r.id)?.enrich && r.ruling === 'merge')   // engine enrich, Paul plain
  const underFlag = paulMerged.filter(r => !v3.get(r.id)?.enrich && r.ruling === 'enrich') // Paul enrich, engine missed
  const agree = paulMerged.filter(r => Boolean(v3.get(r.id)?.enrich) === (r.ruling === 'enrich'))
  console.log(`  agree:              ${agree.length}/${paulMerged.length}  (${pct(agree.length, paulMerged.length)})`)
  console.log(`  engine OVER-flags:  ${overFlag.length}  (engine wanted to rewrite, Paul saw no buried detail)`)
  console.log(`  engine UNDER-flags: ${underFlag.length}  (Paul saw buried detail, engine missed it)`)

  console.log(`\nRECOMMENDATION`)
  if (paulEnrichRate >= 0.55) {
    console.log(`  Paul's own enrich rate here is ${pct(enrich, paulMerged.length)} — close to the engine's ~64%.`)
    console.log(`  The earlier 33% looks conservative; the engine's rate is defensible. Enabling`)
    console.log(`  ENRICH_MERGE=1 is reasonable — but review the ${overFlag.length} over-flag(s) first.`)
  } else if (paulEnrichRate <= 0.40) {
    console.log(`  Paul's enrich rate here is ${pct(enrich, paulMerged.length)} — near the original 33%, well below`)
    console.log(`  the engine's ~64%. The engine OVER-flags: it would rewrite canonicals Paul would`)
    console.log(`  leave alone. Do NOT enable ENRICH_MERGE=1 until the enrich prompt is tightened;`)
    console.log(`  the ${overFlag.length} over-flag case(s) are the training signal for that.`)
  } else {
    console.log(`  Paul's enrich rate here is ${pct(enrich, paulMerged.length)} — between the 33% and 64% poles.`)
    console.log(`  Judgement call: lean on the ${overFlag.length} over-flag vs ${underFlag.length} under-flag cases below to decide.`)
  }

  if (overFlag.length) {
    console.log(`\n  Over-flags to eyeball (engine wanted enrich, Paul said plain merge):`)
    for (const r of overFlag.slice(0, 10)) console.log(`     - ${r.id}${r.note ? `  «${r.note}»` : ''}`)
  }

  // ── optional write-back ──────────────────────────────────
  if (write) {
    const gold = JSON.parse(readFileSync(GOLD, 'utf8')) as Gold[]
    const byId = new Map(gold.map(g => [g.id, g]))
    let updated = 0
    for (const r of rulings) {
      const g = byId.get(r.id)
      if (!g) continue
      g.confirmed = true
      g.labeled_by = 'paul'
      g.label = r.ruling === 'keep' ? 'DIFFERENT' : 'SAME'
      g.paul_verdict = r.ruling === 'keep' ? 'KEEP_SEPARATE' : r.ruling === 'enrich' ? 'ENRICH' : 'MERGE'
      g.desired_operation = r.ruling
      if (r.note) g.rationale = r.note
      updated++
    }
    writeFileSync(GOLD, JSON.stringify(gold, null, 2) + '\n')
    const confirmed = gold.filter(g => g.confirmed).length
    console.log(`\n  ✓ Wrote ${updated} ruling(s) into ${GOLD} — now ${confirmed}/${gold.length} confirmed.`)
  } else {
    console.log(`\n  (Re-run with --write to lock these rulings into ${GOLD} as confirmed ground truth.)`)
  }
  console.log()
}

main()
