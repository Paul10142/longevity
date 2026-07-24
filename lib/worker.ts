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
import { tagClaims, discoverTopics, type TagCheckpoint, type DiscoverCheckpoint } from './taxonomy'
import { generateTopicContent, updateTopicContent } from './synthesis'
import { extractReferences, resolveReferences, type ExtractRefCheckpoint } from './references'
import { supabaseAdmin } from './supabaseServer'

// Overall budget for one worker invocation (Vercel maxDuration is 300s).
const TICK_BUDGET_MS = 250_000

// Spend guard: the expensive LLM-synthesis job types. A tick processes at most
// MAX_SYNTHESIS_JOBS_PER_TICK of these before releasing the rest to the next
// tick, so a runaway / library-wide queue can't drain unboundedly in one
// invocation (the 51-stray-generate_topic scenario). Raise the env to build
// deliberately at scale; the local drain (`pipeline work`) adds a total cap on top.
const SYNTHESIS_JOB_TYPES = new Set(['generate_topic', 'update_topic'])
const MAX_SYNTHESIS_JOBS_PER_TICK = Number(process.env.MAX_SYNTHESIS_JOBS_PER_TICK ?? 30)

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
    // Fan out: consolidate the claims, and (in parallel) extract references.
    await enqueueJob('consolidate_source', { source_id: sourceId })
    await enqueueJob('extract_references', { source_id: sourceId })
  } else {
    // Yielded to stay under budget: requeue the same row to resume from checkpoint.
    await requeueJob(job.id, { ...result.checkpoint, run_id: result.runId })
  }
}

async function handleExtractReferences(job: Job): Promise<void> {
  const sourceId = job.payload.source_id as string
  if (!sourceId) throw new Error('extract_references job missing source_id')
  const progress = job.progress as Partial<ExtractRefCheckpoint>
  const result = await extractReferences(
    sourceId,
    progress,
    async (cp) => { await heartbeatJob(job.id, { ...cp }) },
    220_000
  )
  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint })
    // Resolve the newly-captured mentions (deduped/throttled).
    await enqueueJob('resolve_references', {})
  } else {
    await requeueJob(job.id, { ...result.checkpoint })
  }
}

async function handleResolveReferences(job: Job): Promise<void> {
  const result = await resolveReferences(
    async (cp) => { await heartbeatJob(job.id, { ...cp }) },
    220_000
  )
  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint })
  } else {
    await requeueJob(job.id, { ...result.checkpoint })
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

/**
 * After tagging, fold the newly-filed claims into the articles they actually
 * touched — the incremental path (ARCHITECTURE.md "v3.2"). `stale_topics()`
 * returns only topics that ALREADY have an article and have since gained
 * claims, so an ingest can never silently kick off a full library build; that
 * stays a deliberate, budgeted `generate_topic` run.
 */
async function enqueueStaleTopicUpdates(): Promise<void> {
  if (!supabaseAdmin) return
  // Reprocessing guard: during a corpus re-consolidation we want to consolidate +
  // tag WITHOUT regenerating articles under the current (pre-v4) synthesis — that
  // output is thrown away by the Phase 3 rewrite. Set SKIP_SYNTHESIS_FANOUT=1 to
  // re-consolidate the seed sources cleanly; unset for normal incremental ingest.
  if (process.env.SKIP_SYNTHESIS_FANOUT === '1') {
    console.log('[worker] synthesis fan-out skipped (SKIP_SYNTHESIS_FANOUT=1) — claims tagged, no article regen')
    return
  }
  const { data, error } = await supabaseAdmin.rpc('stale_topics')
  if (error) {
    console.error('[worker] stale_topics failed:', error.message)
    return
  }
  const rows = (data ?? []) as { topic_id: string; new_claims: number }[]
  for (const r of rows) {
    // Deduped by (type, payload), so repeated tagging passes coalesce.
    await enqueueJob('update_topic', { topic_id: r.topic_id })
  }
  if (rows.length) {
    console.log(`[worker] queued ${rows.length} incremental topic update(s)`)
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
    await enqueueStaleTopicUpdates()
  } else {
    await requeueJob(job.id, { ...result.checkpoint })
  }
}

async function handleDiscoverTopics(job: Job): Promise<void> {
  const progress = job.progress as Partial<DiscoverCheckpoint>
  const result = await discoverTopics(
    progress,
    async (cp) => { await heartbeatJob(job.id, { ...cp }) },
    220_000
  )
  if (result.done) {
    await completeJob(job.id, { ...result.checkpoint })
    // New topics only matter once claims are re-filed against them.
    if (result.checkpoint.claims_reflagged > 0) await enqueueJob('tag_claims', {})
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
    case 'generate_topic': {
      const topicId = job.payload.topic_id as string
      if (!topicId) throw new Error('generate_topic job missing topic_id')
      await generateTopicContent(topicId)
      return
    }
    case 'update_topic': {
      const topicId = job.payload.topic_id as string
      if (!topicId) throw new Error('update_topic job missing topic_id')
      await updateTopicContent(topicId)
      return
    }
    case 'extract_references':
      return handleExtractReferences(job)
    case 'resolve_references':
      return handleResolveReferences(job)
    case 'discover_topics':
      return handleDiscoverTopics(job)
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}

export type TickResult = { processed: number; budgetExhausted: boolean; synthesisProcessed: number }

/** Drain the queue until empty or the time budget is spent. */
export async function runWorkerTick(budgetMs = TICK_BUDGET_MS): Promise<TickResult> {
  const started = Date.now()
  let processed = 0
  let synthesisProcessed = 0

  while (Date.now() - started < budgetMs) {
    const job = await claimNextJob()
    if (!job) break

    // Spend guard: once this tick has run its budget of expensive synthesis jobs,
    // release the next one back to the queue and stop — it runs on a later tick.
    if (SYNTHESIS_JOB_TYPES.has(job.type)) {
      if (synthesisProcessed >= MAX_SYNTHESIS_JOBS_PER_TICK) {
        await requeueJob(job.id, (job.progress as Record<string, unknown>) ?? {})
        break
      }
      synthesisProcessed++
    }

    try {
      await runHandler(job)
      // Checkpointed handlers manage their own completion (they may requeue to
      // resume). Only the no-op / instantaneous types are completed here.
      const selfManaged = ['extract_source', 'consolidate_source', 'tag_claims', 'claim_sweep', 'extract_references', 'resolve_references', 'discover_topics']
      if (!selfManaged.includes(job.type)) {
        await completeJob(job.id)
      }
    } catch (err) {
      console.error(`[worker] job ${job.id} (${job.type}) failed:`, err)
      await failJob(job, err)
    }
    processed++
  }

  return { processed, budgetExhausted: Date.now() - started >= budgetMs, synthesisProcessed }
}
