-- Test-only schema for tests/claimSplitSql.test.ts: just the tables and constraints apply_claim_split touches,
-- copied from supabase/migrations_v2 (001 baseline, 013/014 claim gate, 029 embeddings, 007/009 extra columns).
-- pgvector is not needed to test the transaction: `extensions.halfvec` is a text domain that rejects anything
-- that is not a bracketed list of numbers, so a malformed vector fails at the same point a real one would.
-- The REAL migrations 037_claim_repairs.sql and 041_claim_split_repair.sql are run on top of this.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema extensions;
create domain extensions.halfvec as text check (value ~ '^\[[-0-9.eE, ]+\]$');

create table public.raw_insights (
  id uuid primary key,
  source_id uuid not null,
  statement text not null,
  importance int check (importance in (1, 2, 3)),
  evidence_type text
);

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  canonical_statement text not null,
  context_note text,
  status text not null default 'active' check (status = any (array['active','merged_into','retired','approved','flagged','archived','merged'])),
  merged_into_id uuid references public.claims(id) on delete set null,
  best_evidence_type text check (best_evidence_type in ('RCT','Cohort','MetaAnalysis','CaseSeries','Mechanistic','Animal','ExpertOpinion','Other')),
  max_importance int check (max_importance in (1, 2, 3)),
  actionability text check (actionability in ('Low','Medium','High')),
  primary_audience text check (primary_audience in ('Patient','Clinician','Both')),
  insight_type text check (insight_type in ('Protocol','Explanation','Mechanism','Anecdote','Warning','Controversy','Other')),
  qualifiers jsonb,
  member_count int not null default 0,
  source_count int not null default 0,
  needs_tagging boolean not null default true,
  topic_fit text,
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.claim_members (
  claim_id uuid not null references public.claims(id) on delete cascade,
  raw_insight_id uuid not null unique references public.raw_insights(id) on delete cascade,
  match_confidence numeric check (match_confidence >= 0 and match_confidence <= 1),
  matched_by text not null default 'auto' check (matched_by in ('auto', 'human', 'seed')),
  created_at timestamptz not null default now(),
  primary key (claim_id, raw_insight_id)
);

create table public.claim_flags (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  rule text not null check (rule in ('standalone','merge_fidelity','contradiction','orphan_topic','extraction_fidelity','manual')),
  detail text,
  evidence jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('approved','edited','split','narrowed','archived','false_positive','reworded')),
  unique (claim_id, rule)
);

create table public.claim_embeddings (
  claim_id uuid primary key references public.claims(id) on delete cascade,
  embedding extensions.halfvec not null,
  updated_at timestamptz not null default now()
);
