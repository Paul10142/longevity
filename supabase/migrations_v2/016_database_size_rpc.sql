-- 016 — database_size_bytes(): read-only helper for the extraction supervisor's
-- storage safety brake. On the Supabase free plan the DB locks to read-only at
-- 500 MB, which would halt the pipeline; overnightExtract.ts polls this each
-- round and stops with headroom (default --max-mb 460). Additive, read-only.
create or replace function public.database_size_bytes()
returns bigint
language sql
stable
set search_path to 'public', 'extensions'
as $$ select pg_database_size(current_database()) $$;
