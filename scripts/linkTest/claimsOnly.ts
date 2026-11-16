/**
 * Re-run ONLY the claim-wording step (fix 6) on citations an earlier re-run already resolved.
 * FILE-ONLY: reads <dump.json> (made by dumpNew.ts, with each citation's statements) and <rerun.json> (the lookups),
 * calls the claim-wording judge for every resolved citation, and writes the picks to <out.json>. Nothing goes to the database.
 *
 *   npx tsx --env-file=.env.local scripts/linkTest/claimsOnly.ts <dump.json> <rerun.json> <out.json>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { selectInsightsAboutStudy, type InsightCandidate } from '../../lib/claimLinking'
import { trackCliCost } from '../../lib/llm'
import type { EpisodeInfo, ParsedRef } from '../../lib/referenceLookup'

const [dumpFile, rerunFile, outFile] = process.argv.slice(2)
if (!dumpFile || !rerunFile || !outFile) { console.error('usage: claimsOnly.ts <dump.json> <rerun.json> <out.json>'); process.exit(2) }

type Insight = InsightCandidate & { claimIds: string[] }
type Dump = { sources: { id: string; title: string; authors: string[] | null; date: string | null }[]; mentions: { id: string; src: string; raw: string; parsed: ParsedRef | null; insights?: Insight[] }[] }
type Row = { i: number; outcome: string; accepted: { title: string; authors: string[]; year: number | null; journal: string | null } | null }

function guard() {
  try { execSync('sh ~/.claude/usage-guard/check.sh', { stdio: 'pipe' }) } catch { console.log('USAGE GUARD: stop'); process.exit(1) }
}

async function main() {
  const dump: Dump = JSON.parse(readFileSync(dumpFile, 'utf8'))
  const rows: Row[] = JSON.parse(readFileSync(rerunFile, 'utf8'))
  const done: Record<string, unknown>[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : []
  const have = new Set(done.map(r => r.i as number))
  const episodes = new Map(dump.sources.map(s => [s.id.slice(0, 8), { title: s.title, people: s.authors ?? [], date: s.date } as EpisodeInfo]))
  for (const r of rows.filter(r => r.outcome === 'resolved' && r.accepted && !have.has(r.i))) {
    const m = dump.mentions[r.i]
    guard()
    const insights = m.insights ?? []
    const t0 = Date.now()
    const { result: picked, costUsd } = await trackCliCost(() => selectInsightsAboutStudy({ raw: m.raw, parsed: m.parsed ?? {}, episode: episodes.get(m.src)!, study: r.accepted as never, insights }))
    const chosen = new Set(picked.selectedIds)
    done.push({
      i: r.i, mention: m.id, outcome: picked.outcome, considered: picked.considered, selectedIds: picked.selectedIds,
      oldClaims: new Set(insights.flatMap(x => x.claimIds)).size,
      newClaims: new Set(insights.filter(x => chosen.has(x.id)).flatMap(x => x.claimIds)).size, costUsd, ms: Date.now() - t0,
    })
    writeFileSync(outFile, JSON.stringify(done, null, 1))
    console.log(`${String(r.i).padStart(3)} ${picked.outcome} considered ${picked.considered} selected ${picked.selectedIds.length} ${r.accepted!.title.slice(0, 60)}`)
  }
  console.log('finished', done.length, 'cost', done.reduce((s, r) => s + (r.costUsd as number), 0).toFixed(2))
}
main().catch(e => { console.error(e); process.exit(1) })
