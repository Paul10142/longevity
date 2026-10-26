/**
 * Ride out a brief network drop on idempotent database calls.
 *
 * Why it exists. On 2026-10-26 the Mac's network changed for a few minutes. The job heartbeat inside
 * extractSource failed with `TypeError: fetch failed`, the handler threw, failJob then failed the same
 * way, and both live extraction jobs and the whole round died, losing about 30 minutes of a trial. The
 * same shape hit the run on 2026-10-20. A drop that short should cost a pause, not a job.
 *
 * Only calls that are safe to repeat use this: job-state updates (set to a fixed value), pipeline-run
 * bookkeeping, and the chunk insert (it deletes the chunk's rows before inserting). `claim_next_job` is
 * deliberately NOT wrapped: if its answer were lost the job would sit claimed until the 10-minute
 * reclaim, and a repeat would claim a second one.
 *
 * supabase-js does not throw on a failed fetch, it returns `{ error: { message: 'TypeError: fetch
 * failed' } }`, so the helper reads the result. Pure and dependency-free so
 * tests/networkRetry.test.ts can drive it with a fake clock.
 */

/** True for the errors a network drop or a gateway hiccup produces; false for real database errors. */
export function isTransientNetworkError(message: string | undefined | null): boolean {
  if (!message) return false
  return /fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR|aborted|timed? ?out|timeout|bad gateway|service unavailable|gateway time-?out|\b50[234]\b/i.test(message)
}

export type RetryOpts = {
  /** Total time to keep trying before handing back the last error (default NET_RETRY_MAX_MS, 4 min). */
  maxWaitMs?: number
  /** First wait; doubles each time up to `capMs` (defaults 2 s and 30 s). */
  baseMs?: number
  capMs?: number
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onRetry?: (attempt: number, waitMs: number, message: string) => void
}

const DEFAULT_MAX_WAIT_MS = 4 * 60_000

export function networkRetryBudgetMs(): number {
  const n = Number(process.env.NET_RETRY_MAX_MS)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_WAIT_MS
}

/**
 * Run `fn` (returning a supabase-style `{ error }`) and repeat it while the error is a transient network
 * one, waiting longer each time, until it succeeds, hits a different error, or `maxWaitMs` has passed.
 * The last result is returned either way, so the caller's own error handling is unchanged. The budget
 * stays under claim_next_job's 10-minute stale-lock window, so a job is not taken over meanwhile.
 */
export async function withNetworkRetry<T extends { error: { message: string } | null }>(
  label: string,
  fn: () => PromiseLike<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const maxWait = opts.maxWaitMs ?? networkRetryBudgetMs()
  const base = opts.baseMs ?? 2_000
  const cap = opts.capMs ?? 30_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const begun = now()
  let wait = base
  for (let attempt = 1; ; attempt++) {
    let res: T
    try {
      res = await fn()
    } catch (e) {
      // A thrown network error (not a supabase result) is treated the same way.
      const message = e instanceof Error ? e.message : String(e)
      if (!isTransientNetworkError(message)) throw e
      res = { error: { message } } as T
      if (now() - begun + wait > maxWait) throw e
    }
    if (!res.error || !isTransientNetworkError(res.error.message)) return res
    if (now() - begun + wait > maxWait) return res
    const msg = res.error.message
    if (opts.onRetry) opts.onRetry(attempt, wait, msg)
    else console.warn(`[net] ${label}: ${msg.substring(0, 120)}; retry ${attempt} in ${Math.round(wait / 1000)}s`)
    await sleep(wait)
    wait = Math.min(cap, wait * 2)
  }
}
