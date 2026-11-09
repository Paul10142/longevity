-- 041_claim_split_repair.sql
--
-- STATUS: NOT APPLIED. Apply via the Supabase SQL Editor (LifestyleAcademy project),
-- AFTER 037_claim_repairs.sql (it writes to claim_repairs). 040 is reserved for the
-- extraction-reproducibility exclusion flag; if that lands under another number, only this
-- file's name changes, nothing inside it refers to 040.
--
-- Lets scripts/repairFlaggedClaims.ts write a SPLIT: one quarantined claim whose repair found
-- several distinct facts becomes several claims (Paul, 2026-11-08: "a merged claim that holds
-- several distinct facts becomes several claims"; 2026-11-09: "I want to approve the full repair").
--
-- WHY A DATABASE FUNCTION. A split touches six tables (claims, claim_members, claim_embeddings,
-- claim_flags, claim_repairs, and the new claims' provenance). supabase-js has no multi-statement
-- transaction, so doing it from the script would leave a crash window in which, say, members were
-- moved to a new claim whose embedding was never written. One plpgsql function is ONE transaction:
-- either every row below is written or none is, and the function can be called again safely.
--
-- WHAT apply_claim_split(...) DOES, in one transaction (nothing is written when it returns
-- 'stale' or 'already_applied', or when it raises):
--   1. locks the original claim, its flag and its member rows, and checks the world is still the
--      one the repair read: claim still `flagged` with the exact wording, flag still open, the
--      member insights in the plan are EXACTLY the claim's current members (no insight dropped,
--      none invented, none in two claims). Otherwise it returns {status:'stale'} and writes nothing.
--   2. saves the OLD wording first: a claim_repairs row (outcome 'repaired') for the original,
--      holding original_statement, the judge's verdicts and the whole split map in `attempts`.
--   3. claim 0 KEEPS the original id: its canonical_statement becomes the plan's first statement,
--      needs_tagging = true (its topics are re-judged; tagging only ADDS topics, existing ones stay).
--   4. every other claim is a NEW row (id chosen by the script so a retry is idempotent) with the
--      original's context_note / actionability / audience / insight_type / qualifiers copied,
--      needs_tagging = true, split_from_claim_id = the original, status = plan.status_after.
--   5. each member insight is MOVED (claim_members.claim_id updated; matched_by and match_confidence
--      kept) to the claim the plan names. raw_insights are never touched.
--   6. member_count / source_count / max_importance / best_evidence_type are recomputed for EVERY
--      resulting claim, with the same rules as recomputeAggregates() in lib/consolidation.ts.
--   7. claim_embeddings: claim 0's vector is replaced, one is created per new claim. The vectors are
--      computed by the script BEFORE the call, so an embedding failure never leaves a half-made claim.
--   8. the flag resolves as 'reworded' (evidence.repair records the split) and claim 0 goes back to
--      plan.status_after, the status lib/claimGate.ts gives a 'reworded' extraction_fidelity flag.
--
-- Called again after it committed (a lost response, a re-run) it finds the claim_repairs row and
-- returns {status:'already_applied'} without touching anything.
--
-- NO near_duplicate LINKS between the pieces (docs/REPAIR_FLAGGED_CLAIMS.md first proposed them):
-- lib/novelty.ts counts a claim with a near_duplicate link as a "refinement of known material", so
-- links between pieces of ONE original claim would misreport historical novelty. The review queue
-- they were meant to keep quiet no longer exists (no reviews since 2026-10-12).
--
-- STRICTLY ADDITIVE: one nullable column, one index, one function. No existing row changes when
-- this migration runs. Service-role only like everything else (migrations 006 / 027).
--
-- Undo for one split (the audit row has every id): move the members back to the original id,
-- restore canonical_statement from claim_repairs.original_statement, delete the new claims
-- (they cascade their embeddings), reopen the flag.

alter table public.claims
  add column if not exists split_from_claim_id uuid references public.claims(id) on delete set null;

create index if not exists claims_split_from_idx
  on public.claims (split_from_claim_id) where split_from_claim_id is not null;

comment on column public.claims.split_from_claim_id is
  'Set on a claim created by scripts/repairFlaggedClaims.ts when it split a quarantined claim: the id of the original (which kept its id for the first piece). The old wording is in claim_repairs.original_statement.';

create or replace function public.apply_claim_split(
  p_claim_id           uuid,
  p_flag_id            uuid,
  p_run_id             text,
  p_expected_statement text,
  p_plan               jsonb
) returns jsonb
language plpgsql
volatile
set search_path to 'public', 'extensions'
as $function$
declare
  v_items        jsonb := p_plan -> 'claims';
  v_audit        jsonb := coalesce(p_plan -> 'audit', '{}'::jsonb);
  v_status       text  := p_plan ->> 'status_after';
  v_claim        claims%rowtype;
  v_flag         claim_flags%rowtype;
  v_n            int;
  v_i            int;
  v_item         jsonb;
  v_ids          uuid[] := '{}';
  v_plan_members uuid[];
  v_cur_members  uuid[];
  v_moved        int;
begin
  -- Malformed plans are bugs in the caller, not stale data: raise (nothing has been written yet).
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    raise exception 'apply_claim_split: plan.claims must be an array';
  end if;
  v_n := jsonb_array_length(v_items);
  if v_n < 2 then
    raise exception 'apply_claim_split: a split needs at least two claims (got %)', v_n;
  end if;
  if v_status is distinct from 'active' then
    raise exception 'apply_claim_split: plan.status_after must be ''active'' (got %)', v_status;
  end if;
  for v_i in 0 .. v_n - 1 loop
    v_item := v_items -> v_i;
    if coalesce(btrim(v_item ->> 'statement'), '') = '' then
      raise exception 'apply_claim_split: claim % has no statement', v_i;
    end if;
    if jsonb_typeof(v_item -> 'member_ids') is distinct from 'array' or jsonb_array_length(v_item -> 'member_ids') = 0 then
      raise exception 'apply_claim_split: claim % has no member insights', v_i;
    end if;
    if coalesce(v_item ->> 'embedding', '') = '' then
      raise exception 'apply_claim_split: claim % has no embedding', v_i;
    end if;
    v_ids := v_ids || (v_item ->> 'id')::uuid;
  end loop;
  if v_ids[1] <> p_claim_id then
    raise exception 'apply_claim_split: the first claim of the plan must be the original claim';
  end if;
  if (select count(distinct x) from unnest(v_ids) x) <> v_n then
    raise exception 'apply_claim_split: the plan repeats a claim id';
  end if;

  -- 1. Lock, then check the world is the one the repair read.
  select * into v_claim from claims where id = p_claim_id for update;
  if not found then
    return jsonb_build_object('status', 'stale', 'reason', 'the claim no longer exists');
  end if;

  if exists (select 1 from claim_repairs where claim_id = p_claim_id and outcome in ('repaired', 'canonical_ok')) then
    return jsonb_build_object('status', 'already_applied');
  end if;

  select * into v_flag from claim_flags where id = p_flag_id for update;
  if not found or v_flag.claim_id <> p_claim_id or v_flag.resolved_at is not null then
    return jsonb_build_object('status', 'stale', 'reason', 'the flag is no longer open');
  end if;
  if v_claim.status <> 'flagged' then
    return jsonb_build_object('status', 'stale', 'reason', 'the claim is no longer quarantined (status ' || v_claim.status || ')');
  end if;
  if v_claim.canonical_statement is distinct from p_expected_statement then
    return jsonb_build_object('status', 'stale', 'reason', 'the claim wording changed after it was read');
  end if;

  select coalesce(array_agg(raw_insight_id order by raw_insight_id), '{}'::uuid[]) into v_cur_members
    from (select raw_insight_id from claim_members where claim_id = p_claim_id for update) m;
  select coalesce(array_agg(mid::uuid order by mid::uuid), '{}'::uuid[]) into v_plan_members
    from jsonb_array_elements(v_items) it, jsonb_array_elements_text(it -> 'member_ids') mid;
  if v_plan_members is distinct from v_cur_members then
    return jsonb_build_object('status', 'stale', 'reason', 'the claim''s member insights changed after they were read');
  end if;

  -- 2. The old wording is saved first.
  insert into claim_repairs (
    claim_id, flag_id, run_id, outcome, source, original_statement,
    verdict_before, offending_before, reasoning_before, new_statement, attempts, note, model
  ) values (
    p_claim_id, p_flag_id, p_run_id, 'repaired', 'rewrite', v_claim.canonical_statement,
    v_audit ->> 'verdict_before', v_audit ->> 'offending_before', v_audit ->> 'reasoning_before',
    v_items -> 0 ->> 'statement', coalesce(v_audit -> 'attempts', '[]'::jsonb),
    v_audit ->> 'note', v_audit ->> 'model'
  );

  -- 3. Claim 0 keeps the original id and row (flag, tags, article references stay valid).
  update claims
     set canonical_statement = v_items -> 0 ->> 'statement',
         needs_tagging = true
   where id = p_claim_id;

  -- 4 + 5. Every other piece is a new claim; its members are moved to it.
  for v_i in 1 .. v_n - 1 loop
    v_item := v_items -> v_i;
    insert into claims (
      id, canonical_statement, context_note, status, actionability, primary_audience, insight_type,
      qualifiers, member_count, source_count, needs_tagging, split_from_claim_id
    ) values (
      v_ids[v_i + 1], v_item ->> 'statement', v_claim.context_note, v_status, v_claim.actionability,
      v_claim.primary_audience, v_claim.insight_type, v_claim.qualifiers, 0, 0, true, p_claim_id
    );

    update claim_members
       set claim_id = v_ids[v_i + 1]
     where claim_id = p_claim_id
       and raw_insight_id in (select mid::uuid from jsonb_array_elements_text(v_item -> 'member_ids') mid);
    get diagnostics v_moved = row_count;
    if v_moved <> jsonb_array_length(v_item -> 'member_ids') then
      raise exception 'apply_claim_split: moved % of % member insights to claim %', v_moved, jsonb_array_length(v_item -> 'member_ids'), v_i;
    end if;
  end loop;

  -- 6. Aggregates for every resulting claim (same rules as recomputeAggregates in lib/consolidation.ts).
  with live as (
    select cm.claim_id,
           count(*)::int                     as n_members,
           count(distinct ri.source_id)::int as n_sources,
           max(ri.importance)                as max_imp,
           (array_agg(ri.evidence_type order by case ri.evidence_type
              when 'MetaAnalysis' then 8 when 'RCT' then 7 when 'Cohort' then 6 when 'CaseSeries' then 5
              when 'Mechanistic' then 4 when 'Animal' then 3 when 'ExpertOpinion' then 2 else 1 end desc))[1] as best_ev
      from claim_members cm
      join raw_insights ri on ri.id = cm.raw_insight_id
     where cm.claim_id = any (v_ids)
     group by cm.claim_id
  )
  update claims c
     set member_count = live.n_members,
         source_count = live.n_sources,
         max_importance = live.max_imp,
         best_evidence_type = coalesce(live.best_ev, 'Other')
    from live
   where c.id = live.claim_id;

  -- 7. Vectors: claim 0's follows its new wording; each new claim gets one.
  for v_i in 0 .. v_n - 1 loop
    insert into claim_embeddings (claim_id, embedding, updated_at)
    values (v_ids[v_i + 1], (v_items -> v_i ->> 'embedding')::extensions.halfvec, now())
    on conflict (claim_id) do update set embedding = excluded.embedding, updated_at = excluded.updated_at;
  end loop;

  -- 8. The flag resolves as 'reworded'; claim 0 goes back to the status the claim gate gives that resolution.
  update claim_flags
     set resolved_at = now(),
         resolution = 'reworded',
         evidence = coalesce(evidence, '{}'::jsonb) || jsonb_build_object('repair', coalesce(p_plan -> 'flag_repair', '{}'::jsonb))
   where id = p_flag_id;
  update claims set status = v_status where id = p_claim_id and status = 'flagged';

  return jsonb_build_object('status', 'applied', 'claim_ids', to_jsonb(v_ids));
end;
$function$;

revoke all on function public.apply_claim_split(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_claim_split(uuid, uuid, text, text, jsonb) to service_role;

comment on function public.apply_claim_split(uuid, uuid, text, text, jsonb) is
  'Writes one repair split in a single transaction: claim 0 keeps the original id, the other pieces are new claims, member insights are moved, embeddings and aggregates are written, the flag resolves as reworded, and the old wording is saved in claim_repairs. Returns {status: applied | already_applied | stale}; raises (rolling everything back) on a malformed plan or a constraint violation. See supabase/migrations_v2/041_claim_split_repair.sql.';
