/**
 * Postgres-backed job queue (see ARCHITECTURE.md).
 *
 * Jobs are claimed atomically via the `claim_next_job()` RPC
 * (FOR UPDATE SKIP LOCKED). Handlers checkpoint into `jobs.progress` and
 * heartbeat `locked_at`; a job whose heartbeat goes stale (>10 min) is
 * reclaimable, so a killed worker invocation resumes instead of wedging.
 */

import { supabaseAdmin } from './supabaseServer'
import type { Job, JobType } from './types'

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

/**
 * Enqueue a job. With `dedupe` (default true), skips insertion when an
 * identical (type, payload) job is already queued or running, so repeated
 * clicks or pings can't pile up duplicate work.
 */
export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown> = {},
  options: { dedupe?: boolean; runAfter?: Date } = {}
): Promise<{ job: Job | null; deduped: boolean }> {
  const { dedupe = true, runAfter } = options

  if (dedupe) {
    const { data: existing, error } = await db()
      .from('jobs')
      .select('id, type, payload')
      .in('status', ['queued', 'running'])
      .eq('type', type)
      .contains('payload', payload)
    if (error) throw new Error(`Failed to check for duplicate jobs: ${error.message}`)
    const duplicate = ((existing ?? []) as { payload: unknown }[]).find(
      j => JSON.stringify(j.payload) === JSON.stringify(payload)
    )
    if (duplicate) return { job: null, deduped: true }
  }

  const { data, error } = await db()
    .from('jobs')
    .insert({
      type,
      payload,
      ...(runAfter ? { run_after: runAfter.toISOString() } : {}),
    })
    .select('*')
    .single()
  if (error) throw new Error(`Failed to enqueue ${type} job: ${error.message}`)
  return { job: data as Job, deduped: false }
}

/** Claim the next runnable job, or null if the queue is empty. */
export async function claimNextJob(): Promise<Job | null> {
  const { data, error } = await db().rpc('claim_next_job')
  if (error) throw new Error(`Failed to claim job: ${error.message}`)
  const rows = data as Job[] | null
  return rows && rows.length > 0 ? rows[0] : null
}

/** Persist checkpoint + refresh the heartbeat while a handler works. */
export async function heartbeatJob(
  jobId: string,
  progress?: Record<string, unknown>
): Promise<void> {
  const { error } = await db()
    .from('jobs')
    .update({
      locked_at: new Date().toISOString(),
      ...(progress ? { progress } : {}),
    })
    .eq('id', jobId)
  if (error) throw new Error(`Failed to heartbeat job ${jobId}: ${error.message}`)
}

/**
 * Return a job to the queue (same row) so the next claim resumes it from its
 * checkpoint. Used when a handler yields mid-work to stay under its time budget.
 */
export async function requeueJob(jobId: string, progress?: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from('jobs')
    .update({
      status: 'queued',
      locked_at: null,
      run_after: new Date().toISOString(),
      // A budget yield is healthy progress, not a failed attempt — reset the
      // retry counter so only genuine errors count toward max_attempts.
      attempts: 0,
      ...(progress ? { progress } : {}),
    })
    .eq('id', jobId)
  if (error) throw new Error(`Failed to requeue job ${jobId}: ${error.message}`)
}

export async function completeJob(jobId: string, progress?: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from('jobs')
    .update({
      status: 'done',
      finished_at: new Date().toISOString(),
      error: null,
      ...(progress ? { progress } : {}),
    })
    .eq('id', jobId)
  if (error) throw new Error(`Failed to complete job ${jobId}: ${error.message}`)
}

/**
 * Record a failure. Retries with exponential backoff (30s, 60s, 120s …)
 * until attempts reach max_attempts, then the job is failed permanently.
 */
export async function failJob(job: Job, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const willRetry = job.attempts < job.max_attempts
  const backoffMs = Math.pow(2, job.attempts - 1) * 30_000

  const { error } = await db()
    .from('jobs')
    .update(
      willRetry
        ? {
            status: 'queued',
            error: message.substring(0, 2000),
            run_after: new Date(Date.now() + backoffMs).toISOString(),
            locked_at: null,
          }
        : {
            status: 'failed',
            error: message.substring(0, 2000),
            finished_at: new Date().toISOString(),
          }
    )
    .eq('id', job.id)
  if (error) throw new Error(`Failed to record failure for job ${job.id}: ${error.message}`)
}

/**
 * Fire-and-forget ping to the worker so enqueued jobs start within seconds
 * instead of waiting for the next cron tick. Never throws.
 */
export function pingWorker(origin: string): void {
  const secret = process.env.WORKER_SECRET
  fetch(`${origin}/api/worker/tick`, {
    method: 'POST',
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  }).catch(() => {
    // Best effort only — cron picks the job up regardless.
  })
}
