-- 025b_admin_source_list_catalogue_columns.sql
--
-- RECORD OF A DEFINITION ALREADY LIVE — applying this is a no-op.
--
-- The live admin_source_list() (captured 2026-10-12 with pg_get_functiondef)
-- returns three columns that 025 does not — `series`, `youtube_url`,
-- `article_url` — falls back to media_url when url is null, and orders by
-- date instead of created_at. The Catalogue (app/admin/catalogue) and the
-- public episode links (lib/sourceLinks, PR #11) read youtube_url and
-- article_url from this rollup, so a database rebuilt from the checked-in
-- migrations alone would break them. When it was changed is not recorded;
-- 027's search_path pin is present on the live function, so this sits
-- between 025 and 027 in effect. Numbered 025b so the files still apply in
-- order on a fresh database.
--
-- `url` here is sources.url (or media_url): for podcast rows that is the
-- private, members-only feed link. Callers resolve public links from it on
-- the server (lib/sourceLinks) and never ship it to the browser.

create or replace function public.admin_source_list()
returns table (
  id uuid,
  type text,
  series text,
  title text,
  authors text[],
  date date,
  created_at timestamptz,
  processing_status text,
  transcript_quality text,
  transcript_origin text,
  media_duration_sec integer,
  url text,
  youtube_url text,
  article_url text,
  external_id text,
  episode_number int,
  word_count integer,
  insights_count bigint
)
language sql
stable
set search_path = public, extensions
as $function$
  select
    s.id,
    s.type,
    s.series,
    s.title,
    s.authors,
    s.date,
    s.created_at,
    s.processing_status,
    s.transcript_quality,
    s.transcript_origin,
    s.media_duration_sec,
    coalesce(s.url, s.media_url) as url,
    s.youtube_url,
    s.article_url,
    s.external_id,
    s.episode_number,
    coalesce(array_length(regexp_split_to_array(btrim(s.transcript), '\s+'), 1), 0)::int as word_count,
    coalesce(i.n, 0) as insights_count
  from sources s
  left join (
    select source_id, count(*) as n from raw_insights group by source_id
  ) i on i.source_id = s.id
  order by s.date desc nulls last, s.created_at desc;
$function$;
