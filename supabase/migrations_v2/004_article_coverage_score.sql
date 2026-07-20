-- 004: article coverage score
-- Coverage = fraction of a topic's input claims actually cited in the generated
-- clinician article. Physician-grade comprehensiveness (ARCHITECTURE.md "v3.1
-- target spec") requires ~100%; storing it makes any drop measurable and
-- queryable. Applied via Supabase MCP on 2026-07-20.

alter table topic_articles add column if not exists coverage_score numeric;
