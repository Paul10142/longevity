/**
 * Postgres-backed job queue (see ARCHITECTURE.md).
 *
 * Jobs are claimed atomically via the `claim_next_job()` RPC
 * (FOR UPDATE SKIP LOCKED). Handlers checkpoint into `jobs.progress` and
 * heartbeat `locked_at`; a job whose heartbeat goes stale (>10 min) is
 * reclaimable, so a killed worker invocation resumes instead of wedging.
 */

import { supabaseAdmin } from './supabaseServer'
import { withNetworkRetry } from './networkRetry'
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

/**
 * Claim the next runnable job, or null if the queue is empty.
 *
 * `types` limits the claim to those job types (the extract / consolidate lanes,
 * lib/pipelineLanes.ts; needs migration 032). Without it the call is the
 * zero-argument one, identical to before the lanes existed.
 */
export async function claimNextJob(types?: readonly string[]): Promise<Job | null> {
  const { data, error } = types
    ? await db().rpc('claim_next_job', { p_types: [...types] })
    : await db().rpc('claim_next_job')
  if (error) {
    if (types && /claim_next_job|PGRST202|schema cache/i.test(error.message)) {
      throw new Error(
        `Failed to claim job: ${error.message}. The lane modes need migration 032 ` +
          `(supabase/migrations_v2/032_claim_next_job_by_type.sql) applied in the Supabase SQL Editor first.`
      )
    }
    throw new Error(`Failed to claim job: ${error.message}`)
  }
  const rows = data as Job[] | null
  return rows && rows.length > 0 ? rows[0] : null
}

/** Persist checkpoint + refresh the heartbeat while a handler works. */
export async function heartbeatJob(
  jobId: string,
  progress?: Record<string, unknown>
): Promise<void> {
  const { error } = await withNetworkRetry('heartbeat job', () =>
    db()
      .from('jobs')
      .update({
        locked_at: new Date().toISOString(),
        ...(progress ? { progress } : {}),
      })
      .eq('id', jobId)
  )
  if (error) throw new Error(`Failed to heartbeat job ${jobId}: ${error.message}`)
}

/**
 * Refresh only the lock time of a RUNNING job (never its checkpoint). claim_next_job() re-claims a
 * running job whose locked_at is more than 10 minutes old, and a handler heartbeats its checkpoint
 * only between batches; with several workers in one process a long batch would otherwise let a
 * second worker take over a live job. Conditional on status so a job that has since been requeued,
 * deferred or completed is left alone.
 */
export async function touchJob(jobId: string): Promise<void> {
  // No withNetworkRetry here: startJobHeartbeat already tries again every interval, and a retrying
  // touch would stack up behind the timer during a drop.
  const { error } = await db()
    .from('jobs')
    .update({ locked_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'running')
  if (error) throw new Error(`Failed to touch job ${jobId}: ${error.message}`)
}

/**
 * Keep a running job's lock fresh while its handler works, every `intervalMs` (default 60 s,
 * JOB_HEARTBEAT_MS), for at most `maxMs` (default 60 min, JOB_HEARTBEAT_MAX_MS). The cap is the
 * safety valve: a handler that is truly hung stops being refreshed and the job becomes reclaimable,
 * as it always was. A failed refresh is logged and skipped (the next one tries again). Returns the stop function.
 */
export function startJobHeartbeat(
  jobId: string,
  intervalMs = Number(process.env.JOB_HEARTBEAT_MS) || 60_000,
  maxMs = Number(process.env.JOB_HEARTBEAT_MAX_MS) || 60 * 60_000
): () => void {
  const begun = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - begun > maxMs) {
      clearInterval(timer)
      return
    }
    touchJob(jobId).catch(e => console.warn(`[jobs] heartbeat skipped for ${jobId}: ${e instanceof Error ? e.message : e}`))
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Return a job to the queue (same row) so the next claim resumes it from its
 * checkpoint. Used when a handler yields mid-work to stay under its time budget.
 */
export async function requeueJob(jobId: string, progress?: Record<string, unknown>): Promise<void> {
  const { error } = await withNetworkRetry('requeue job', () =>
    db()
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
  )
  if (error) throw new Error(`Failed to requeue job ${jobId}: ${error.message}`)
}

/**
 * Park a job until `resumeAt` WITHOUT spending an attempt. Used when the
 * subscription window is full (lib/usageLimit.ts): the call never had a fair
 * chance, so it must not count toward max_attempts — otherwise a one-hour pause
 * would push every in-flight job to permanently `failed`.
 *
 * `claim_next_job()` incremented `attempts` when it claimed this row, so the
 * claim is undone here. The checkpoint (`progress`) is left exactly as the
 * handler last wrote it, so the job resumes where it stopped.
 */
export async function deferJob(job: Job, resumeAt: Date, reason: string): Promise<void> {
  const { error } = await withNetworkRetry('defer job', () =>
    db()
      .from('jobs')
      .update({
        status: 'queued',
        locked_at: null,
        run_after: resumeAt.toISOString(),
        attempts: Math.max(0, job.attempts - 1),
        error: reason.substring(0, 2000),
      })
      .eq('id', job.id)
  )
  if (error) throw new Error(`Failed to defer job ${job.id}: ${error.message}`)
}

export async function completeJob(jobId: string, progress?: Record<string, unknown>): Promise<void> {
  const { error } = await withNetworkRetry('complete job', () =>
    db()
      .from('jobs')
      .update({
        status: 'done',
        finished_at: new Date().toISOString(),
        error: null,
        ...(progress ? { progress } : {}),
      })
      .eq('id', jobId)
  )
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

  const { error } = await withNetworkRetry('record job failure', () =>
    db()
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
  )
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
    // Best effort only — "Run worker now" or `pipeline work` picks it up otherwise.
  })
}
