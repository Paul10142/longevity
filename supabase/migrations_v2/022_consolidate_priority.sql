-- 022 — finish a source before starting another: consolidate jobs claim first.
--
-- THE BUG THIS FIXES (found 2026-08-16, cost ~29 h of frozen claims).
-- claim_next_job() ordered strictly by created_at. overnightExtract enqueues
-- extract_source in batches of 4, and each source's consolidate_source job is
-- only created when its extract finishes — roughly an hour later. So every
-- consolidate lands BEHIND the whole rest of the extract batch, and behind any
-- extract left over from earlier batches. With extraction at ~1 source/hour the
-- head of the queue stayed extract-only for a day at a time:
--
--   * 21 consolidate_source jobs queued, oldest 2026-08-15 06:58 — never claimed
--     once (attempts 0, started_at NULL) as of 2026-08-16 10:25.
--   * No consolidate job had completed since 2026-08-15 05:08.
--   * 4,114 raw_insights (22% of the corpus) had no claim_member; active claims
--     sat at exactly 12,997 while raw insights grew by ~3,500.
--
-- Extraction looked healthy the whole time — sources kept landing — but the
-- library stopped gaining claims, which is the part that has value. This is
-- head-of-line blocking, not a stall: nothing was broken, the work was simply
-- always last in line.
--
-- THE FIX. Claim consolidate_source ahead of everything else, then fall back to
-- FIFO. That restores the supervisor's documented intent ("Each source also
-- finishes (extract+consolidate) before we move on, rather than extracting
-- everything then consolidating", scripts/overnightExtract.ts) and bounds the
-- unconsolidated backlog at roughly one source instead of letting it grow.
--
-- Consolidation is also the cheap half — it adjudicates insights already on
-- disk, where extraction re-reads a whole transcript — so promoting it costs
-- little throughput and stops raw_insights piling up unconverted.
--
-- Retry safety is unchanged: failJob still sets run_after with exponential
-- backoff, and run_after <= now() is still required, so a failing consolidate
-- backs off rather than spinning at the head of the queue.

CREATE OR REPLACE FUNCTION public.claim_next_job()
 RETURNS SETOF jobs
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  claimed jobs%ROWTYPE;
BEGIN
  SELECT * INTO claimed
  FROM jobs
  WHERE (status = 'queued' AND run_after <= now())
     OR (status = 'running' AND locked_at < now() - interval '10 minutes')
  -- Finish what is already extracted before extracting more; FIFO within a tier.
  ORDER BY (CASE WHEN type = 'consolidate_source' THEN 0 ELSE 1 END), created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF claimed.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE jobs
  SET status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      started_at = COALESCE(started_at, now())
  WHERE id = claimed.id
  RETURNING * INTO claimed;

  RETURN NEXT claimed;
END;
$function$;
