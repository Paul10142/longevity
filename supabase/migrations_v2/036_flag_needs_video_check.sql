-- 036_flag_needs_video_check.sql
--
-- STATUS: NOT APPLIED. Apply via the Supabase SQL Editor (LifestyleAcademy project).
--
-- The flagged-claim review screen (/admin/flags) gains a fourth choice besides
-- Approve As Is / Reject / Edit and Approve: "Needs Video Check", for a claim that
-- depends on something only visible on screen (a slide, a chart, a demonstration).
--
-- Nothing is decided by that choice: the flag stays OPEN (resolved_at stays NULL)
-- and the claim stays hidden (claims.status = 'flagged'). This column only records
-- WHEN the reviewer parked it, so the screen can list those flags separately. When
-- the reviewer later watches the clip and rules, the flag closes as usual.
--
-- STRICTLY ADDITIVE: one nullable column and one partial index. The screen works
-- before this is applied (it falls back to the old column list); only the
-- Needs Video Check button reports "migration 036 has not been applied".
--
-- Resolution vocabulary is unchanged: the screen uses existing values only
--   Approve As Is  -> false_positive (claim goes back to active)
--   Reject         -> approved       (flag was right; claim stays hidden)
--   Edit/Approve   -> reworded       (new wording saved; claim goes back to active)

alter table claim_flags add column if not exists needs_video_check_at timestamptz;

create index if not exists claim_flags_video_check_idx
  on claim_flags (needs_video_check_at)
  where resolved_at is null and needs_video_check_at is not null;

comment on column claim_flags.needs_video_check_at is
  'When a reviewer parked this open flag as needing the video (something only visible on screen). NULL = not parked. The flag stays open and the claim stays hidden until it is ruled on.';
