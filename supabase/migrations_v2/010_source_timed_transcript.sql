-- 010_source_timed_transcript.sql
--
-- STATUS: NOT APPLIED
-- Apply manually via the Supabase SQL Editor when Paul gives the go for the
-- Phase 1 timestamp demonstration (docs/v4-build-risks-and-cost.md §D Phase 1).
-- Until applied, the pipeline degrades gracefully: extraction falls back to a
-- select without this column and simply produces no per-chunk / per-insight
-- timing (identical to today's behaviour). Nothing breaks pre-migration.
--
-- WHY A NEW COLUMN (decision, 2026-07-23):
--   `sources` already carries the flat `transcript` (text) but has no home for
--   per-caption timing. The YouTube Transcript API returns each caption as
--   { text, start, duration }; we were joining to text and discarding the clock
--   (fetch route :109-111). To carry timing through chunk.start_ms /
--   raw_insight.start_ms we must persist the timed segments alongside the
--   transcript. A JSONB column on `sources` (not a new table) is the smallest
--   change: the segments are read once, whole, at extraction time — there is no
--   query pattern that would benefit from a normalised segments table, and the
--   1:1 source→segments relationship belongs with the source row.
--
-- SHAPE: an ordered array of caption segments, timing already normalised to ms:
--   [{ "text": "...", "start_ms": 5000, "end_ms": 9000 }, ...]
-- Only YouTube (and any future timed-caption) ingests populate it. The four
-- manual-paste seed sources leave it NULL and are unaffected.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS timed_transcript jsonb;

COMMENT ON COLUMN sources.timed_transcript IS
  'Ordered timed caption segments [{text,start_ms,end_ms}] for sources that '
  'carry timing (e.g. YouTube). NULL for manual/pasted transcripts. Read once '
  'at extraction to stamp chunks.start_ms/end_ms and raw_insights.start_ms/end_ms.';
