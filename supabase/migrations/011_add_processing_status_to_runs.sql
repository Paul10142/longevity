-- Migration: Add 'processing' status to source_processing_runs
-- Allows tracking runs that are in progress

ALTER TABLE source_processing_runs
  DROP CONSTRAINT IF EXISTS source_processing_runs_status_check;

ALTER TABLE source_processing_runs
  ADD CONSTRAINT source_processing_runs_status_check 
  CHECK (status IN ('processing', 'success', 'failed'));

