-- 018_topic_visibility.sql
--
-- Manual curator override for the visibility gate ("existence vs. visibility",
-- BACKLOG §2a). The gate that ships today is READ-SIDE ONLY: a topic is hidden
-- from public readers when its subtree's active-claim count is below the
-- threshold in lib/topicVisibility.ts (VISIBILITY_MIN_CLAIMS). That needs no
-- schema change and is already live.
--
-- This column adds an ADDITIVE manual escape hatch on top of the automatic gate,
-- so a curator can force-hide a topic that has crossed the count threshold but
-- isn't ready to publish (e.g. contested, low-quality sources, or mid-review).
--
-- STRICTLY ADDITIVE — one nullable-by-default flag, migrates nothing, defaults to
-- the pre-migration behavior (nothing manually hidden). The read-side treats a
-- missing/false value as "not manually hidden", so applying this migration is a
-- no-op until a curator actually flips a row to true.
--
-- WIRING NOTE: lib/topicVisibility.ts already reads an optional `is_hidden` field
-- (isVisibleCount / visibleTopicIds), but the public read paths do NOT select the
-- column yet — deliberately, so those reads keep working while this migration is
-- unapplied. AFTER applying this migration, add `is_hidden` to the topic SELECTs
-- in app/api/topics/nav/route.ts, app/topics/page.tsx, and app/topics/[slug]/
-- page.tsx to honor the override; admin surfaces should keep showing hidden
-- topics regardless.

alter table topics
  add column if not exists is_hidden boolean not null default false;

comment on column topics.is_hidden is
  'Manual curator override for the public visibility gate. When true, the topic '
  'is hidden from public readers even if its subtree claim count is above '
  'VISIBILITY_MIN_CLAIMS. Automatic gating still applies independently; admins '
  'always see hidden topics. See lib/topicVisibility.ts.';
