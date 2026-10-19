/**
 * "Is there work this supervisor can still do?" — the end-of-run decision for
 * scripts/extractDeepgram.ts.
 *
 * Why this exists. On 2026-10-12 the run finished all 94 episodes at ~17:30 UTC
 * but kept going until it was stopped by hand at 18:17: the supervisor ended
 * only when EVERY queued/running job was gone, and one job was always left — the
 * parked August `tag_claims` job (run_after = 2027-01-01). The supervisor
 * deliberately never runs tagging (SKIP_TAGGING=1), so that job could never
 * drain; the loop idled in `drained 0` rounds backing off to 15 minutes while
 * holding the writer lock and blocking code windows.
 *
 * A job is real work for THIS run only if all of these hold:
 *   - its type is one this run can produce or run (the follow-ups it has not
 *     been told to skip — see `runnableJobTypes`);
 *   - it has not been quarantined;
 *   - it will actually be due before the run's deadline (a job parked to 2027
 *     is not something to wait for).
 *
 * Pure: no I/O, no clock (the caller passes `deadlineMs`). A job due now or soon is
runnable; only the run's deadline bounds how long it is worth waiting.
 */

export type OpenJob = {
  id: string
  type: string
  status: string
  /** ISO timestamp the job becomes claimable; null/absent = due now. */
  run_after?: string | null
}

import { laneJobTypes, type Lane } from './pipelineLanes'

type SkipFlags = Record<string, string | undefined> // SKIP_TAGGING, SKIP_SYNTHESIS_FANOUT, SKIP_REFERENCES

/**
 * Job types this supervisor can run to completion, given its SKIP_* flags
 * (a flag skips its stage only when it is exactly '1', as in lib/worker.ts).
 *
 *   extract_source ──► consolidate_source ──► tag_claims ──► update_topic
 *        └──────────► extract_references ──► resolve_references
 *
 * Types it never produces (claim_sweep, discover_topics, generate_topic) are
 * never counted: they are deliberate, separately-run work.
 *
 * A lane (`--extract-only` / `--consolidate-only`, lib/pipelineLanes.ts) runs
 * exactly one job type, so only that type is runnable: queued jobs of the other
 * lane's type are not this run's work and must not keep it idling.
 */
export function runnableJobTypes(env: SkipFlags = process.env, lane: Lane = 'all'): Set<string> {
  const only = laneJobTypes(lane)
  if (only) return new Set(only)
  const types = new Set(['extract_source', 'consolidate_source'])
  const tagging = env.SKIP_TAGGING !== '1'
  if (tagging) types.add('tag_claims')
  if (tagging && env.SKIP_SYNTHESIS_FANOUT !== '1') types.add('update_topic')
  if (env.SKIP_REFERENCES !== '1') {
    types.add('extract_references')
    types.add('resolve_references')
  }
  return types
}

export type WorkBreakdown = {
  /** Every queued/running job passed in. */
  open: number
  /** Jobs this run can and should still wait for. */
  runnable: number
  /** Open but not runnable: a type this run skips. */
  skippedType: number
  /** Open, a runnable type, but only due after the run's deadline (parked). */
  futureDated: number
  /** Open, a runnable type, but quarantined. */
  quarantined: number
}

/**
 * Split the open jobs into those this run should wait for and those it should
 * ignore. `runnable === 0` together with nothing left to enqueue means the run
 * is done.
 */
export function classifyOpenJobs(
  jobs: OpenJob[],
  deadlineMs: number,
  opts: { types?: Set<string>; quarantinedIds?: ReadonlySet<string> } = {}
): WorkBreakdown {
  const types = opts.types ?? runnableJobTypes()
  const quarantinedIds = opts.quarantinedIds ?? new Set<string>()
  const out: WorkBreakdown = { open: jobs.length, runnable: 0, skippedType: 0, futureDated: 0, quarantined: 0 }
  for (const j of jobs) {
    if (!types.has(j.type)) out.skippedType++
    else if (quarantinedIds.has(j.id)) out.quarantined++
    else if (isDueAfter(j, deadlineMs)) out.futureDated++
    else out.runnable++
  }
  return out
}

/** True when a queued job will not be claimable until after `deadlineMs`. */
function isDueAfter(job: OpenJob, deadlineMs: number): boolean {
  if (job.status !== 'queued' || !job.run_after) return false
  const t = Date.parse(job.run_after)
  return Number.isFinite(t) && t > deadlineMs
}

/** The supervisor's decision: nothing left to enqueue and nothing runnable open. */
export function runIsFinished(freshEnqueued: number, work: WorkBreakdown): boolean {
  return freshEnqueued === 0 && work.runnable === 0
}

/** One-line description of the open jobs for the round log. */
export function describeWork(work: WorkBreakdown): string {
  const ignored: string[] = []
  if (work.skippedType) ignored.push(`${work.skippedType} of a skipped type`)
  if (work.futureDated) ignored.push(`${work.futureDated} parked past the deadline`)
  if (work.quarantined) ignored.push(`${work.quarantined} quarantined`)
  return `${work.runnable} runnable job(s)` + (ignored.length ? ` (ignoring ${ignored.join(', ')})` : '')
}
