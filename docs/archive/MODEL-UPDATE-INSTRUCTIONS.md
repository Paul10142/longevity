# Model Update Instructions

**Purpose:** Clear instructions for updating the fine-tuned deduplication model after collecting more manual merge decisions.

---

## What Can Be Done NOW (Before Any Merges)

### ✅ Run Database Migration

**Status:** Can do immediately - no merge decisions needed

**Action:**
```sql
-- Run this migration in Supabase SQL Editor
-- File: supabase/migrations/026_add_deduplication_model_tables.sql
```

**What it does:**
- Creates tables to track models, training exports, and predictions
- No data required - just sets up infrastructure

**Verification:**
```sql
-- Check tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('deduplication_models', 'training_data_exports', 'model_predictions');
```

---

## What Must Wait (After Merge Decisions)

### ❌ Export Training Data
**Requires:** At least 10 approved merges AND 10 rejected clusters

### ❌ Fine-Tune Model
**Requires:** Training data export (which requires merge decisions)

### ❌ Activate Model
**Requires:** Completed fine-tuning job

---

## Model Update Workflow (For Future)

**When to run:** After collecting 50+ new manual merge decisions (or weekly/monthly)

### Step 1: Verify You Have Enough Data

```bash
# Check current training data stats
curl "http://localhost:3000/api/admin/insights/export-training-data?format=json&stats=true" | jq '.stats'
```

**Minimum Requirements:**
- At least 10 positive examples (approved merges)
- At least 10 negative examples (rejected clusters)
- **Recommended:** 50+ of each for good model performance

### Step 2: Export Training Data

```bash
# Export as OpenAI JSONL format
curl "http://localhost:3000/api/admin/insights/export-training-data?format=openai_jsonl" \
  -o "training-data-$(date +%Y%m%d).jsonl"

# Verify export
wc -l training-data-*.jsonl  # Should show number of examples
```

**What this does:**
- Automatically extracts ALL manual merge decisions (old + new)
- Converts to OpenAI fine-tuning format
- Includes: approved merges, rejected clusters, partial merges

### Step 3: Create Fine-Tuning Job

```bash
# Create new fine-tuning job
curl -X POST "http://localhost:3000/api/admin/insights/fine-tune-model" \
  -H "Content-Type: application/json" \
  -d '{
    "baseModel": "gpt-4o-mini-2024-07-18"
  }' | jq '.'
```

**Save the response:**
- `fineTuneJobId` - needed to check status
- `modelVersion` - tracks which version this is

**Expected Response:**
```json
{
  "success": true,
  "fineTuneJobId": "ftjob-abc123...",
  "trainingFileId": "file-xyz789...",
  "modelVersion": 2,
  "trainingDataStats": {
    "approved_merges": 87,
    "rejected_clusters": 45,
    "partial_merges": 23
  }
}
```

### Step 4: Monitor Training Progress

```bash
# Replace JOB_ID with the fineTuneJobId from Step 3
JOB_ID="ftjob-abc123..."

# Check status (run this periodically)
curl "http://localhost:3000/api/admin/insights/fine-tune-model?jobId=$JOB_ID" | jq '.status'

# Or check in OpenAI dashboard:
# https://platform.openai.com/finetune/$JOB_ID
```

**Status Values:**
- `validating_files` → `queued` → `running` → `succeeded` ✅
- If `failed`, check the `error` field

**Typical Timeline:**
- Small dataset (<1000 examples): 5-10 minutes
- Medium dataset (1000-5000): 15-30 minutes
- Large dataset (>5000): 30-60 minutes

### Step 5: Get Model ID After Completion

Once status is `succeeded`:

```bash
# Get the fine-tuned model ID
curl "http://localhost:3000/api/admin/insights/fine-tune-model?jobId=$JOB_ID" | jq '.fineTunedModel'
```

**Save this:** You'll need it to activate the model.

### Step 6: Check Current Model Status

```bash
# See what models exist and which is active
curl "http://localhost:3000/api/admin/insights/model-status" | jq '.'
```

