/**
 * Validate the extraction faithfulness fix (2026-07-25, Paul's "fix the
 * instructions" decision).
 *
 * The old prompt produced 6 ADDED_DETAIL (invented) insights on a 40-sample.
 * This re-runs the NEW extraction prompt on those exact 6 source chunks and
 * judges every insight it produces — the fix works if the invention rate on the
 * cases that previously failed drops toward 0.
 *
 * DB-free: chunk text comes from the saved eval pairs. Uses the local CLI, so do
 * not run alongside a pipeline drain.
 */

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { readFileSync } from 'node:fs'
import { extractFromChunk } from '../lib/extraction'
import { judgeFidelity, isViolation } from '../lib/extractionFidelity'

type Bad = { id: string; statement: string; chunk: string }

/** Derive the previously-invented chunks from the eval artifacts, so this is
 *  self-contained and re-runnable: extraction-run.json (committed) marks which
 *  insights the judge called ADDED_DETAIL; extraction-eval-pairs.json holds the
 *  chunk text they came from. */
function loadBadChunks(): Bad[] {
  const run = JSON.parse(readFileSync('eval/extraction-run.json', 'utf8')) as { id: string; verdict: string }[]
  const pairs = JSON.parse(readFileSync('eval/extraction-eval-pairs.json', 'utf8')) as { id: string; statement: string; chunk_text: string }[]
  const byId = new Map(pairs.map(p => [p.id, p]))
  return run.filter(r => r.verdict === 'ADDED_DETAIL')
    .map(r => byId.get(r.id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map(p => ({ id: p.id, statement: p.statement, chunk: p.chunk_text }))
}

async function main() {
  const bad = loadBadChunks()
  if (bad.length === 0) throw new Error('no ADDED_DETAIL cases in eval/extraction-run.json — run `eval:extraction run` first')

  let totalInsights = 0, violations = 0
  for (let i = 0; i < bad.length; i++) {
    const b = bad[i]
    console.log(`\n[${i + 1}/${bad.length}] chunk that previously invented: «${b.statement.slice(0, 80)}…»`)
    const insights = await extractFromChunk(b.chunk, `test-${i + 1}`)
    for (const ins of insights) {
      totalInsights++
      const v = await judgeFidelity(ins.statement, b.chunk, { directQuote: ins.direct_quote })
      const bad_ = isViolation(v.verdict)
      if (bad_) violations++
      console.log(`   ${bad_ ? '✗ ' + v.verdict : '✓ faithful'}  «${ins.statement.slice(0, 78)}»`)
      if (bad_) console.log(`        ↳ ${v.offending.slice(0, 70)} — ${v.reasoning.slice(0, 80)}`)
    }
  }
  console.log(`\n──────────────`)
  console.log(`NEW prompt over ${bad.length} previously-invented chunks:`)
  console.log(`  ${totalInsights} insight(s) produced, ${violations} still over-reach (${totalInsights ? Math.round(violations / totalInsights * 100) : 0}%).`)
  console.log(violations === 0
    ? `  ✓ Every insight on the hardest cases is now faithful.`
    : `  The remaining ${violations} need another look before declaring the fix done.`)
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
