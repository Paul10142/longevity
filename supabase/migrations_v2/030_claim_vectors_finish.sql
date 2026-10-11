-- 030_claim_vectors_finish.sql
--
-- Second half of 029, applied the same evening after verification in
-- production: side-table rows == claims with a vector (32,104 = 32,104), 0
-- active claims without a vector, and on 25 random claims the new function
-- returned the identical nearest neighbour with a similarity delta of 0.0000.
--
-- Two things:
--
-- 1. match_claims is redefined WITHOUT `hnsw.iterative_scan = relaxed_order`.
--    That mode keeps walking the index until LIMIT rows satisfy the WHERE, and
--    the WHERE here is a similarity floor most claims' neighbours never reach
--    (72% of claims have no neighbour above 0.75), so for them the scan ran to
--    pgvector's 20,000-tuple cap: one call took 19.4 s with 10,703 buffers read
--    (EXPLAIN ANALYZE, 2026-10-11). Plain mode returns the ef_search nearest
--    candidates and filters them — exactly the semantics the pipeline wants
--    ("the near neighbours that clear the floor"), in milliseconds. The index's
--    default search depth (hnsw.ef_search = 40) applies: the migration role is
--    not allowed to pin that parameter inside a function ("permission denied to
--    set parameter", 2026-10-11), and 40 candidates for a shortlist of 8 is ample.
--
-- 2. The 251 MB HNSW index on claims.embedding is dropped. Nothing reads it
--    now, and it was competing with the new index for the 224 MB buffer cache.
--    The column's data stays as a rollback (recreate the index and point
--    match_claims back at it) until the first full ingestion has gone through
--    the new path; drop the column after that.

create or replace function public.match_claims(
  query_embedding extensions.vector,
  match_threshold double precision default 0.75,
  match_count integer default 8
)
returns table(id uuid, canonical_statement text, context_note text, similarity double precision)
language sql
stable
set search_path to 'public', 'extensions'
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

drop index if exists public.claims_embedding_idx;

-- When the column goes:
--   alter table public.claims drop column embedding;
