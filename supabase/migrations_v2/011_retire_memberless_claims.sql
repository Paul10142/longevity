-- 011_retire_memberless_claims.sql
--
-- Retire claims that have lost every member (v4 Phase 1, corpus re-extraction).
--
-- ⚠ SUPERSEDED BY 012, which drops this function and replaces it with
-- `reconcile_claim_membership()` — same rule plus the partial case (a claim that
-- lost only *some* members keeps a stale member_count/source_count). Applied
-- 2026-07-24 and used once to retire the 129 claims a prior re-extraction had
-- already stranded; kept here for the ledger.
--
-- WHY: `claim_members.raw_insight_id` is ON DELETE CASCADE, so re-extracting a
-- source (`npm run pipeline -- extract <id>`, which deletes that source's
-- raw_insights first) silently strips the members off every claim seeded from
-- it. Nothing recomputes those claims: they stay `status='active'` with a stale
-- `member_count`, and because `match_claims` only filters on status they remain
-- live ANN candidates. The re-extracted insights then merge back into ghost
-- claims whose canonical came from the discarded extraction — the corpus is no
-- longer uniform, and `topic_claims` still serves them to synthesis.
--
-- This is the same rule `recomputeAggregates` already applies when a claim's
-- last member is detached (lib/consolidation.ts) — a memberless claim is
-- retired — just applied in bulk to the claims a cascade emptied behind our
-- back. Retire, never delete: the row keeps its id, so an already-published
-- article that cites it still resolves, and the flip is reversible.
--
-- Called from `scripts/pipeline.ts` immediately after the extract-time delete,
-- before the consolidate job is queued.

create or replace function public.retire_memberless_claims()
returns integer
language sql
volatile
set search_path to 'public', 'extensions'
as $function$
  with retired as (
    update claims c
       set status = 'retired', member_count = 0, source_count = 0
     where c.status = 'active'
       and not exists (select 1 from claim_members cm where cm.claim_id = c.id)
    returning 1
  )
  select count(*)::int from retired;
$function$;

comment on function public.retire_memberless_claims() is
  'Bulk-retire active claims left with zero members (e.g. after a source re-extraction cascaded their claim_members away). Returns the number retired. Mirrors recomputeAggregates(): memberless => retired. Reversible — nothing is deleted.';
