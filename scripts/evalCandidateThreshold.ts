/**
 * How much real duplication is the candidate gate throwing away?
 *
 *   npx tsx --env-file=.env.local scripts/evalCandidateThreshold.ts --pairs scratchpad/gated-pairs.json
 *
 * Read-only: adjudicates, counts, prints. Merges nothing.
 *
 * THE QUESTION. Consolidation only asks the adjudicator about pairs whose vector
 * similarity clears CANDIDATE_THRESHOLD (0.80). Everything below is discarded
 * before any judgement happens. On the current corpus that gate does a lot of
 * work: of 120 sampled claims, 4% have a nearest neighbour above 0.80 while 26%
 * sit in 0.75-0.80 — six times as many pairs are silently excluded as considered.
 *
 * So "89% of claims are singletons" cannot be read as "the corpus is diverse".
 * It might equally mean the gate sits above where the duplicates are. The only
 * way to tell those apart is to ask the adjudicator about the excluded band and
 * count how often it says SAME.
 *
 * Lowering the gate would be a separate, deliberate decision — and it would NOT
 * force merges: AUTO_MERGE_CONFIDENCE still governs what actually merges. It
 * only changes what gets asked about.
 *
 * Pairs are found through `match_claims` — the SAME indexed search consolidation
 * uses — so this measures the band that pipeline would actually have seen, not a
 * differently-shaped sample. A direct SQL nearest-neighbour scan was tried first
 * and times out through PostgREST on a 30k-claim corpus.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

const args = process.argv.slice(2)
const num = (f: string, d: number): number => {
  const i = args.indexOf(f)
  return i > -1 ? Number(args[i + 1]) : d
}

async function main() {
  const want = num('--n', 14)
  const lo = num('--lo', 0.75)
  const hi = num('--hi', 0.8)

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { adjudicate } = await import('../lib/consolidation')

  // Random-ish spread: page into the corpus at a random offset rather than
  // taking the first N, which would sample one show and one era.
  const { count } = await db.from('claims').select('*', { count: 'exact', head: true }).eq('status', 'active')
  const total = count ?? 0
  const pairs: { a: string; b: string; sim: number; bId: string }[] = []
  const seen = new Set<string>()

  for (let tries = 0; tries < 120 && pairs.length < want; tries++) {
    const offset = Math.floor(Math.random() * Math.max(1, total - 1))
    const { data: rows } = await db
      .from('claims')
      .select('id, canonical_statement, embedding')
      .eq('status', 'active')
      .not('embedding', 'is', null)
      .range(offset, offset)
    const src = rows?.[0]
    if (!src) continue

    const { data: hits } = await db.rpc('match_claims', {
      query_embedding: src.embedding,
      match_threshold: lo,
      match_count: 3,
    })
    const top = (hits ?? []).find((h: { id: string }) => h.id !== src.id) as
      | { id: string; canonical_statement: string; similarity: number }
      | undefined
    if (!top) continue
    if (top.similarity < lo || top.similarity >= hi) continue // outside the excluded band
    const key = [src.id, top.id].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({
      a: src.canonical_statement,
      b: top.canonical_statement,
      sim: top.similarity,
      bId: top.id,
    })
  }

  if (pairs.length === 0) throw new Error(`no pairs found in ${lo}-${hi}`)
  process.stdout.write(`found ${pairs.length} pair(s) in the excluded ${lo}-${hi} band; asking the adjudicator\n\n`)

  let same = 0
  let distinct = 0
  let unsure = 0
  for (const [i, p] of pairs.entries()) {
    try {
      // adjudicate() compares a NEW statement against a candidate LIST, which is
      // exactly the judgement consolidation makes — pass the pair in that shape
      // rather than inventing a second code path that could disagree with it.
      const v = await adjudicate(p.a, [
        { id: p.bId, canonical_statement: p.b, context_note: null, similarity: p.sim },
      ])
      if (v.verdict === 'SAME') same++
      else if (v.verdict === 'DIFFERENT') distinct++
      else unsure++
      process.stdout.write(
        `${String(i + 1).padStart(3)}  sim ${p.sim.toFixed(3)}  ${v.verdict.padEnd(8)} conf ${v.confidence.toFixed(2)}  ${p.a.slice(0, 58)}\n`
      )
    } catch (err) {
      // A transport failure is a MISSING measurement, not a DISTINCT verdict —
      // counting it either way would bias the answer this script exists to give.
      process.stdout.write(
        `${String(i + 1).padStart(3)}  not judged: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}\n`
      )
    }
  }

  const judged = same + distinct + unsure
  process.stdout.write(`\njudged ${judged} of ${pairs.length} | SAME ${same} | DIFFERENT ${distinct} | UNSURE ${unsure}\n`)
  if (judged > 0) {
    process.stdout.write(
      `${((same / judged) * 100).toFixed(0)}% of this excluded band are duplicates the library currently keeps apart.\n`
    )
  }
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
