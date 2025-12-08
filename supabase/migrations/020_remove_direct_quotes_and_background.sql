-- Migration: Remove direct quote fields and Background actionability option
-- Maps existing Background values to Low, drops direct quote columns, updates constraint

-- Step 1: Map existing 'Background' actionability values to 'Low'
UPDATE insights
SET actionability = 'Low'
WHERE actionability = 'Background';

-- Step 2: Drop direct quote columns
ALTER TABLE insights
  DROP COLUMN IF EXISTS has_direct_quote,
  DROP COLUMN IF EXISTS direct_quote;

-- Step 3: Update actionability CHECK constraint to remove 'Background'
-- First, drop the existing constraint
ALTER TABLE insights
  DROP CONSTRAINT IF EXISTS insights_actionability_check;

-- Recreate constraint without 'Background'
ALTER TABLE insights
  ADD CONSTRAINT insights_actionability_check 
  CHECK (actionability IN ('Low','Medium','High'));

-- Add comment for documentation
COMMENT ON COLUMN insights.actionability IS 'Actionability level: Low (conceptual background), Medium (influences reasoning), High (directly guides decisions). Background values have been migrated to Low.';
