-- Migration: Add missing indexes for insight queries
-- Improves performance for sorting and filtering insights

CREATE INDEX IF NOT EXISTS insights_importance_idx ON insights (importance DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS insights_actionability_idx ON insights (actionability);
CREATE INDEX IF NOT EXISTS insights_evidence_type_idx ON insights (evidence_type);

-- Add comment for documentation
COMMENT ON INDEX insights_importance_idx IS 'Index for sorting insights by importance (used in prioritization and evidence tab)';
COMMENT ON INDEX insights_actionability_idx IS 'Index for filtering insights by actionability';
COMMENT ON INDEX insights_evidence_type_idx IS 'Index for filtering insights by evidence type';
