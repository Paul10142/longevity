-- 038_skipped_duplicate_sources.sql
--
-- STATUS: NOT APPLIED. Apply via the Supabase SQL Editor (LifestyleAcademy project),
-- and only when no batch run is writing (it takes a brief lock on `sources`).
--
-- Re-posted podcast episodes (rebroadcasts, re-releases, 30-minute "Essentials"
-- cuts, a second feed title for one recording) must never be transcribed or
-- extracted again. The feed ingest and scripts/dedupLibrary.ts mark such a row
-- instead of deleting it, so the feed never re-creates it:
--
--   processing_status = 'skipped'   every picker ignores it (it is not 'pending')
--   duplicate_of                    the copy of the episode we keep, when there is one
--   skip_reason                     why, in words the admin page shows
--                                   (e.g. 'rebroadcast of #183')
--
-- STRICTLY ADDITIVE for existing rows: two nullable columns, one wider CHECK, two
-- small partial indexes. Nothing is rewritten, no row changes value.
--
-- The original CHECK came from supabase/migrations/009 and was created inline, so
-- its name is whatever Postgres generated. The block below finds every CHECK on
-- public.sources that mentions processing_status, drops it, and adds a named one
-- that also allows 'skipped'. Safe to run twice.

alter table public.sources
  add column if not exists duplicate_of uuid references public.sources(id) on delete set null,
  add column if not exists skip_reason  text;

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.sources'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%processing_status%'
  loop
    execute format('alter table public.sources drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.sources
  add constraint sources_processing_status_check
  check (processing_status in ('pending', 'processing', 'succeeded', 'failed', 'skipped'));

-- Which rows copy which: the admin page and the cleanup both walk this link.
create index if not exists sources_duplicate_of_idx
  on public.sources (duplicate_of)
  where duplicate_of is not null;

-- The admin "skipped episodes" list reads only skipped rows.
create index if not exists sources_skipped_idx
  on public.sources (created_at desc)
  where processing_status = 'skipped';

comment on column public.sources.duplicate_of is
  'The source this row is a re-post or copy of (the copy we keep). Null for a row that is not a duplicate, and for a re-post whose original is not in the library.';
comment on column public.sources.skip_reason is
  'Why processing_status = ''skipped'': e.g. ''rebroadcast of #183'', ''re-cut (Essentials) of <title>'', ''same episode as <id> (<rule>)''.';
