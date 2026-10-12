-- 031_drop_claims_embedding.sql
--
-- Finish the vector move started in 029/030: drop the old `claims.embedding`
-- column. Every read and write of claim vectors has used `claim_embeddings`
-- (halfvec, own HNSW index) since Phase A, and the first full ingestion through
-- that path completed on 2026-10-12 (2,800 new facts, 1,902 new claims, no
-- error from the side table).
--
-- Verified before applying (2026-10-12):
--   * every active claim has a row in claim_embeddings (0 without);
--   * the 2,191 claims that still held an old-column vector but have no side
--     row are the RETIRED shells, whose vectors the retirement script removes
--     by design;
--   * 1,126 old-column vectors differ from their side-table vector: those are
--     claims enriched since the move. The side table is authoritative (it is
--     refreshed on enrich); the old column was stale for them;
--   * no code reads `claims.embedding` (lib/, scripts/, app/);
--   * the only database object that did was the helper function
--     gated_pair_sample (an unused sampling helper), repointed below.
--
-- The old column is not recoverable after this; the vectors that matter live in
-- claim_embeddings.

create or replace function public.gated_pair_sample(
  p_lo double precision,
  p_hi double precision,
  p_sample integer default 300,
  p_limit integer default 20
)
returns table(a text, b text, sim double precision)
language sql
stable
set search_path to 'public', 'extensions'
as $$
  with sample as (
    select c.id, e.embedding, c.canonical_statement
    from claims c
    join claim_embeddings e on e.claim_id = c.id
    where c.status = 'active'
    order by random()
    limit p_sample
  ),
  nn as (
    select s.canonical_statement as a,
           n.canonical_statement as b,
           (1 - (n.embedding <=> s.embedding))::float8 as sim
    from sample s
    cross join lateral (
      select c.canonical_statement, e.embedding
        from claims c
        join claim_embeddings e on e.claim_id = c.id
       where c.status = 'active' and c.id <> s.id
       order by e.embedding <=> s.embedding
       limit 1
    ) n
  )
  select a, b, sim from nn
  where sim >= p_lo and sim < p_hi
  order by sim desc
  limit p_limit;
$$;

alter table public.claims drop column if exists embedding;
