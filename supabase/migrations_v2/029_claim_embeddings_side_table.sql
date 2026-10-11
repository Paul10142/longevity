-- 029_claim_embeddings_side_table.sql
--
-- Move claim vectors out of the hot `claims` row into a side table, stored at
-- half precision, with their own HNSW index. Apply together with the code
-- switch in lib/consolidation.ts (createClaimFromRaw writes the side table,
-- enrichClaimCanonical refreshes it, sweepClaims reads it).
--
-- WHY (measured 2026-10-11, docs/plan-review-2026-10-11.md §3):
--   * claims_embedding_idx is 251 MB on a Micro instance whose buffer cache is
--     224 MB, and the vectors in claims/raw_insights TOAST add ~550 MB. The
--     working set no longer fits: match_claims mean 173 ms, max 7.9 s; a claim
--     insert up to 5.4 s. It grows linearly with the corpus (~800 MB at 100k
--     claims on a 1 GB machine).
--   * 76% of claim updates are not in-place (enriched_at, max_importance and
--     needs_tagging are indexed), so every merge writes a new row version AND a
--     new HNSW entry for a vector that did not change — two or three index
--     inserts per attach.
-- Half precision halves the index (~125 MB, fits in cache) and shifts cosine
-- values by ~1e-3 at most, far below the 0.75 / 0.80 gates.
--
-- STRICTLY ADDITIVE: claims.embedding and its index stay until the switch is
-- verified in production; migration 030 drops them.

create table if not exists public.claim_embeddings (
  claim_id   uuid primary key references public.claims(id) on delete cascade,
  embedding  extensions.halfvec(1536) not null,
  updated_at timestamptz not null default now()
);

-- Service-role only, like every other table (migrations 006 / 027): RLS on,
-- no policies, so anon/authenticated get nothing through PostgREST.
alter table public.claim_embeddings enable row level security;

insert into public.claim_embeddings (claim_id, embedding)
select id, embedding::extensions.halfvec(1536)
from public.claims
where embedding is not null
on conflict (claim_id) do nothing;

-- Build the graph in memory: ~100 MB for 32k half-precision vectors. 128 MB is
-- safe on the 1 GB instance and applies to this transaction only.
set local maintenance_work_mem = '128MB';
create index if not exists claim_embeddings_hnsw_idx
  on public.claim_embeddings using hnsw (embedding extensions.halfvec_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Same signature, so every caller is unchanged. The defaults follow the
-- 2026-10-11 gate decision (0.75, 8 candidates); the pipeline passes both
-- explicitly in any case. `relaxed_order` lets the index scan keep going when
-- the status filter removes candidates, instead of returning short.
create or replace function public.match_claims(
  query_embedding extensions.vector,
  match_threshold double precision default 0.75,
  match_count integer default 8
)
returns table(id uuid, canonical_statement text, context_note text, similarity double precision)
language sql
stable
set search_path to 'public', 'extensions'
set hnsw.iterative_scan to 'relaxed_order'
as $$
  select c.id, c.canonical_statement, c.context_note,
         1 - (e.embedding <=> query_embedding::halfvec(1536)) as similarity
  from claim_embeddings e
  join claims c on c.id = e.claim_id
  where c.status = 'active'
    and 1 - (e.embedding <=> query_embedding::halfvec(1536)) >= match_threshold
  order by e.embedding <=> query_embedding::halfvec(1536)
  limit match_count;
$$;

-- PostgREST caches the schema; without this the new table is invisible to the
-- API until its next reload.
notify pgrst, 'reload schema';
