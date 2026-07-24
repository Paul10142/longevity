/**
 * Paged reads for PostgREST.
 *
 * Supabase enforces a server-side `db-max-rows` cap (1000 on this project). It
 * is applied to EVERY response — including RPCs — and, critically, **it is not
 * lifted by asking for a bigger range**: `.range(0, 49_999)` still comes back
 * with 1000 rows, silently, with no error and no truncation flag. A query that
 * "returns everything" therefore starts lying the moment a table crosses 1000
 * rows, and every caller that diffs two such sets (which rows are missing a
 * membership? which claims have no topic?) starts drawing conclusions from a
 * partial picture.
 *
 * That is not theoretical. On 2026-07-24 it hit consolidation twice: the
 * membership set truncated at 1023 rows, so already-consolidated insights looked
 * pending and were re-adjudicated — and a re-judgement landing on a different
 * claim would have put one insight in two claims. `sweepClaims` had it too.
 *
 * So: any read whose result set can grow with the corpus goes through this.
 */

/** One page of a PostgREST select. Structural, so it matches the supabase-js
 *  builder without importing its generic types. */
type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Read every row of a query by walking `.range()` until a short page arrives.
 *
 * `page(from, to)` must apply the SAME filters and a STABLE `.order()` on every
 * call — without a deterministic order, paging can repeat or skip rows.
 *
 *   const members = await selectAllPaged<{ raw_insight_id: string }>(
 *     (from, to) => db.from('claim_members').select('raw_insight_id')
 *       .order('created_at', { ascending: true }).range(from, to)
 *   )
 *
 * `pageSize` must stay at or below the server cap; a larger value is silently
 * clamped by PostgREST, which would make the short-page test never fire and
 * loop forever. 1000 is the cap on this project.
 */
export async function selectAllPaged<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000
): Promise<T[]> {
  const size = Math.min(Math.max(1, pageSize), 1000)
  const out: T[] = []
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1)
    if (error) throw new Error(`paged select failed at offset ${from}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    // A short page means the end. An exactly-full page is ambiguous, so we go
    // round once more and accept one wasted request over a truncated result.
    if (rows.length < size) return out
  }
}
