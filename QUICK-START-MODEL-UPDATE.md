# Quick Start: Model Update Guide

## What Can Be Done NOW (Before Any Merges)

### ✅ Run Database Migration (Do This First)

**File:** `supabase/migrations/026_add_deduplication_model_tables.sql`

**Action:** Run this SQL in your Supabase SQL Editor

**Why now:** Creates the infrastructure tables. No data needed - just sets up the system.

**Verification:**
```sql
-- Check if tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('deduplication_models', 'training_data_exports', 'model_predictions');
```

**That's it for now!** Everything else waits until you have merge decisions.

---

## What Must Wait (After You Make Merge Decisions)

### ❌ Export Training Data
**Requires:** At least 10 approved merges AND 10 rejected clusters

### ❌ Fine-Tune Model  
**Requires:** Training data (which requires merge decisions)

### ❌ Activate Model
**Requires:** Completed fine-tuning job

---

## Future: When You Say "Update the Model"

**After you've collected merge decisions, just say:**

> "Update the model with my latest merge decisions"

**I will automatically:**

1. ✅ Check if you have enough data (10+ of each type)
2. ✅ Export all your manual merge decisions as training data
3. ✅ Create a fine-tuning job with OpenAI
4. ✅ Monitor the training until it completes
5. ✅ Get the new model ID
6. ✅ Activate the new model (or ask you first)

**Or you can run the script yourself:**
```bash
./scripts/update-model.sh
```

---

## What I Need to Know (For Future Updates)

**When you say "update the model", I'll:**

1. **Check training data:**
   ```bash
   curl "http://localhost:3000/api/admin/insights/export-training-data?format=json&stats=true"
   ```
   - If < 10 positive or < 10 negative → tell you to collect more
   - If enough → proceed

2. **Export training data:**
   ```bash
   curl "http://localhost:3000/api/admin/insights/export-training-data?format=openai_jsonl"
   ```

3. **Create fine-tuning job:**
   ```bash
   curl -X POST "http://localhost:3000/api/admin/insights/fine-tune-model" \
     -H "Content-Type: application/json" \
     -d '{"baseModel": "gpt-4o-mini-2024-07-18"}'
   ```

4. **Monitor until complete:**
   ```bash
   # Check status every 30 seconds until status = "succeeded"
   curl "http://localhost:3000/api/admin/insights/fine-tune-model?jobId=..."
   ```

5. **Activate model:**
   ```bash
   curl -X POST "http://localhost:3000/api/admin/insights/model-status" \
     -H "Content-Type: application/json" \
     -d '{"modelId": "...", "action": "activate"}'
   ```

---

## Summary

**NOW (Before merges):**
- ✅ Run migration `026_add_deduplication_model_tables.sql`
- ❌ Everything else waits

**LATER (After merges):**
- Just say "update the model" and I'll handle it
- Or run `./scripts/update-model.sh`

**The system automatically:**
- Extracts training data from your merge decisions
- No manual labeling needed
- Your approve/reject actions = training examples

---

## Files Created

1. **MODEL-UPDATE-INSTRUCTIONS.md** - Detailed step-by-step guide
2. **scripts/update-model.sh** - Automated update script
3. **QUICK-START-MODEL-UPDATE.md** - This file (quick reference)

**All you need to remember:**
- Run the migration now
- Make merge decisions (your normal workflow)
- Say "update the model" when ready



