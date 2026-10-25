/**
 * Pipeline lanes — run extraction and consolidation as two separate runs.
 *
 *   npx tsx --env-file=.env.local scripts/extractDeepgram.ts --extract-only
 *   npx tsx --env-file=.env.local scripts/extractDeepgram.ts --consolidate-only
 *
 * Why. Extraction (≈10 min and ≈60 Haiku calls per episode) banks the facts;
 * consolidation (≈16 min and ≈130 Opus calls per episode, measured 2026-10-12 to
 * 10-17) dedups them against the claims table. Paul's bottleneck is the Claude
 * usage window, so he wants to bank extractions first and match duplicates later.
 *
 * Three modes of the one supervisor script (so ~/.claude/usage-guard, whose
 * pattern matches `scripts/extractDeepgram`, covers every mode without changes):
 *
 *   all          (default)  today's behaviour: extract and consolidate together
 *   extract      only extract_source jobs; consolidate_source stays queued
 *   consolidate  only consolidate_source jobs, strictly one source at a time
 *
 * Pure helpers only: no I/O, so they are unit-tested without a database.
 */

export type Lane = 'all' | 'extract' | 'consolidate'

/** The job type a lane claims; `all` claims anything (the old behaviour). */
const LANE_JOB_TYPE = { extract: 'extract_source', consolidate: 'consolidate_source' } as const

/**
 * Read the lane from the command line. Throws on both flags together, and on
 * an unrecognised `--*-only` spelling, rather than silently running everything.
 */
export function parseLane(args: readonly string[]): Lane {
  const extract = args.includes('--extract-only')
  const consolidate = args.includes('--consolidate-only')
  if (extract && consolidate) {
    throw new Error('--extract-only and --consolidate-only are two separate runs; start one of each, not both in one')
  }
  const stray = args.filter(a => /^--.*only$/.test(a) && a !== '--extract-only' && a !== '--consolidate-only')
  if (stray.length) throw new Error(`unknown lane flag ${stray[0]} (use --extract-only or --consolidate-only)`)
  return extract ? 'extract' : consolidate ? 'consolidate' : 'all'
}

/**
 * Job types this lane may claim and wait for. `null` = no restriction (`all`).
 * A lane claims ONLY its own type: that is what keeps the extract lane from
 * picking up a consolidate job (which migration 022 would otherwise hand it
 * first) and the consolidate lane from running an extraction.
 */
export function laneJobTypes(lane: Lane): string[] | null {
  return lane === 'all' ? null : [LANE_JOB_TYPE[lane]]
}

/** Whether this lane starts new extractions (enqueues extract_source for pending sources). */
export function laneEnqueuesExtractions(lane: Lane): boolean {
  return lane !== 'consolidate'
}

/** Failed-job healing is limited to the lane's own types, so a lane never requeues the other lane's work. */
export function laneHealTypes(lane: Lane): string[] {
  return lane === 'all' ? ['extract_source', 'consolidate_source'] : [LANE_JOB_TYPE[lane]]
}

/** Lock-file name part, and the label in logs. */
export function laneLabel(lane: Lane): string {
  return lane === 'all' ? 'extractDeepgram' : `extractDeepgram:${lane}-only`
}

/**
 * The consolidate lane must not give up while an extract lane is still running:
 * every finished extraction queues a new consolidate job, so an empty queue is
 * only "done" when no extraction can add to it.
 */
export function consolidateShouldWait(lane: Lane, extractLaneLive: boolean, runnable: number): boolean {
  return lane === 'consolidate' && extractLaneLive && runnable === 0
}

/** The most workers one process may run; beyond this the database's ~7-connection API pool is the limit. */
export const MAX_WORKERS = 6
/** Above this the extraction log warns: the 2026-10-20 database timeout happened with one job at a time. */
export const WORKERS_WARN_ABOVE = 3

/**
 * `--workers N` (default 1): how many extract_source jobs one run works on at once. Only the
 * extract-only lane supports it; consolidation of different episodes in parallel is not built
 * (two consolidations would race on the same claims) and the plain run stays sequential.
 */
export function parseWorkers(args: readonly string[], lane: Lane): number {
  const i = args.indexOf('--workers')
  if (i === -1) return 1
  const raw = args[i + 1]
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n < 1 || n > MAX_WORKERS) {
    throw new Error(`--workers needs a whole number from 1 to ${MAX_WORKERS} (got ${raw ?? 'nothing'})`)
  }
  if (n > 1 && lane !== 'extract') {
    throw new Error('--workers only works with --extract-only; consolidation and the plain run stay one job at a time')
  }
  return n
}

/** Extractions to queue at the start of a round: at least one per worker so none starts idle. */
export function freshBatchSize(batch: number, workers: number): number {
  return Math.max(batch, workers)
}
