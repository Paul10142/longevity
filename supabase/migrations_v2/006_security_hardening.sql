-- 006_security_hardening.sql
-- Fixes the Supabase security advisors (2026-07-21):
--   1. rls_disabled_in_public (ERROR) on all 16 v2 tables
--   2. function_search_path_mutable (WARN) on 8 functions
--   3. extension_in_public (WARN) for pgvector
--
-- All app access goes through the service-role client
-- (lib/supabaseServer.ts), which bypasses RLS. Enabling RLS with no
-- policies means anon/authenticated get zero access via PostgREST,
-- which is the intended posture: nothing in this schema is public.

-- 1. Enable RLS on every exposed table.
alter table public.sources enable row level security;
alter table public.chunks enable row level security;
alter table public.raw_insights enable row level security;
alter table public.claims enable row level security;
alter table public.claim_members enable row level security;
alter table public.claim_topics enable row level security;
alter table public.claim_references enable row level security;
alter table public.topics enable row level security;
alter table public.topic_articles enable row level security;
alter table public.topic_protocols enable row level security;
alter table public.references_ enable row level security;
alter table public.reference_mentions enable row level security;
alter table public.merge_reviews enable row level security;
alter table public.jobs enable row level security;
alter table public.cluster_jobs enable row level security;
alter table public.pipeline_runs enable row level security;

-- 2. Pin search_path so functions can't be hijacked by objects created
--    earlier in a caller's search_path. `extensions` is included so
--    pgvector operators still resolve after step 3.
alter function public.update_updated_at_column() set search_path = public, extensions;
alter function public.touch_updated_at() set search_path = public, extensions;
alter function public.claim_next_job() set search_path = public, extensions;
alter function public.match_claims(vector, double precision, integer) set search_path = public, extensions;
alter function public.match_references(vector, double precision, integer) set search_path = public, extensions;
alter function public.match_topics(vector, double precision, integer) set search_path = public, extensions;
alter function public.topic_claim_count(uuid) set search_path = public, extensions;
alter function public.topic_claims(uuid, text, integer, integer) set search_path = public, extensions;

-- 3. Move pgvector out of the public schema. Existing columns, indexes,
--    and function signatures keep working (types are bound by OID).
create schema if not exists extensions;
alter extension vector set schema extensions;
