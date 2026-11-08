-- 037_claim_repairs.sql
--
-- STATUS: NOT APPLIED. Apply via the Supabase SQL Editor (LifestyleAcademy project).
--
-- Audit trail for scripts/repairFlaggedClaims.ts, which fixes quarantined
-- (claims.status = 'flagged') claims in place instead of re-extracting them.
-- claims.canonical_statement is the only column the repair edits, and it
-- overwrites the old wording, so the old wording is kept here, one row per claim
-- the repair finished with. raw_insights are never touched.
--
-- STRICTLY ADDITIVE: one new table, nothing existing is altered. Service-role
-- only like every table (migrations 006 / 027): RLS on, no policies.
--
-- outcome:
--   repaired       new wording passed the fidelity judge; claim went back to active
--   canonical_ok   the claim's current wording already passed against the seed
--                  passage (the flag was about the seed insight's own wording);
--                  claim went back to active with its wording unchanged
--   failed         two rewrites did not pass the judge; claim stays hidden
--   needs_video    depends on something shown on screen; stays hidden, flag noted
--   cannot_repair  the passage supports no version of the claim; stays hidden
--   refused        the model's safety filter declined; stays hidden
--
-- source (repaired / canonical_ok only):
--   member    another member insight's own wording, adopted verbatim
--   rewrite   written by the repair model from the failing passage
--   unchanged the current wording was kept

create table if not exists public.claim_repairs (
  id                 uuid primary key default gen_random_uuid(),
  claim_id           uuid not null references public.claims(id) on delete cascade,
  flag_id            uuid references public.claim_flags(id) on delete set null,
  run_id             text not null,
  outcome            text not null check (outcome in
                       ('repaired', 'canonical_ok', 'failed', 'needs_video', 'cannot_repair', 'refused')),
  source             text check (source in ('member', 'rewrite', 'unchanged')),
  -- The wording before the repair, and the judge's original verdict on it.
  original_statement text not null,
  verdict_before     text,
  offending_before   text,
  reasoning_before   text,
  -- The wording after (repaired only) and, when it came from another member, which insight.
  new_statement      text,
  member_raw_insight_id uuid references public.raw_insights(id) on delete set null,
  -- Every step taken: each judged statement with its verdict, each rewrite with what it changed.
  attempts           jsonb not null default '[]'::jsonb,
  note               text,
  model              text,
  created_at         timestamptz not null default now()
);

create index if not exists claim_repairs_claim_idx on public.claim_repairs (claim_id, created_at desc);

-- A claim is repaired once. A failed / needs_video row may be followed by a later try
-- (--retry), so only the repaired outcomes are unique: that is what makes a re-run
-- skip finished claims and lets a half-applied repair be recognised and finished.
create unique index if not exists claim_repairs_one_applied_idx
  on public.claim_repairs (claim_id) where outcome in ('repaired', 'canonical_ok');

alter table public.claim_repairs enable row level security;
revoke all on public.claim_repairs from anon, authenticated;

comment on table public.claim_repairs is
  'One row per flagged claim the repair tool finished with: the wording before, the wording after, the judge verdicts, and why. The only record of the pre-repair canonical_statement.';
