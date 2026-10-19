-- 032 — claim_next_job() can be limited to some job types (extract / consolidate lanes).
--
-- WHY. scripts/extractDeepgram.ts can now run as two separate lanes:
--   --extract-only      runs extract_source jobs and leaves consolidate_source queued
--   --consolidate-only  drains consolidate_source jobs, one source at a time
-- The old claim_next_job() takes ANY type and (migration 022) always prefers
-- consolidate_source, so an extract-only run would claim a consolidate job
-- first on every call and never reach an extract job. Each lane has to ask for
-- only its own type.
--
-- BACKWARD COMPATIBLE. The new parameter defaults to NULL, which means "any
-- type" and keeps the exact ordering and behaviour of 022: calling
-- `rpc('claim_next_job')` with no argument works before and after this
-- migration, so code on `main` is unaffected whether or not this is applied.
-- Only the lane modes pass p_types, and they refuse to start (clear message)
-- until this migration is applied.
--
-- The zero-argument function must be dropped: leaving both would make
-- `rpc('claim_next_job')` ambiguous for PostgREST.
--
-- Undo: re-run supabase/migrations_v2/022_consolidate_priority.sql after
-- `drop function public.claim_next_job(text[]);` (the lanes then stop working;
-- the plain supervisor is unchanged).

drop function if exists public.claim_next_job();

create or replace function public.claim_next_job(p_types text[] default null)
 returns setof jobs
 language plpgsql
 set search_path to 'public', 'extensions'
as $function$
declare
  claimed jobs%rowtype;
begin
  select * into claimed
  from jobs
  where ((status = 'queued' and run_after <= now())
      or (status = 'running' and locked_at < now() - interval '10 minutes'))
    and (p_types is null or type = any(p_types))
  -- Finish what is already extracted before extracting more; FIFO within a tier.
  order by (case when type = 'consolidate_source' then 0 else 1 end), created_at
  limit 1
  for update skip locked;

  if claimed.id is null then
    return;
  end if;

  update jobs
  set status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      started_at = coalesce(started_at, now())
  where id = claimed.id
  returning * into claimed;

  return next claimed;
end;
$function$;

revoke all on function public.claim_next_job(text[]) from public, anon, authenticated;
grant execute on function public.claim_next_job(text[]) to service_role;
