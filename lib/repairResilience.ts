/**
 * Keeps the long repair run (scripts/repairFlaggedClaims.ts, about 1,000 claims, more than a day) alive
 * through a database blip. No database and no model in here, so tests/repairResilience.test.ts can drive it
 * with fake clocks.
 *
 * Why it exists. On 2026-11-16 the run died after two claims on `annotate flag ...: TimeoutError: The
 * operation was aborted due to timeout` (the 30 second fetch timeout in lib/supabaseServer.ts) while the
 * Mac was on battery: one lost answer from the database ended a 28-hour job. Now:
 *
 *   1. every database call in the script retries a transient failure (timeout, fetch failed, 5xx) with a
 *      growing wait, for up to two minutes (`dbRetry`);
 *   2. a claim whose calls still fail after that is recorded as not finished and the run goes on to the next
 *      claim; only several claims in a row stop the run (`FailureStreak`);
 *   3. an insert that may have landed before its answer was lost is checked for before it is repeated
 *      (`insertIdempotent`), because `claim_repairs` has no unique key for the "left hidden" outcomes and a
 *      blind repeat would write the audit row twice.
 */

import { isTransientNetworkError, withNetworkRetry, type RetryOpts } from './networkRetry'
import { PipelineHaltError, UsageLimitError } from './usageLimit'

/** How long one database call keeps trying before the claim is given up for this run (REPAIR_DB_RETRY_MS in the environment overrides it, in milliseconds). */
export const REPAIR_DB_RETRY_MS = 120_000
export function repairRetryBudgetMs(): number {
  const raw = process.env.REPAIR_DB_RETRY_MS
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : REPAIR_DB_RETRY_MS
}

/** Several claims in a row that could not be finished: the database or the network is down, so stop. */
export const MAX_CONSECUTIVE_CLAIM_FAILURES = 3

/** A network drop, a timeout, or a gateway / server 5xx answer. A real database error (constraint, missing column) is not. */
export function isTransientRepairError(message: string | undefined | null): boolean {
  if (!message) return false
  if (isTransientNetworkError(message)) return true
  return /\b5(?:00|2\d)\b|internal server error|upstream|temporarily unavailable/i.test(message)
}

type Answer = { error: { message: string } | null }

/** Run a supabase-style call and repeat it while the error is transient (see lib/networkRetry.ts). The last answer is returned either way. */
export function dbRetry<T extends Answer = any>(label: string, fn: () => PromiseLike<T>, opts: RetryOpts = {}): Promise<T> {
  return withNetworkRetry(label, fn, { maxWaitMs: repairRetryBudgetMs(), isTransient: isTransientRepairError, ...opts })
}

/**
 * An insert that is safe to repeat. After a transient failure the first attempt may still have landed (only
 * its answer was lost), so before every repeat `alreadyThere` looks for the row; found means success, and a
 * failed look means "unknown", which is retried WITHOUT inserting rather than risking a second row.
 */
export function insertIdempotent(
  label: string,
  insert: () => PromiseLike<Answer>,
  alreadyThere: () => PromiseLike<{ found: boolean; error: { message: string } | null }>,
  opts: RetryOpts = {}
): Promise<Answer> {
  let attempted = false
  return dbRetry<Answer>(label, async () => {
    if (attempted) {
      const look = await alreadyThere()
      if (look.error) return { error: look.error }
      if (look.found) return { error: null }
    }
    attempted = true
    return insert()
  }, opts)
}

/** What the run does after an error on one claim. Out of model quota or a halted CLI is the run's problem; anything else is the claim's. */
export function classifyClaimError(err: unknown): 'halt' | 'skip' {
  return err instanceof UsageLimitError || err instanceof PipelineHaltError ? 'halt' : 'skip'
}

/** Counts claims that could not be finished, in a row. A finished claim resets it. */
export class FailureStreak {
  private n = 0
  constructor(private readonly limit = MAX_CONSECUTIVE_CLAIM_FAILURES) {}
  success(): void { this.n = 0 }
  /** 'stop' once `limit` claims in a row have failed. */
  failure(): 'continue' | 'stop' { this.n++; return this.n >= this.limit ? 'stop' : 'continue' }
  get count(): number { return this.n }
}
