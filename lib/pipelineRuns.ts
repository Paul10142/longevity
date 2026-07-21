/**
 * `pipeline_runs` lifecycle helpers.
 *
 * A run row must reach a terminal state exactly once. Two failure modes made
 * that untrue before these helpers existed, and both left rows stuck in
 * `running` forever:
 *
 *   1. A stage that yields on its time budget created a *fresh* run on every
 *      resume, abandoning the previous row. Hence `startOrResumeRun`: the run
 *      id rides in the checkpoint, so a resumed stage reuses its own row.
 *   2. A stage that threw never closed its row at all. Hence `failRun`, which
 *      every stage calls from a catch block before rethrowing.
 *
 * A yield is deliberately *not* terminal — the row stays `running` because the
 * work genuinely is still in flight, and the next tick resumes the same row.
 */

import { supabaseAdmin } from './supabaseServer'
import type { PipelineRun } from './types'

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

type RunKind = PipelineRun['kind']

/**
 * Reuse the checkpointed run when resuming, otherwise open a new one.
 * Returns null only if the insert failed — callers treat the run as
 * best-effort bookkeeping and must not abort their work over it.
 */
export async function startOrResumeRun(
  kind: RunKind,
  sourceId: string | null,
  existingRunId?: string | null,
  stats: Record<string, unknown> = {}
): Promise<string | null> {
  if (existingRunId) return existingRunId

  const { data, error } = await db()
    .from('pipeline_runs')
    .insert({ source_id: sourceId, kind, status: 'running', stats })
    .select('id')
    .single()
  if (error) {
    console.error(`[pipelineRuns] failed to open ${kind} run:`, error.message)
    return null
  }
  return (data?.id as string) ?? null
}

export async function finishRun(
  runId: string | null | undefined,
  stats: Record<string, unknown> = {}
): Promise<void> {
  if (!runId) return
  const { error } = await db()
    .from('pipeline_runs')
    .update({ status: 'success', finished_at: new Date().toISOString(), stats })
    .eq('id', runId)
  if (error) console.error(`[pipelineRuns] failed to finish run ${runId}:`, error.message)
}

/** Close a run as failed. Never throws — the caller is already unwinding. */
export async function failRun(runId: string | null | undefined, err: unknown): Promise<void> {
  if (!runId) return
  const message = err instanceof Error ? err.message : String(err)
  const { error } = await db()
    .from('pipeline_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: message.substring(0, 2000),
    })
    .eq('id', runId)
  if (error) console.error(`[pipelineRuns] failed to fail run ${runId}:`, error.message)
}
