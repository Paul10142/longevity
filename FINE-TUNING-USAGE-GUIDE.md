# Fine-Tuning Usage Guide

This guide explains how to use the fine-tuning system to train a model for automatic deduplication.

---

## Overview

The fine-tuning system allows you to:
1. **Export** manual merge decisions as training data
2. **Fine-tune** a model using OpenAI's API
3. **Deploy** the model for automatic deduplication
4. **Evaluate** model performance and iterate

---

## Step 1: Collect Training Data

### Manual Review Process

1. Process sources to create raw insights
2. Run clustering: `POST /api/admin/insights/cluster-all`
3. Review clusters in the admin dashboard
4. Approve merges for insights that should be combined
5. Reject clusters for insights that should remain separate

### Export Training Data

Once you have enough manual decisions (recommended: 50+ positive, 50+ negative):

```bash
# Export as OpenAI JSONL format (for fine-tuning)
curl http://localhost:3000/api/admin/insights/export-training-data?format=openai_jsonl > training-data.jsonl

# Export as custom JSON format (for analysis)
curl http://localhost:3000/api/admin/insights/export-training-data?format=json&stats=true > training-data.json
```

**Minimum Requirements:**
- At least 10 positive examples (approved merges)
- At least 10 negative examples (rejected clusters)
- More is better: aim for 100+ of each for good performance

---

## Step 2: Fine-Tune a Model

### Create Fine-Tuning Job

```bash
curl -X POST http://localhost:3000/api/admin/insights/fine-tune-model \
  -H "Content-Type: application/json" \
  -d '{
    "baseModel": "gpt-4o-mini-2024-07-18"
  }'
```

**Response:**
```json
{
  "success": true,
  "fineTuneJobId": "ftjob-abc123...",
  "trainingFileId": "file-xyz789...",
  "modelVersion": 1,
  "trainingDataStats": {
    "approved_merges": 45,
    "rejected_clusters": 32,
    "partial_merges": 12
  },
  "message": "Fine-tuning job created. Monitor progress at: https://platform.openai.com/finetune/ftjob-abc123..."
}
```

### Monitor Training Progress

```bash
# Check job status
curl "http://localhost:3000/api/admin/insights/fine-tune-model?jobId=ftjob-abc123..."
```

**Status Values:**
- `validating_files` - Validating training data
- `queued` - Waiting to start
- `running` - Training in progress
- `succeeded` - Training complete
- `failed` - Training failed (check error field)

**Training Time:**
- Small datasets (<1000 examples): ~5-10 minutes
- Medium datasets (1000-5000): ~15-30 minutes
- Large datasets (>5000): ~30-60 minutes

---

## Step 3: Activate the Model

Once training completes, activate the model:

```bash
# Get model status
curl http://localhost:3000/api/admin/insights/model-status

# Activate a model
curl -X POST http://localhost:3000/api/admin/insights/model-status \
  -H "Content-Type: application/json" \
  -d '{
    "modelId": "model-uuid-from-database",
    "action": "activate"
  }'
```

---

## Step 4: Integrate into Pipeline

### Option A: Automatic Merging (Recommended)

Modify `lib/pipeline.ts` to use the model during ingestion:

```typescript
// Around line 1226, before creating new insight:
import { checkForSemanticDuplicateWithModel } from './pipelineWithModel'

// Check for semantic duplicate using fine-tuned model
const duplicateCheck = await checkForSemanticDuplicateWithModel(
  insight,
  sourceId,
  chunk.locator
)

if (duplicateCheck.shouldMerge && duplicateCheck.existingInsightId) {
  // Link to existing insight instead of creating new
  const { error: linkError } = await supabaseAdmin
    .from('insight_sources')
    .insert({
      insight_id: duplicateCheck.existingInsightId,
      source_id: sourceId,
      run_id: runId,
      locator: chunk.locator
    })
  
  console.log(`[${chunk.locator}] ✓ Auto-merged with existing insight (confidence: ${duplicateCheck.confidence})`)
  continue // Skip creating new insight
}

// Otherwise, create new insight as normal...
```

### Option B: Assisted Clustering

Use the model to improve clustering quality:

