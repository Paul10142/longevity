-- 019: admin_source_list() — a cheap listing for /admin/sources.
--
-- The page did `select('*')` on `sources`, which drags every full transcript
-- (the table is ~42 MB) through PostgREST. At 249 sources that now exceeds the
-- statement timeout and the page fails outright with 57014.
--
-- It also counted insights by reading raw_insights unpaginated, which PostgREST
-- silently caps at 1000 rows — so the per-source counts were wrong once the
-- corpus passed 1000 insights (it is now >12,000).
--
-- Both are fixed by aggregating server-side and never returning transcript text:
-- the word count is computed in SQL, and insight counts come from a GROUP BY.

create or replace function admin_source_list()
returns table (
  id uuid,
  type text,
  title text,
  authors text[],
  date date,
  created_at timestamptz,
  processing_status text,
  transcript_quality text,
  media_duration_sec int,
  word_count int,
  insights_count bigint
)
language sql
stable
as $$
  select
    s.id,
    s.type,
    s.title,
    s.authors,
    s.date,
    s.created_at,
    s.processing_status,
    s.transcript_quality,
    s.media_duration_sec,
    -- Cheap word count: non-empty whitespace-delimited tokens. Computed here so
    -- the transcript itself never leaves the database.
    coalesce(array_length(regexp_split_to_array(btrim(s.transcript), '\s+'), 1), 0)::int as word_count,
    coalesce(i.n, 0) as insights_count
  from sources s
  left join (
    select source_id, count(*) as n from raw_insights group by source_id
  ) i on i.source_id = s.id
  order by s.created_at desc;
$$;

comment on function admin_source_list() is
  'Listing for /admin/sources: per-source metadata, transcript word count and raw-insight count, without returning transcript text.';
