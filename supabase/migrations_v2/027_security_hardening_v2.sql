-- 027_security_hardening_v2.sql
-- Closes the Supabase security-advisor findings of 2026-09-15 AND fixes the
-- reason they keep coming back.
--
-- ROOT CAUSE. Supabase ships an ALTER DEFAULT PRIVILEGES rule on `public` that
-- grants `anon` and `authenticated` full arwdDxtm on every newly created table.
-- 006_security_hardening enabled RLS on the 16 tables that existed at the time,
-- by name. Every table created after it inherited those grants with no RLS
-- behind them:
--   * topic_proposals  (007) -- empty, but anon could INSERT/UPDATE/DELETE
--   * fidelity_labels  (021) -- 40 human gold labels, anon could read and write
--
-- Verified live against the production REST API with the publishable key
-- immediately before this migration:
--   GET  /rest/v1/fidelity_labels  -> returned every row
--   POST /rest/v1/rpc/stale_topics -> returned topic ids + claim counts
--   GET  /rest/v1/claims           -> [] (RLS working, as designed)
--
-- POSTURE. Nothing in the app uses the publishable (anon) key:
-- lib/supabaseClient.ts is imported by no module, and every page, API route
-- and script goes through lib/supabaseServer.ts (service_role, which has
-- BYPASSRLS). So anon and authenticated should hold no privilege whatsoever in
-- this database. Listing tables by name is what failed last time, so every step
-- below is written as a catch-all that stays correct as tables are added, and
-- the whole file is safe to re-run.

-- 1. RLS on every public table that is missing it (fidelity_labels,
--    topic_proposals today; anything added later if this is ever re-run).
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    raise notice 'enabled RLS on public.%', t.relname;
  end loop;
end $$;

-- 2. Strip the inherited anon/authenticated grants. RLS with no policy already
--    denies these roles; removing the grant as well means a table that somehow
--    reaches production without RLS is still unreachable. service_role and the
--    postgres owner are untouched.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- 3. Same for PUBLIC, which is how anon inherited EXECUTE on every function
--    (this is what exposed rpc/stale_topics). EXECUTE on a trigger function is
--    checked at CREATE TRIGGER time, not when the trigger fires, so the
--    updated_at triggers are unaffected.
revoke all on all functions in schema public from public;

-- 4. THE DURABLE FIX: stop new objects being granted to anon/authenticated in
--    the first place, so migration 034 cannot reopen this hole by accident.
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from public;

-- 5. stale_topics() has no reason to be SECURITY DEFINER: its only caller is
--    lib/worker.ts through the service-role client, which bypasses RLS anyway.
--    As DEFINER it ran with the owner's rights for whoever could reach it,
--    which is what let an anon REST call read topic ids and claim counts.
alter function public.stale_topics() security invoker;

-- 6. Pin admin_source_list()'s search_path, the one function 006 missed
--    (it was added later, in 019). Without this, an object created earlier in
--    a caller's search_path can shadow the tables it reads.
alter function public.admin_source_list() set search_path = public, extensions;

-- 7. Belt and braces on the two tables this migration is really about: make
--    the grant removal explicit rather than relying on the catch-all above, so
--    the intent survives a future `grant ... on all tables` run by hand.
revoke all on public.fidelity_labels from anon, authenticated;
revoke all on public.topic_proposals from anon, authenticated;

-- 8. Step 3 revoked EXECUTE from PUBLIC, which also stripped it from
--    `supabase_read_only_user` -- the internal role behind the dashboard's
--    read-only SQL editor and the MCP tooling. Give it back: it is read-only
--    (default_transaction_read_only=on), internal, and not reachable from the
--    internet, unlike anon/authenticated. Applied as a follow-up migration
--    (security_hardening_v2_readonly_role) on the live DB.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
    execute 'grant execute on all functions in schema public to supabase_read_only_user';
    execute 'alter default privileges for role postgres in schema public grant execute on functions to supabase_read_only_user';
  end if;
end $$;

-- VERIFIED AFTER APPLYING (2026-09-15):
--   * advisor: rls_disabled_in_public ERROR gone; function_search_path_mutable
--     and both *_security_definer_function_executable WARNs gone. The remaining
--     rls_enabled_no_policy INFO on 20 tables is the intended posture -- this
--     database has no public surface, so "RLS on, zero policies" is correct.
--   * anon REST: SELECT/INSERT on fidelity_labels, DELETE on topic_proposals,
--     rpc/stale_topics and rpc/admin_source_list all return 42501 permission denied.
--   * service_role REST: reads, writes, the updated_at trigger, stale_topics,
--     admin_source_list, database_size_bytes and topic_claim_count all still work.
--   * catalogue: 0 public tables without RLS, 0 tables granted to
--     anon/authenticated, 0 functions executable by anon/authenticated.
