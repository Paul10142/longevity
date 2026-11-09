-- 040_anecdote_corpus_exclusion.sql
--
-- STATUS: NOT APPLIED. Apply via the Supabase SQL Editor (LifestyleAcademy project) BEFORE the
-- code that sets the flag is deployed. Brief lock only: a NOT NULL column with a constant
-- default is a metadata change in Postgres 11+, and the partial index starts empty.
--
-- Anecdote handling (Paul, 2026-11-08): extraction keeps each personal anecdote ("I take
-- magnesium at night"), labels it insight_type = 'Anecdote' and phrases it as a report of what
-- the speaker did or saw, but an anecdote is held OUTSIDE the corpus: it must never become a
-- claim or a claim member, so it never reaches articles or Ask the Library.
--
--   raw_insights.corpus_excluded   true  = never consolidated (the extraction insert sets it
--                                          when the kind is Anecdote; consolidateSource drops
--                                          these rows from `pending`)
--                                  false = normal, consolidated as before (the default)
--
-- The partial index serves "show me the anecdotes" listings; it holds only the excluded rows.
-- Reversible: set corpus_excluded back to false and the next consolidation drain picks the row up.
--
-- NO BACKFILL. The ~178 anecdotes already inside claims (from the old v1 prompt) are a separate
-- decision for Paul; this migration does not touch any existing row's value.
--
-- Idempotent: safe to run twice.

ALTER TABLE raw_insights
  ADD COLUMN IF NOT EXISTS corpus_excluded boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_raw_insights_corpus_excluded
  ON raw_insights (source_id)
  WHERE corpus_excluded;