```typescript
// In lib/clustering.ts, use model to filter clusters
import { predictMergeDecision } from './deduplicationModel'

// For each pair in cluster, check model prediction
const prediction = await predictMergeDecision(insight1, insight2, similarity)
if (prediction.shouldMerge && prediction.confidence > 0.90) {
  // High confidence - include in cluster
} else if (prediction.confidence < 0.70) {
  // Low confidence - exclude from cluster
}
```

---

## Step 5: Evaluate Model Performance

### Track Predictions

The system automatically records all model predictions in `model_predictions` table.

### Calculate Accuracy

```sql
-- Get accuracy for active model
SELECT 
  COUNT(*) as total_reviewed,
  SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) as correct,
  ROUND(100.0 * SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) / COUNT(*), 2) as accuracy_pct
FROM model_predictions
WHERE model_id = (SELECT id FROM deduplication_models WHERE is_active = true)
  AND actual_label IS NOT NULL;
```

### Review Misclassifications

```sql
-- Find incorrect predictions
SELECT 
  mp.id,
  i1.statement as insight1,
  i2.statement as insight2,
  mp.prediction,
  mp.actual_label,
  mp.confidence,
  mp.similarity_score
FROM model_predictions mp
JOIN insights i1 ON mp.insight1_id = i1.id
JOIN insights i2 ON mp.insight2_id = i2.id
WHERE mp.model_id = (SELECT id FROM deduplication_models WHERE is_active = true)
  AND mp.is_correct = false
  AND mp.actual_label IS NOT NULL
ORDER BY mp.confidence DESC;
```

---

## Continuous Learning

### Collect New Training Data

1. Process new sources
2. Review and merge clusters
3. Export updated training data
4. Fine-tune new model version
5. Compare performance with previous version
6. Activate if better

### Automated Re-training

Set up a scheduled job (weekly/monthly) to:
1. Export new training data
2. Fine-tune new model if enough new examples
3. Evaluate on held-out test set
4. Activate if accuracy improved

---

## Best Practices

### Training Data Quality

- **Balance:** Aim for roughly equal positive/negative examples
- **Diversity:** Include examples from different sources, topics, confidence levels
- **Edge Cases:** Include borderline cases (similarity 0.85-0.95)
- **Size:** More is better, but 100+ of each is a good starting point

### Model Selection

- **Start Conservative:** Use high confidence threshold (0.90+) initially
- **Monitor:** Track false positives/negatives
- **Iterate:** Adjust threshold based on performance
- **Version Control:** Keep track of which model version is active

### Performance Optimization

- **Caching:** Cache model predictions for identical pairs
- **Batching:** Process multiple predictions in parallel
- **Fallback:** Use embedding similarity if model unavailable
- **Rate Limiting:** Be mindful of OpenAI API rate limits

---

## Troubleshooting

### "No training data available"

**Solution:** Create manual merge decisions first:
1. Run clustering
2. Review and approve/reject clusters
3. Try export again

### "Insufficient training data"

**Solution:** Need at least 10 positive and 10 negative examples. Create more manual decisions.

### Model predictions seem wrong

**Solutions:**
1. Check if model is active: `GET /api/admin/insights/model-status`
2. Review training data quality
3. Fine-tune with more examples
4. Adjust confidence threshold

### Fine-tuning job failed

**Common Causes:**
- Invalid training data format
- Too few examples
- API rate limits
- Invalid base model

**Solution:** Check job status for error details, fix issues, retry.

---

## API Reference

### Export Training Data
- `GET /api/admin/insights/export-training-data?format=openai_jsonl|json&stats=true`

### Fine-Tune Model
- `POST /api/admin/insights/fine-tune-model` - Create fine-tuning job
- `GET /api/admin/insights/fine-tune-model?jobId=...` - Check job status

### Model Management
- `GET /api/admin/insights/model-status` - Get model status
- `POST /api/admin/insights/model-status` - Activate/deactivate model

---

## Next Steps

1. **Start Small:** Collect 50-100 manual decisions
2. **First Model:** Fine-tune and evaluate
3. **Iterate:** Collect feedback, retrain with more data
4. **Deploy:** Integrate into pipeline when confident
5. **Monitor:** Track performance, continue learning
