/**
 * 10-episode test of linking claims to cited studies (2026-11-08).
 * Writes ONLY reference tables (reference_mentions, references_, claim_references) for the named sources.
 *   tsx scripts/linkTest/run.ts <idsfile> <tracefile> [extract|resolve|both]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { extractReferences, resolveReferences, type ResolveTrace } from '../../lib/references'

const ids = readFileSync(process.argv[2], 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
const traceFile = process.argv[3]
const stage = process.argv[4] ?? 'both'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } })

function guard() {
  try { execSync('sh ~/.claude/usage-guard/check.sh', { stdio: 'pipe' }) } catch { console.log('USAGE GUARD: stop'); process.exit(1) }
}

async function main() {
  if (stage !== 'resolve') {
    for (const id of ids) {
      guard()
      const { count } = await db.from('reference_mentions').select('*', { count: 'exact', head: true }).eq('source_id', id)
      if (count) { console.log(id.slice(0, 8), 'already has', count, 'mentions, skipping extract'); continue }
      let cp: any = undefined, done = false
      while (!done) {
        const r = await extractReferences(id, cp, async () => {}, 220_000, { trackRun: false })
        done = r.done; cp = r.checkpoint
      }
      console.log(id.slice(0, 8), 'extracted', cp.mentions_created, 'mentions from', cp.total_chunks, 'chunks')
    }
  }
  if (stage !== 'extract') {
    const traces: ResolveTrace[] = []
    let done = false
    while (!done) {
      guard()
      const r = await resolveReferences(async cp => console.log('resolve', JSON.stringify(cp)), 200_000, { sourceIds: ids, trace: t => traces.push(t) })
      done = r.done
      writeFileSync(traceFile, JSON.stringify(traces))
    }
    console.log('resolve finished', traces.length)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
