-- 013_claim_gate.sql
--
-- Phase 2 groundwork: the claim gate (spec §7) + near-duplicate links (§6, §9.1).
--
-- STRICTLY ADDITIVE, ON PURPOSE. It widens a CHECK and adds two tables; it does
-- NOT migrate any existing row and does NOT change what synthesis reads. The
-- switchover — `active` → `approved`, and teaching `topic_claims()` /
-- `match_claims()` to serve only approved claims — is a separate, deliberate
-- step, because it changes what every reader of the corpus sees and must not
-- happen while a consolidation run is in flight.
--
-- Spec §7.4 is explicit about the ordering trap this respects: bulk-approval
-- runs in Phase 2 on the RE-CONSOLIDATED set, never on today's claims. Approving
-- first and re-consolidating after throws the approvals away.

-- 1. Status lifecycle (§7.1). The v4 vocabulary is added alongside the existing
--    values rather than replacing them, so current code (which filters
--    status = 'active') keeps working unchanged until the switchover.
--
--      approved  — visible to synthesis            (today's 'active')
--      flagged   — quarantined, in the review queue; invisible to synthesis
--      archived  — retired                          (today's 'retired')
--      merged    — folded into another claim        (today's 'merged_into')
alter table claims drop constraint if exists claims_status_check;
alter table claims add constraint claims_status_check check (
  status = any (array[
    'active', 'merged_into', 'retired',        -- pre-v4, still in use
    'approved', 'flagged', 'archived', 'merged' -- v4 claim gate
  ])
);

-- 2. Near-duplicate links (§6 "F3 fix"). When two insights are close but a
--    MATERIAL difference blocks the merge, the relationship is recorded instead
--    of being thrown away. Two reasons, per the spec: it preserves the "variants
--    of one idea" structure a reader needs, and it is the substrate for an honest
--    novelty metric (§9) — refinements are the engine's real value, and without
--    this link they are invisible and novelty under-reports them.
create table if not exists claim_links (
  claim_id          uuid not null references claims(id) on delete cascade,
  related_claim_id  uuid not null references claims(id) on delete cascade,
  kind              text not null default 'near_duplicate'
                      check (kind in ('near_duplicate', 'contradicts', 'refines')),
  similarity        double precision,
  note              text,
  created_at        timestamptz not null default now(),
  -- Ordered pair: the relationship is symmetric, so storing (A,B) and (B,A)
  -- would double-count it in every novelty tally. Callers must insert with the
  -- smaller uuid first; the CHECK makes a wrong-order insert fail loudly rather
  -- than silently creating a second edge for the same relationship.
  constraint claim_links_ordered check (claim_id < related_claim_id),
  primary key (claim_id, related_claim_id, kind)
);

create index if not exists claim_links_related_idx on claim_links (related_claim_id);

-- 3. Flags (§7.2). Four rules, tuned narrow — Paul's review budget is a few
--    hundred per 100 hours ingested, so a flag fires rarely and is right when it
--    does. One row per (claim, rule) so re-running a rule is idempotent.
--
--      standalone      — a physician reading only this sentence could not act on
--                        it: dangling referent, missing dose/population. The
--                        keystone CLARITY rule.
--      merge_fidelity  — the canonical asserts a range/dose/population/threshold
--                        no single member carried, i.e. the merge invented
--                        specificity. The keystone FIDELITY rule, and distinct
--                        from `standalone`: a bad merge is perfectly clear yet
--                        unfaithful, so clarity review waves it through.
--      contradiction   — direct conflict with another claim. Low volume, high
--                        stakes; feeds consensus/contested labelling.
--      orphan_topic    — attached to no topic, or below the tagging threshold.
create table if not exists claim_flags (
  id           uuid primary key default gen_random_uuid(),
  claim_id     uuid not null references claims(id) on delete cascade,
  rule         text not null check (rule in ('standalone', 'merge_fidelity', 'contradiction', 'orphan_topic')),
  detail       text,
  -- For merge_fidelity: the specific unsupported span. For contradiction: the
  -- other claim. Evidence travels with the flag so review needs no re-derivation.
  evidence     jsonb,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolution   text check (resolution in ('approved', 'edited', 'split', 'narrowed', 'archived', 'false_positive')),
  unique (claim_id, rule)
);

create index if not exists claim_flags_open_idx on claim_flags (rule) where resolved_at is null;

comment on table claim_links is
  'Claim-to-claim relationships. near_duplicate = kept separate because of a material difference, but recorded as variants of one idea (spec §6) — the substrate for the novelty metric (§9). Pairs are stored with the smaller uuid first so the symmetric relationship is one row.';
comment on table claim_flags is
  'Claim review queue (spec §7.2). One row per (claim, rule); resolved_at NULL = open. Quarantine is expressed by claims.status = flagged, not by this table, so a claim can carry several flags and still be gated once.';

-- RLS to match the rest of the schema (migration 006): all app access is via the
-- service-role client, which bypasses RLS; enabling it with no policies means
-- anon/authenticated get zero access through PostgREST, which is the intent.
alter table claim_links enable row level security;
alter table claim_flags enable row level security;
