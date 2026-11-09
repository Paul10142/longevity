/**
 * Re-run of the 10-episode study-linking test with the 2026-11-09 fixes (option A).
 *
 * FILE-ONLY: it reads the 153 saved citation mentions from the first run's dump (and, read-only, the
 * episodes' dates), looks every one up with the new resolver, and writes the results to a JSON file.
 * It writes nothing to the database: no reference_mentions, references_ or claim_references.
 * The citations themselves are not re-extracted (the five fixes change only how a citation is looked up),
 * so before and after are measured on the same 153.
 *
 *   npx tsx --env-file=.env.local scripts/linkTest/rerun.ts <dump.json> <out.json> [concurrency]
 *
 * Re-running resumes: citations already in <out.json> are skipped. LLM_BACKEND defaults to claude-code
 * (the subscription CLI); the per-citation dollar figure is the CLI's own list-price estimate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { createReferenceLookup, type EpisodeInfo, type ParsedRef } from '../../lib/referenceLookup'
import { trackCliCost } from '../../lib/llm'

const [dumpFile, outFile, conc] = process.argv.slice(2)
if (!dumpFile || !outFile) { console.error('usage: rerun.ts <dump.json> <out.json> [concurrency]'); process.exit(2) }
const CONCURRENCY = Number(conc ?? 3)
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })

function guard() {
  try { execSync('sh ~/.claude/usage-guard/check.sh', { stdio: 'pipe' }) } catch { console.log('USAGE GUARD: stop'); process.exit(1) }
}

type Dump = { sources: { id: string; title: string; authors: string[] | null }[]; mentions: { id: string; src: string; locator: string; raw: string; parsed: ParsedRef | null }[] }

async function main() {
  const dump: Dump = JSON.parse(readFileSync(dumpFile, 'utf8'))
  const episodes = new Map<string, EpisodeInfo>()
  for (const s of dump.sources) {
    const { data } = await db.from('sources').select('date').eq('id', s.id).maybeSingle() // read-only
    episodes.set(s.id.slice(0, 8), { title: s.title, people: s.authors ?? [], date: (data as { date?: string | null } | null)?.date ?? null })
  }

  const done: Record<string, unknown>[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : []
  const doneIdx = new Set(done.map(r => r.i as number))
  const lookup = createReferenceLookup() // one cache for all 10 episodes, as in a production pass
  const queue = dump.mentions.map((m, i) => ({ m, i })).filter(x => !doneIdx.has(x.i))
  console.log(`${dump.mentions.length} citations, ${doneIdx.size} already done, ${queue.length} to do, concurrency ${CONCURRENCY}`)

  let next = 0
  async function worker() {
    while (next < queue.length) {
      const { m, i } = queue[next++]
      guard()
      const t0 = Date.now()
      const { result, costUsd, calls } = await trackCliCost(() => lookup.resolveMention({ raw: m.raw, parsed: m.parsed ?? {}, episode: episodes.get(m.src)! }))
      const a = result.accepted
      done.push({
        i, src: m.src, raw: m.raw, context: m.parsed?.context ?? null,
        outcome: result.outcome, reason: result.reason, cacheHit: result.cacheHit, key: result.key,
        plan: result.plan, judge: result.judge, confidence: result.confidence,
        accepted: a ? { title: a.title, authors: a.authors.slice(0, 3), year: a.year, journal: a.journal, doi: a.doi, source: a.resolved_source } : null,
        nCandidates: result.candidates.length,
        top: result.candidates.slice(0, 4).map(c => `${c.title} | ${c.authors.slice(0, 2).join(', ')} | ${c.journal} | ${c.year} | ${c.doi} | ${c.resolved_source}`),
        databases: result.databases, costUsd, modelCalls: calls, ms: Date.now() - t0,
      })
      writeFileSync(outFile, JSON.stringify(done, null, 1))
      console.log(`${String(i).padStart(3)} ${result.outcome.padEnd(9)} ${result.reason.padEnd(15)} ${m.raw.slice(0, 55)}${a ? ' => ' + a.title.slice(0, 60) : ''}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const by: Record<string, number> = {}
  for (const r of done) by[r.outcome as string] = (by[r.outcome as string] ?? 0) + 1
  console.log('finished', JSON.stringify(by), 'cost', done.reduce((s, r) => s + (r.costUsd as number), 0).toFixed(2))
}
main().catch(e => { console.error(e); process.exit(1) })
