-- 005: incremental topic updates (ARCHITECTURE.md "v3.2 incremental update model")
-- Adds the `update_topic` job type and the stale_topics() RPC that finds which
-- articles a new source actually invalidated. Applied via Supabase MCP 2026-07-21.

-- Allow the incremental update job type.
do $$
declare cname text;
begin
  select conname into cname from pg_constraint
   where conrelid = 'jobs'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%extract_source%';
  if cname is not null then
    execute format('alter table jobs drop constraint %I', cname);
  end if;
end $$;

alter table jobs add constraint jobs_type_check check (type = any (array[
  'extract_source','consolidate_source','tag_claims','discover_topics',
  'generate_topic','claim_sweep','extract_references','resolve_references',
  'compute_relations','update_topic'
]));

-- Topics whose article is out of date: they ALREADY have a clinician article and
-- have since had claims filed into them. Deliberately excludes topics with no
-- article at all — building those is a budgeted full-run decision, not something
-- an ingest should silently trigger.
create or replace function stale_topics()
returns table (topic_id uuid, new_claims bigint)
language sql
stable
security definer
set search_path = public
as $$
  with snap as (
    select t.id as topic_id,
           (select max(ta.claims_snapshot_at)
              from topic_articles ta
             where ta.topic_id = t.id and ta.audience = 'clinician') as snapshot_at
      from topics t
     where t.merged_into_id is null
  )
  select s.topic_id, count(ct.claim_id) as new_claims
    from snap s
    join claim_topics ct on ct.topic_id = s.topic_id
   where s.snapshot_at is not null
     and ct.created_at > s.snapshot_at
   group by s.topic_id
$$;
