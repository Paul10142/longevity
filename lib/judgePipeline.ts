/**
 * Judge several facts of ONE source at once, without changing a single decision.
 *
 * consolidateSource used to handle one insight at a time: search the library,
 * wait ~25 s for the judge, write, repeat. The wait is the whole cost (a search
 * is ~160 ms), so this overlaps the waits: while fact i is being applied, the
 * judge is already reading facts i+1 … i+W-1.
 *
 * The rule that keeps the decisions identical to the sequential loop:
 *
 *   A judge verdict is valid only for the exact candidate list it was shown.
 *
 * A fact judged early was shown the library as it stood BEFORE the facts ahead
 * of it were written. If one of those wrote something the later fact would now
 * see — a brand-new claim for a near-identical sentence from the same source, or
 * a claim whose canonical was just rewritten by enrich-merge — then the
 * sequential loop would have judged it against a different list. So at apply
 * time (strictly in order, after every earlier write has landed) the search is
 * run again, and the early verdict is used ONLY if the fresh list is
 * byte-for-byte the list the judge saw (ids, order, statement, context note).
 * Otherwise the fact is judged again, on the fresh list, exactly as the
 * sequential loop would have. The two paths then write the same rows.
 *
 * Nothing here talks to the database or the model: search, judge and apply are
 * injected, so tests/judgePipeline.test.ts can race two near-duplicate facts
 * against a fake library and check the result equals the sequential run's.
 *
 * Cross-SOURCE parallelism is deliberately not offered: two sources' writes are
 * not ordered against each other, so neither can see the other's claims (the race
 * documented at consolidation.ts mergeClaims / the sweep). This is one source.
 */

export type CandidateLike = { id: string; canonical_statement: string; context_note: string | null }

/** What the judge actually reads: ids, order, statement, context note. Similarity
 *  is shown to nobody (the prompt omits it), so a drift in it is not a different list. */
export function candidateSignature(cands: readonly CandidateLike[]): string {
  return JSON.stringify(cands.map(c => [c.id, c.canonical_statement, c.context_note ?? null]))
}

export type PipelineStats = {
  /** Facts that went to the judge. */
  judged: number
  /** Early verdicts used as they were (the fresh list matched). */
  reused: number
  /** Early verdicts thrown away and re-judged because an earlier write changed the list. */
  stale: number
  /** Facts that had no candidates at apply time (no judge needed). */
  unjudged: number
}

export type PipelineOptions<T, C extends CandidateLike, V> = {
  /** Facts judged ahead at once. 1 = the original strictly sequential loop. */
  concurrency: number
  /** The library search for one fact. `null` = skip the fact (no vector). Must throw on a failed search. */
  search: (item: T) => Promise<C[] | null>
  /** The judge for one fact against a candidate list. */
  judge: (item: T, candidates: C[]) => Promise<V>
  /** The write for one fact, called strictly in order. `candidates` is the list the verdict was judged on
   *  (null = skipped; empty = nothing to judge; verdict is null then). */
  apply: (item: T, candidates: C[] | null, verdict: V | null) => Promise<void>
  /** True once no new fact should be started (the tick budget). A fact whose judge call is already in
   *  flight is finished and applied. */
  outOfTime?: () => boolean
  /** False once an early judge call could not finish inside the budget; the loop then falls back to
   *  one fact at a time until `outOfTime`. Only consulted with concurrency > 1. */
  canLaunch?: () => boolean
}

/** `sig` is taken when the judge is launched: the candidate objects may be mutated later. */
type Spec<C, V> = { cands: C[] | null; sig: string; verdict: Promise<V> | null }

/**
 * Run the facts in order. Returns how many were applied (a prefix of `items`) and
 * the stats. Throws whatever search/judge/apply throws, at the point the sequential
 * loop would have.
 */
export async function runOrdered<T, C extends CandidateLike, V>(
  items: readonly T[],
  opts: PipelineOptions<T, C, V>
): Promise<{ applied: number; stats: PipelineStats }> {
  const W = Math.max(1, Math.floor(opts.concurrency))
  const stats: PipelineStats = { judged: 0, reused: 0, stale: 0, unjudged: 0 }
  const outOfTime = opts.outOfTime ?? (() => false)
  const specs = new Map<number, Promise<Spec<C, V>>>()

  const launch = (i: number) => {
    if (i >= items.length || specs.has(i)) return
    const p = (async (): Promise<Spec<C, V>> => {
      const cands = await opts.search(items[i])
      if (!cands || cands.length === 0) return { cands, sig: '', verdict: null }
      const sig = candidateSignature(cands)
      const verdict = opts.judge(items[i], cands)
      verdict.catch(() => {}) // a verdict nobody collects must not be an unhandled rejection
      return { cands, sig, verdict }
    })()
    p.catch(() => {})
    specs.set(i, p)
  }

  let applied = 0
  for (let i = 0; i < items.length; i++) {
    const started = specs.has(i)
    if (!started && outOfTime()) break

    // Keep the lookahead full, but never start a call that cannot finish inside the budget.
    if (W > 1 && (opts.canLaunch?.() ?? true)) {
      for (let j = i; j < Math.min(items.length, i + W); j++) launch(j)
    }

    // Fresh search, after every earlier write has landed — the list the sequential loop would use.
    const fresh = await opts.search(items[i])
    if (fresh === null) {
      specs.delete(i)
      await opts.apply(items[i], null, null)
      applied++
      continue
    }
    if (fresh.length === 0) {
      specs.delete(i)
      stats.unjudged++
      await opts.apply(items[i], fresh, null)
      applied++
      continue
    }

    let verdict: V
    const spec = specs.has(i) ? await specs.get(i)!.catch(() => null) : null
    if (spec && spec.cands && spec.verdict && spec.sig === candidateSignature(fresh)) {
      verdict = await spec.verdict
      stats.reused++
    } else {
      if (spec && spec.verdict) stats.stale++
      verdict = await opts.judge(items[i], fresh)
    }
    specs.delete(i)
    stats.judged++
    await opts.apply(items[i], fresh, verdict)
    applied++
  }
  return { applied, stats }
}
