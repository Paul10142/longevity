-- 017: stale_topics() subtree fix (BACKLOG §3a / §4 — HIGH)
--
-- Bug: stale_topics() (005.2) flagged a topic stale only on DIRECT new
-- claim_topics links to that topic. But a clinician article is built from the
-- RECURSIVE subtree — topic_claims() (003_evidence_layer.sql) walks
-- `WITH RECURSIVE tree` over active descendants and aggregates every claim under
-- them. So a claim filed under a CHILD topic never restaled the PARENT, whose
-- article then silently omitted it until a full regen.
--
-- Fix: compare each topic's snapshot against the claim set of its RECURSIVE
-- subtree, mirroring topic_claims()'s tree (root + active descendants) and its
-- `c.status = 'active'` filter. Return shape/signature are unchanged:
--   returns table (topic_id uuid, new_claims bigint).
--
-- Because a claim can link to several descendant topics, we count DISTINCT
-- claims. A claim with an old parent link plus a new child link is counted as
-- one "new" claim (its post-snapshot child link matches); that is deliberately
-- conservative — it can only over-flag staleness (an extra, safe regen), never
-- under-flag, which is the bug being fixed.
--
-- Apply via the Supabase SQL Editor. NOT applied by this worktree.

create or replace function stale_topics()
returns table (topic_id uuid, new_claims bigint)
language sql
stable
security definer
set search_path = public
as $$
  with recursive
  -- Transitive closure of the topic tree: one (root_id, node_id) row per
  -- (candidate topic, topic in its subtree). Roots are the same candidate set
  -- as before (not merged away); descendants mirror topic_claims()'s recursion
  -- (status = 'active').
  subtree(root_id, node_id) as (
    select t.id, t.id
      from topics t
     where t.merged_into_id is null
    union
    select st.root_id, c.id
      from subtree st
      join topics c on c.parent_id = st.node_id
     where c.status = 'active'
  ),
  snap as (
    select t.id as topic_id,
           (select max(ta.claims_snapshot_at)
              from topic_articles ta
             where ta.topic_id = t.id and ta.audience = 'clinician') as snapshot_at
      from topics t
     where t.merged_into_id is null
  )
  select s.topic_id, count(distinct ct.claim_id) as new_claims
    from snap s
    join subtree st on st.root_id = s.topic_id
    join claim_topics ct on ct.topic_id = st.node_id
    join claims c on c.id = ct.claim_id and c.status = 'active'
   where s.snapshot_at is not null
     and ct.created_at > s.snapshot_at
   group by s.topic_id
$$;
