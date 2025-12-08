# Fine-Tuning Implementation Plan for Automatic Deduplication

**Goal:** Use manual merge decisions to train a model that can automatically determine if two insights should be merged.

---

## Architecture Overview

### Current State
- Manual merge decisions stored in `merge_clusters` (status: approved/rejected)
- Similarity scores stored in `merge_cluster_members`
- Selected/unselected flags indicate which insights were merged

### Target State
1. **Training Data Collection:** Export merge decisions as labeled examples
2. **Fine-Tuning Pipeline:** Train a model on the labeled data
3. **Inference System:** Use fine-tuned model during ingestion to make merge decisions
4. **Continuous Learning:** Keep collecting new manual decisions to improve the model

---

## Phase 1: Training Data Collection

### Data Structure

**Positive Examples (Should Merge):**
- Pairs of insights that were merged (from approved clusters)
- Includes: statements, similarity scores, metadata

**Negative Examples (Should NOT Merge):**
- Pairs from rejected clusters
- Pairs that were in same cluster but not selected together
- Random pairs with low similarity (hard negatives)

### Implementation

**1. Export Training Data API**

Create `/api/admin/insights/export-training-data` that exports:
- All approved merge decisions
- All rejected merge decisions  
- Selected vs unselected pairs from approved clusters
- Metadata: similarity scores, confidence, evidence_type, etc.

**2. Training Data Format**

For OpenAI fine-tuning (JSONL format):
```json
{"messages": [
  {"role": "system", "content": "You are an expert at determining if two medical insights express the same idea, even if worded differently."},
  {"role": "user", "content": "Insight 1: {statement1}\nInsight 2: {statement2}\nSimilarity Score: {similarity}\nMetadata: {metadata}"},
  {"role": "assistant", "content": "MERGE" or "DON'T MERGE"}
]}
```

For custom model (CSV/JSON):
```json
{
  "insight1": "...",
  "insight2": "...",
  "similarity": 0.92,
  "should_merge": true,
  "reasoning": "Both express the same mechanism with different wording",
  "metadata": {
    "confidence1": "high",
    "confidence2": "medium",
    "evidence_type1": "RCT",
    "evidence_type2": "ExpertOpinion"
  }
}
```

---

## Phase 2: Fine-Tuning Pipeline

### Option A: OpenAI Fine-Tuning (Recommended for Start)

**Advantages:**
- Easy to implement
- Good performance out of the box
- Handles JSONL format natively

**Implementation:**
1. Convert training data to OpenAI fine-tuning format
2. Upload to OpenAI
3. Create fine-tuning job
4. Monitor training progress
5. Deploy fine-tuned model

### Option B: Custom Model (For Future)

**Advantages:**
- Full control
- Can optimize for specific use case
- Potentially lower cost at scale

**Implementation:**
- Use transformer model (e.g., BERT, RoBERTa)
- Fine-tune on merge decision dataset
- Deploy via API or edge function

---

## Phase 3: Inference System

### Integration Points

**1. During Ingestion (Pipeline)**
- After extracting insight, check against existing insights
- Use fine-tuned model to predict if should merge
- If prediction is "MERGE" with high confidence → auto-merge
- If uncertain → create cluster for manual review

**2. During Clustering**
- Use fine-tuned model to score pairs
- Adjust similarity threshold based on model confidence
- Filter clusters based on model predictions

### Confidence Thresholds

- **High Confidence (>0.95):** Auto-merge immediately
- **Medium Confidence (0.85-0.95):** Create cluster, mark as "high priority"
- **Low Confidence (<0.85):** Create cluster, mark as "needs review"

---

## Phase 4: Continuous Learning

### Feedback Loop

1. **Collect New Decisions:** Every manual merge/reject becomes new training data
2. **Periodic Re-training:** Weekly/monthly fine-tuning with new data
3. **A/B Testing:** Compare model performance vs manual decisions
4. **Model Versioning:** Track which model version is in use

---

## Implementation Steps

### Step 1: Training Data Export (Priority 1)

**File:** `lib/trainingDataExport.ts`
**API:** `/api/admin/insights/export-training-data`

**Features:**
- Export approved merges (positive examples)
- Export rejected clusters (negative examples)
- Export partial merges (selected vs unselected)
- Include metadata (similarity, confidence, evidence_type)
- Format: JSONL for OpenAI, JSON for custom models

### Step 2: Fine-Tuning Service (Priority 2)

**File:** `lib/fineTuning.ts`
**API:** `/api/admin/insights/fine-tune-model`

**Features:**
- Convert training data to fine-tuning format
- Upload to OpenAI (or custom training service)
- Create fine-tuning job
- Monitor progress
- Store model ID/version in database

### Step 3: Inference Service (Priority 3)

**File:** `lib/deduplicationModel.ts`
**API:** Used internally by pipeline

**Features:**
- Load fine-tuned model
- Predict merge decision for insight pairs
- Return confidence score
- Cache predictions for performance

### Step 4: Pipeline Integration (Priority 4)

**File:** `lib/pipeline.ts` (modify)

**Features:**
- After extracting insight, check against existing
- Use model to predict merge decision
- Auto-merge if high confidence
- Create cluster if uncertain

### Step 5: Model Management (Priority 5)

**Database Table:** `deduplication_models`

**Fields:**
- id, model_id (OpenAI fine-tuned model ID)
- version, training_data_count
- accuracy_metrics, created_at
- is_active (which model is currently in use)

---

## Database Schema Additions

```sql
-- Track fine-tuned models
CREATE TABLE deduplication_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id text NOT NULL, -- OpenAI fine-tuned model ID
  version int NOT NULL,
  training_data_count int NOT NULL,
  positive_examples int,
  negative_examples int,
  accuracy_metrics jsonb,
  created_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT false,
  UNIQUE(model_id)
);

-- Track training data exports
CREATE TABLE training_data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_date timestamptz DEFAULT now(),
  positive_examples int,
  negative_examples int,
  format text, -- 'openai_jsonl', 'custom_json', etc.
  file_path text,
  model_version int REFERENCES deduplication_models(version)
);

-- Track model predictions (for evaluation)
CREATE TABLE model_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid REFERENCES deduplication_models(id),
  insight1_id uuid REFERENCES insights(id),
  insight2_id uuid REFERENCES insights(id),
  prediction text, -- 'MERGE' or 'DON'T_MERGE'
  confidence numeric,
  actual_label text, -- 'MERGE' or 'DON'T_MERGE' (from manual decision)
  is_correct boolean,
  created_at timestamptz DEFAULT now()
);
```

---

## Next Steps

1. **Implement training data export** - Start collecting labeled data
2. **Create initial training dataset** - Export existing manual decisions
3. **Fine-tune first model** - Use OpenAI fine-tuning API
4. **Evaluate model** - Test on held-out manual decisions
5. **Integrate into pipeline** - Start using model for predictions
6. **Monitor and iterate** - Collect feedback, retrain

---

## Success Metrics

- **Accuracy:** Model predictions match manual decisions (>90%)
- **Coverage:** Model can make confident predictions for >80% of pairs
- **Time Savings:** Reduce manual review by 50%+
- **Quality:** No increase in false merges vs manual process
