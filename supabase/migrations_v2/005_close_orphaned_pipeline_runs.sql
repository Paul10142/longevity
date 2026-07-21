-- 005: One-time repair for pipeline_runs rows orphaned in 'running'.
--
-- Two bugs (both fixed in lib/pipelineRuns.ts + its callers) left runs open:
--   1. A stage that yielded on its time budget opened a NEW run on every
--      resume instead of reusing the checkpointed one, abandoning the old row.
--      Tagging leaked one row per ~4-minute tick.
--   2. A stage that threw never closed its row at all, so every OpenAI 429
--      during the July 20 quota outage left a run stuck in 'running'.
--
-- This closes only rows older than one hour so a genuinely in-flight run is
-- never clobbered. Safe to re-run: the WHERE clause excludes terminal rows.

UPDATE pipeline_runs
SET status = 'failed',
    finished_at = now(),
    error_message = COALESCE(
      error_message,
      'Closed by migration 005: run orphaned in ''running'' by a stage that yielded or threw without finalizing.'
    )
WHERE status = 'running'
  AND started_at < now() - interval '1 hour';

-- Sources left mid-flight by the same failures. Extraction now sets 'failed'
-- with an error message itself; these are the rows stranded before that fix.
UPDATE sources
SET processing_status = 'failed',
    processing_error = COALESCE(
      processing_error,
      'Extraction did not complete (OpenAI quota exceeded during the July 20 outage). Re-extract to retry.'
    )
WHERE processing_status = 'processing'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.payload->>'source_id' = sources.id::text
      AND j.status IN ('queued', 'running')
  );
