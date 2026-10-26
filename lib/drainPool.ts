/**
 * Drain the job queue with several workers at once (scripts/extractDeepgram.ts --extract-only --workers N).
 *
 * Each worker is the supervisor's old drain loop: tick (claim and run jobs until the queue is empty or
 * the 15-minute tick budget is spent), count, stop on a halt, a usage limit or an empty queue.
 * `claim_next_job` hands every worker a different job (FOR UPDATE SKIP LOCKED), so the workers need no
 * coordination beyond what is here:
 *
 *   - A halt (the CLI circuit breaker) or a usage limit seen by ONE worker stops all of them after
 *     their current tick; the jobs in hand get the same error on their next call and are deferred
 *     by the worker, so nothing is failed on the way down.
 *   - `feed` refills the queue one source at a time when a worker finds it empty, so a worker that
 *     finishes early starts the next episode instead of waiting for the slowest of a fixed batch.
 *     Without `feed` (one worker, the old behaviour) an empty queue ends the worker.
 *
 * With `workers: 1` and no `feed` this is exactly the loop it replaced. Pure orchestration: the tick,
 * the feed and the clock are injected, so tests/drainPool.test.ts needs no database or model.
 */
import type { PipelineHaltError, UsageLimitError } from './usageLimit'

export type DrainTick = {
  processed: number
  failed: number
  usageLimit?: UsageLimitError
  halt?: PipelineHaltError
}

export type DrainOptions = {
  workers: number
  /** One worker tick: claim and run jobs until the queue is empty or the tick budget is spent. */
  tick: () => Promise<DrainTick>
  /** Called when a worker finds the queue empty: enqueue one more job and return true, or false if there is none. */
  feed?: () => Promise<boolean>
  /** True once the run's deadline has passed. */
  pastDeadline: () => boolean
  /** The circuit breaker, read directly too: a halt swallowed inside a handler never reaches the tick. */
  haltedNow?: () => PipelineHaltError | null
}

export type DrainResult = {
  /** Jobs that succeeded or yielded (failures are not progress). */
  processed: number
  failed: number
  halted: PipelineHaltError | null
  limitHit: UsageLimitError | null
  /** Successful jobs per worker, for the log. */
  perWorker: number[]
}

export async function drainPool(opts: DrainOptions): Promise<DrainResult> {
  const n = Math.max(1, Math.floor(opts.workers) || 1)
  const out: DrainResult = { processed: 0, failed: 0, halted: null, limitHit: null, perWorker: new Array(n).fill(0) }

  const worker = async (w: number) => {
    for (;;) {
      if (out.halted || out.limitHit || opts.pastDeadline()) return
      const tick = await opts.tick()
      const ok = tick.processed - tick.failed
      out.processed += ok
      out.failed += tick.failed
      out.perWorker[w] += ok
      const halted = tick.halt ?? opts.haltedNow?.() ?? null
      if (halted) {
        out.halted = out.halted ?? halted
        return
      }
      if (tick.usageLimit) {
        out.limitHit = out.limitHit ?? tick.usageLimit
        return
      }
      if (opts.pastDeadline()) return
      if (tick.processed === 0) {
        // Queue empty. A worker given a feed asks for one more source and goes round again.
        if (opts.feed && (await opts.feed())) continue
        return
      }
    }
  }

  await Promise.all(Array.from({ length: n }, (_, w) => worker(w)))
  return out
}
