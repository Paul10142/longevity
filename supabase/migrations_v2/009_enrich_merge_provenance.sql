-- 009_enrich_merge_provenance.sql
--
-- Enrich-merge provenance (v4 spec §6, "Enrich-merge").
--
-- STATUS: NOT APPLIED. Written for Paul to review and apply via the Supabase SQL
-- Editor. Nothing in lib/ depends on this column yet — `enrichClaimCanonical`
-- updates only `canonical_statement`/`needs_tagging`, so the code runs unchanged
-- whether or not this migration has been applied.
--
-- WHY: enrich-merge is recommended to run as a SEPARATE, batchable, checkpointed
-- pass (not inline in the hot consolidation loop). Such a sweep needs to know
-- which claims it has already enriched so it is idempotent and resumable. This
-- column is that marker; the sweep stamps `enriched_at = now()` after a claim's
-- canonical is (re)synthesised, and selects `WHERE member_count > 1 AND
-- (enriched_at IS NULL OR enriched_at < updated_at)` to find work.
--
-- Once applied, wire the stamp into `enrichClaimCanonical` (set enriched_at on a
-- successful/attempted rewrite) and add the sweep entry point.

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

COMMENT ON COLUMN claims.enriched_at IS
  'When enrich-merge last (re)synthesised this claim''s canonical_statement from its members. NULL = never enriched. Used by the batched enrich-merge sweep for idempotent/resumable selection.';

-- Optional: index the "needs enriching" predicate for the sweep at scale.
CREATE INDEX IF NOT EXISTS claims_enrich_pending_idx
  ON claims (enriched_at)
  WHERE status = 'active';
