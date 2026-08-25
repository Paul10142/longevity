-- Return the episode link (and its identifiers) from admin_source_list().
--
-- The admin table showed a title with no way to reach the thing it describes,
-- so checking "is this the episode I think it is?" meant leaving the page and
-- searching by hand. Requested by the product owner 2026-08-24.
--
-- `transcript_origin` comes along because it is now the most important thing
-- about a source that the table could not show: 'deepgram' rows carry speaker
-- labels and punctuation, 'other' rows are YouTube auto-captions with neither,
-- and which one a source has determines whether its claims can be attributed.
--
-- Deliberately still NOT selecting `transcript`: the whole reason this function
-- exists (migration 019) is that `select('*')` dragged ~42 MB of transcript text
-- through PostgREST on every page load and started tripping the statement
-- timeout. Every column added here must stay small.

-- DROP first: Postgres refuses to change an existing function's return type
-- with CREATE OR REPLACE ("cannot change return type of existing function"),
-- and this adds columns. Both statements run in one migration transaction, so
-- the admin page never observes the function missing.
drop function if exists public.admin_source_list();

create function public.admin_source_list()
returns table (
  id uuid,
  type text,
  title text,
  authors text[],
  date date,
  created_at timestamptz,
  processing_status text,
  transcript_quality text,
  transcript_origin text,
  media_duration_sec integer,
  url text,
  external_id text,
  episode_number int,
  word_count integer,
  insights_count bigint
)
language sql
stable
as $function$
  select
    s.id,
    s.type,
    s.title,
    s.authors,
    s.date,
    s.created_at,
    s.processing_status,
    s.transcript_quality,
    s.transcript_origin,
    s.media_duration_sec,
    -- Prefer the canonical page; fall back to the media link for the older
    -- YouTube-ingested rows, whose `url` and `media_url` are the same video.
    coalesce(s.url, s.media_url) as url,
    s.external_id,
    s.episode_number,
    coalesce(array_length(regexp_split_to_array(btrim(s.transcript), '\s+'), 1), 0)::int as word_count,
    coalesce(i.n, 0) as insights_count
  from sources s
  left join (
    select source_id, count(*) as n from raw_insights group by source_id
  ) i on i.source_id = s.id
  order by s.created_at desc;
$function$;
