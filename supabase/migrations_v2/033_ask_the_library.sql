-- 033_ask_the_library.sql
--
-- "Ask the Library" (docs/ask-the-library-design.md, approved by Paul 2026-10-25).
-- A physician asks a question; the app retrieves every relevant claim, writes a
-- short cited brief, and logs the exchange. This migration is the database half.
--
-- STRICTLY ADDITIVE: three functions and two tables, no existing object changes,
-- no rows move. Safe to apply while an extraction run is live.
--
-- 1. search_claims — question-time retrieval. match_claims (030) runs the HNSW
--    index at the default hnsw.ef_search = 40, so asking for 200 rows returns ~34
--    (measured 2026-10-25, design §3.1). That is right for dedup (8 candidates)
--    and useless for a question that touches 100-300 claims. This function raises
--    ef_search to 300 for its own scan only (via set_config, see the body);
--    match_claims is untouched. It also returns the columns the ranker needs
--    (evidence type, source count, importance) and the newest source date of
--    each claim (recency, design §6.2).
--
-- 2. claim_twins — which of a set of claims are near-identical to each other
--    (caption/Deepgram twins, design §6.2). Done in the database so 150 vectors
--    never travel over the wire; only the pairs that clear the threshold come back.
--
-- 3. match_ask_answers — nearest earlier question, for the answer cache (§6.6).
--
-- 4. ask_answers / ask_feedback — the log. Service-role only like every other
--    table (migrations 006 / 027): RLS on, NO policies, so anon and authenticated
--    get nothing through PostgREST. Do not "fix" the no-policy advisor warning.

create or replace function public.search_claims(
  query_embedding extensions.vector,
  match_threshold double precision default 0.45,
  match_count integer default 100
)
returns table(
  id uuid,
  canonical_statement text,
  context_note text,
  best_evidence_type text,
  max_importance integer,
  source_count integer,
  insight_type text,
  latest_source_date date,
  similarity double precision
)
language plpgsql
stable
set search_path to 'public', 'extensions'
as $$
begin
  -- Transaction-local, so match_claims and every other caller keep the default.
  -- A function-level `set hnsw.ef_search = 300` (design §6.1) is refused by the
  -- migration role ("permission denied to set parameter", 2026-10-25, the same
  -- error migration 030 hit on 2026-10-11); set_config at call time is allowed.
  perform set_config('hnsw.ef_search', '300', true);
  return query
  with hits as (
    select c.id, c.canonical_statement, c.context_note, c.best_evidence_type,
           c.max_importance, c.source_count, c.insight_type,
           1 - (e.embedding <=> query_embedding::halfvec(1536)) as similarity
    from claim_embeddings e
    join claims c on c.id = e.claim_id
    where c.status = 'active'
      and 1 - (e.embedding <=> query_embedding::halfvec(1536)) >= match_threshold
    order by e.embedding <=> query_embedding::halfvec(1536)
    limit match_count
  )
  select h.id, h.canonical_statement, h.context_note, h.best_evidence_type,
         h.max_importance, h.source_count, h.insight_type,
         (select max(s.date)::date
            from claim_members cm
            join raw_insights ri on ri.id = cm.raw_insight_id
            join sources s on s.id = ri.source_id
           where cm.claim_id = h.id and s.date is not null) as latest_source_date,
         h.similarity
  from hits h
  order by h.similarity desc;
end;
$$;

create or replace function public.claim_twins(
  claim_ids uuid[],
  min_similarity double precision default 0.95
)
returns table(claim_id uuid, twin_id uuid, similarity double precision)
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select a.claim_id, b.claim_id as twin_id,
         1 - (a.embedding <=> b.embedding) as similarity
  from claim_embeddings a
  join claim_embeddings b on a.claim_id < b.claim_id
  where a.claim_id = any(claim_ids)
    and b.claim_id = any(claim_ids)
    and 1 - (a.embedding <=> b.embedding) >= min_similarity;
$$;

create table if not exists public.ask_answers (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  question_norm text not null,             -- lower, trimmed, whitespace-collapsed
  question_embedding extensions.halfvec(1536),
  status text not null default 'answered'
    check (status in ('answered', 'not_covered', 'failed')),
  candidates jsonb not null default '[]'::jsonb,  -- [{id, similarity, collapsed_into?}] as retrieved
  cited_claim_ids uuid[] not null default '{}',
  body_markdown text,
  sentences jsonb,                         -- lib/blocks Sentence[] after parsing
  follow_ups text[],
  related_topics jsonb,                    -- [{id,name,slug,similarity}]: nearest public topic pages
  thin boolean not null default false,     -- answered under the "thin evidence" banner
  dangling_markers integer not null default 0,
  model text,
  effort text,
  latency_ms integer,
  first_token_ms integer,
  input_tokens integer,
  output_tokens integer,
  stage_stats jsonb,                       -- per-stage ms / tokens / cost, for the measurement table
  groundedness_score numeric,              -- async audit; null until scored
  corpus_claims integer,                   -- active claims at answer time (staleness, §6.6)
  asked_by text,                           -- 'admin' until accounts exist
  error text,                              -- set when status = 'failed'
  created_at timestamptz not null default now()
);

create index if not exists ask_answers_question_norm_idx on public.ask_answers (question_norm);
create index if not exists ask_answers_created_idx on public.ask_answers (created_at desc);
create index if not exists ask_answers_embedding_idx
  on public.ask_answers using hnsw (question_embedding extensions.halfvec_cosine_ops);

create table if not exists public.ask_feedback (
  id uuid primary key default gen_random_uuid(),
  answer_id uuid not null references public.ask_answers(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists ask_feedback_answer_idx on public.ask_feedback (answer_id);

alter table public.ask_answers enable row level security;
alter table public.ask_feedback enable row level security;

create or replace function public.match_ask_answers(
  query_embedding extensions.vector,
  match_threshold double precision default 0.95,
  match_count integer default 3
)
returns table(id uuid, question text, similarity double precision)
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select a.id, a.question,
         1 - (a.question_embedding <=> query_embedding::halfvec(1536)) as similarity
  from ask_answers a
  where a.status in ('answered', 'not_covered')
    and a.question_embedding is not null
    and 1 - (a.question_embedding <=> query_embedding::halfvec(1536)) >= match_threshold
  order by a.question_embedding <=> query_embedding::halfvec(1536)
  limit match_count;
$$;

comment on table public.ask_answers is
  'Ask the Library log: one row per asked question (design §6.1). Doubles as the answer cache (§6.6) and the content roadmap (not_covered rows).';
comment on table public.ask_feedback is
  'Thumbs and notes on an Ask the Library answer.';

-- PostgREST caches the schema; without this the new tables and functions are
-- invisible to the API until its next reload.
notify pgrst, 'reload schema';
