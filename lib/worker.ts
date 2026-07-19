/**
 * Worker dispatch: claim jobs and run their handlers within a time budget.
 *
 * Each handler is responsible for checkpointing (via heartbeatJob) so that a
 * job which exceeds the budget or whose invocation is killed resumes cleanly
 * on the next tick. Handlers for later pipeline stages are added as those
 * phases land; unknown/al types fail loudly.
 */

import type { Job } from './types'
import { claimNextJob, heartbeatJob, completeJob, failJob, enqueueJob, requeueJob } from './jobs'
import { extractSource, type ExtractCheckpoint } from './extraction'
import { consolidateSource, sweepClaims, type ConsolidateCheckpoint } from './consolidation'
import { tagClaims, type TagCheckpoint } from './taxonomy'

// Overall budget for one worker invocation (Vercel maxDuration is 300s).
const TICK_BUDGET_MS = 250_000

async function handleExtractSource(job: Job): Promise<void> {
  const sourceId = job.payload.source_id as string
  if (!sourceId) throw new Error('extract_source job missing source_id')

  const progress = job.progress as Partial<ExtractCheckpoint> & { run_id?: string }

  const result = await extractSource(
    sourceId,
    progress,
    async (cp, runId) => {
      await heartbeatJob(job.id, { ...cp, run_id: runId })
    },
    // Leave headroom under the tick budget for finalization.
    220_000
  )

  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint, run_id: result.runId })
    // Hand off to consolidation (Phase 2). Safe no-op until that handler exists.
    await enqueueJob('consolidate_source', { source_id: sourceId })
  } else {
    // Yielded to stay under budget: requeue the same row to resume from checkpoint.
    await requeueJob(job.id, { ...result.checkpoint, run_id: result.runId })
  }
}

async function handleConsolidateSource(job: Job): Promise<void> {
  const sourceId = job.payload.source_id as string
  if (!sourceId) throw new Error('consolidate_source job missing source_id')

  const progress = job.progress as Partial<ConsolidateCheckpoint>

  const result = await consolidateSource(
    sourceId,
    progress,
    async (cp) => {
      await heartbeatJob(job.id, { ...cp })
    },
    220_000
  )

  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint })
    // Hand off to tagging. Deduped so many consolidations coalesce into one.
    await enqueueJob('tag_claims', {})
  } else {
    await requeueJob(job.id, { ...result.checkpoint })
  }
}

async function handleTagClaims(job: Job): Promise<void> {
  const progress = job.progress as Partial<TagCheckpoint>
  const result = await tagClaims(
    progress,
    async (cp) => { await heartbeatJob(job.id, { ...cp }) },
    220_000
  )
  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint })
  } else {
    await requeueJob(job.id, { ...result.checkpoint })
  }
}

async function handleClaimSweep(job: Job): Promise<void> {
  const result = await sweepClaims(
    async (done, total, merged) => { await heartbeatJob(job.id, { processed: done, total, merged }) },
    220_000
  )
  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint })
  } else {
    await requeueJob(job.id, { ...result.checkpoint })
  }
}

async function runHandler(job: Job): Promise<void> {
  switch (job.type) {
    case 'extract_source':
      return handleExtractSource(job)
    case 'consolidate_source':
      return handleConsolidateSource(job)
    case 'tag_claims':
      return handleTagClaims(job)
    case 'claim_sweep':
      return handleClaimSweep(job)
    case 'discover_topics':
    case 'generate_topic':
      // Implemented in later phases. Complete as no-op so the queue drains.
      console.log(`[worker] ${job.type} not yet implemented — skipping`)
      return
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}

export type TickResult = { processed: number; budgetExhausted: boolean }

/** Drain the queue until empty or the time budget is spent. */
export async function runWorkerTick(budgetMs = TICK_BUDGET_MS): Promise<TickResult> {
  const started = Date.now()
  let processed = 0

  while (Date.now() - started < budgetMs) {
    const job = await claimNextJob()
    if (!job) break

    try {
      await runHandler(job)
      // Checkpointed handlers manage their own completion (they may requeue to
      // resume). Only the no-op / instantaneous types are completed here.
      const selfManaged = ['extract_source', 'consolidate_source', 'tag_claims', 'claim_sweep']
      if (!selfManaged.includes(job.type)) {
        await completeJob(job.id)
      }
    } catch (err) {
      console.error(`[worker] job ${job.id} (${job.type}) failed:`, err)
      await failJob(job, err)
    }
    processed++
  }

  return { processed, budgetExhausted: Date.now() - started >= budgetMs }
}
