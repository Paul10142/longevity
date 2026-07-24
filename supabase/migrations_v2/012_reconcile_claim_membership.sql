-- 012_reconcile_claim_membership.sql
--
-- Supersedes 011. Same trigger (a source re-extraction cascades claim_members
-- away), but 011 only handled the all-or-nothing case: a claim that lost EVERY
-- member gets retired. A claim whose members span several sources loses only
-- the re-extracted ones — it stays correctly active, but its stored
-- `member_count` / `source_count` still describe the members it no longer has.
-- Those two columns are not decoration: `topic_claims()` ranks on source_count,
-- and it is the corroboration signal a reader sees.
--
-- So reconcile in one pass, in this order:
--   1. recount every active claim's aggregates from its surviving members,
--   2. retire the ones left with none.
--
-- Both mirror `recomputeAggregates()` (lib/consolidation.ts) — this is the same
-- rule applied in bulk to the claims a cascade changed behind our back. Retire,
-- never delete: the row keeps its id, so an already-published article that cites
-- it still resolves, and the flip is reversible.
--
-- Called from `scripts/pipeline.ts` right after the extract-time delete, before
-- the extract job is queued.

drop function if exists public.retire_memberless_claims();

create or replace function public.reconcile_claim_membership()
returns jsonb
language plpgsql
volatile
set search_path to 'public', 'extensions'
as $function$
declare
  v_recounted integer;
  v_retired integer;
begin
  with live as (
    select cm.claim_id,
           count(*)::int                       as n_members,
           count(distinct ri.source_id)::int   as n_sources
      from claim_members cm
      join raw_insights ri on ri.id = cm.raw_insight_id
     group by cm.claim_id
  ), fixed as (
    update claims c
       set member_count = live.n_members,
           source_count = live.n_sources
      from live
     where live.claim_id = c.id
       and c.status = 'active'
       and (c.member_count is distinct from live.n_members
         or c.source_count is distinct from live.n_sources)
    returning 1
  )
  select count(*)::int into v_recounted from fixed;

  with retired as (
    update claims c
       set status = 'retired', member_count = 0, source_count = 0
     where c.status = 'active'
       and not exists (select 1 from claim_members cm where cm.claim_id = c.id)
    returning 1
  )
  select count(*)::int into v_retired from retired;

  return jsonb_build_object('recounted', v_recounted, 'retired', v_retired);
end;
$function$;

comment on function public.reconcile_claim_membership() is
  'Bulk-reconcile claims against their surviving members after a cascade (e.g. a source re-extraction deleting its raw_insights): recount member_count/source_count on active claims, then retire the ones left with zero members. Returns {recounted, retired}. Mirrors recomputeAggregates(). Reversible — nothing is deleted.';