**Response shows:**
- `activeModel` - currently active model (if any)
- `allModels` - all model versions
- `predictionStats` - accuracy metrics for active model

### Step 7: Evaluate New Model (Optional but Recommended)

Before activating, check if new model is better:

```bash
# Get model record ID from database
# (Use the modelVersion from Step 3, or check model-status response)

# Query predictions for new model
# (This requires some manual testing or evaluation set)
```

**Compare:**
- Accuracy of new model vs old model
- False positive/negative rates
- Confidence distributions

### Step 8: Activate New Model

```bash
# Get model database ID from model-status response
MODEL_DB_ID="uuid-from-database"

# Activate the new model
curl -X POST "http://localhost:3000/api/admin/insights/model-status" \
  -H "Content-Type: application/json" \
  -d "{
    \"modelId\": \"$MODEL_DB_ID\",
    \"action\": \"activate\"
  }"
```

**What this does:**
- Deactivates old model (if any)
- Activates new model
- New predictions will use this model

### Step 9: Verify Activation

```bash
# Check that new model is active
curl "http://localhost:3000/api/admin/insights/model-status" | jq '.activeModel'
```

Should show the new model as `is_active: true`.

---

## Quick Reference: One-Line Update Script

**For future use - run this after collecting merge decisions:**

```bash
#!/bin/bash
# Model Update Script

echo "Step 1: Exporting training data..."
curl "http://localhost:3000/api/admin/insights/export-training-data?format=openai_jsonl" \
  -o "training-data-$(date +%Y%m%d).jsonl"

echo "Step 2: Creating fine-tuning job..."
RESPONSE=$(curl -s -X POST "http://localhost:3000/api/admin/insights/fine-tune-model" \
  -H "Content-Type: application/json" \
  -d '{"baseModel": "gpt-4o-mini-2024-07-18"}')

JOB_ID=$(echo $RESPONSE | jq -r '.fineTuneJobId')
echo "Job ID: $JOB_ID"
echo "Monitor at: https://platform.openai.com/finetune/$JOB_ID"

echo "Step 3: Waiting for training to complete..."
echo "Check status with: curl 'http://localhost:3000/api/admin/insights/fine-tune-model?jobId=$JOB_ID'"
```

---

## Checklist for Model Update

**Before starting:**
- [ ] Have at least 10 approved merges
- [ ] Have at least 10 rejected clusters
- [ ] (Recommended) Have 50+ of each

**Update process:**
- [ ] Export training data
- [ ] Verify export has sufficient examples
- [ ] Create fine-tuning job
- [ ] Save job ID
- [ ] Monitor until status = "succeeded"
- [ ] Get fine-tuned model ID
- [ ] (Optional) Evaluate model performance
- [ ] Activate new model
- [ ] Verify activation

---

## Troubleshooting

### "No training data available"
**Cause:** No merge decisions yet  
**Solution:** Review and approve/reject clusters first

### "Insufficient training data"
**Cause:** Less than 10 positive or 10 negative examples  
**Solution:** Create more manual merge decisions

### Fine-tuning job failed
**Cause:** Check the error field in job status  
**Common issues:**
- Invalid training data format
- Too few examples
- API rate limits
- Invalid base model

**Solution:** Fix the issue and retry

### Model not making good predictions
**Solutions:**
1. Collect more training data (aim for 100+ of each)
2. Review training data quality
3. Adjust confidence thresholds
4. Retrain with more diverse examples

---

## Notes for AI Assistant

**When user says "update the model":**

1. Check if migration has been run (query `deduplication_models` table)
2. Export training data and check stats
3. If sufficient data (>10 of each), create fine-tuning job
4. Monitor job until complete
5. Get model ID and activate
6. Verify activation

**Key commands to remember:**
- Export: `GET /api/admin/insights/export-training-data?format=json&stats=true`
- Create job: `POST /api/admin/insights/fine-tune-model`
- Check status: `GET /api/admin/insights/fine-tune-model?jobId=...`
- Activate: `POST /api/admin/insights/model-status` with `action: "activate"`



