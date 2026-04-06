#!/bin/bash
# Model Update Script
# Run this after collecting manual merge decisions to fine-tune a new model

set -e  # Exit on error

BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_MODEL="${BASE_MODEL:-gpt-4o-mini-2024-07-18}"

echo "🚀 Starting Model Update Process"
echo "================================"
echo ""

# Step 1: Check current training data stats
echo "📊 Step 1: Checking training data availability..."
STATS_RESPONSE=$(curl -s "${BASE_URL}/api/admin/insights/export-training-data?format=json&stats=true")
POSITIVE=$(echo "$STATS_RESPONSE" | jq -r '.stats.approved_merges // 0')
NEGATIVE=$(echo "$STATS_RESPONSE" | jq -r '.stats.rejected_clusters // 0')
TOTAL=$(echo "$STATS_RESPONSE" | jq -r '.total_examples // 0')

echo "   Found: $POSITIVE positive examples, $NEGATIVE negative examples ($TOTAL total)"

if [ "$POSITIVE" -lt 10 ] || [ "$NEGATIVE" -lt 10 ]; then
  echo "   ❌ Insufficient training data!"
  echo "   Need at least 10 positive and 10 negative examples"
  echo "   Current: $POSITIVE positive, $NEGATIVE negative"
  exit 1
fi

if [ "$POSITIVE" -lt 50 ] || [ "$NEGATIVE" -lt 50 ]; then
  echo "   ⚠️  Warning: Less than 50 examples of each type"
  echo "   Model may not perform well. Consider collecting more data."
  read -p "   Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Step 2: Export training data
echo ""
echo "📤 Step 2: Exporting training data..."
EXPORT_FILE="training-data-$(date +%Y%m%d-%H%M%S).jsonl"
curl -s "${BASE_URL}/api/admin/insights/export-training-data?format=openai_jsonl" \
  -o "$EXPORT_FILE"

LINE_COUNT=$(wc -l < "$EXPORT_FILE")
echo "   ✅ Exported $LINE_COUNT examples to $EXPORT_FILE"

# Step 3: Create fine-tuning job
echo ""
echo "🎯 Step 3: Creating fine-tuning job..."
JOB_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/admin/insights/fine-tune-model" \
  -H "Content-Type: application/json" \
  -d "{\"baseModel\": \"$BASE_MODEL\"}")

SUCCESS=$(echo "$JOB_RESPONSE" | jq -r '.success // false')
if [ "$SUCCESS" != "true" ]; then
  echo "   ❌ Failed to create fine-tuning job"
  echo "$JOB_RESPONSE" | jq '.'
  exit 1
fi

JOB_ID=$(echo "$JOB_RESPONSE" | jq -r '.fineTuneJobId')
VERSION=$(echo "$JOB_RESPONSE" | jq -r '.modelVersion')
TRAINING_FILE=$(echo "$JOB_RESPONSE" | jq -r '.trainingFileId')

echo "   ✅ Fine-tuning job created!"
echo "   Job ID: $JOB_ID"
echo "   Model Version: $VERSION"
echo "   Training File: $TRAINING_FILE"
echo ""
echo "   📊 Training Data Stats:"
echo "$JOB_RESPONSE" | jq '.trainingDataStats'

# Step 4: Monitor job status
echo ""
echo "⏳ Step 4: Monitoring training progress..."
echo "   Job URL: https://platform.openai.com/finetune/$JOB_ID"
echo ""
echo "   Checking status (this may take 10-30 minutes)..."
echo "   Press Ctrl+C to stop monitoring (job will continue in background)"
echo ""

PREVIOUS_STATUS=""
while true; do
  STATUS_RESPONSE=$(curl -s "${BASE_URL}/api/admin/insights/fine-tune-model?jobId=$JOB_ID")
  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
  FINE_TUNED_MODEL=$(echo "$STATUS_RESPONSE" | jq -r '.fineTunedModel // "N/A"')
  
  if [ "$STATUS" != "$PREVIOUS_STATUS" ]; then
    echo "   Status: $STATUS"
    if [ "$FINE_TUNED_MODEL" != "N/A" ] && [ "$FINE_TUNED_MODEL" != "null" ]; then
      echo "   Fine-tuned Model: $FINE_TUNED_MODEL"
    fi
    
    if [ "$STATUS" == "failed" ]; then
      ERROR=$(echo "$STATUS_RESPONSE" | jq -r '.error // "Unknown error"')
      echo "   ❌ Training failed: $ERROR"
      exit 1
    fi
    
    if [ "$STATUS" == "succeeded" ]; then
      echo ""
      echo "   ✅ Training completed successfully!"
      echo "   Fine-tuned Model ID: $FINE_TUNED_MODEL"
      break
    fi
  fi
  
  PREVIOUS_STATUS="$STATUS"
  sleep 30  # Check every 30 seconds
done

# Step 5: Get model database ID
echo ""
echo "🔍 Step 5: Getting model database record..."
MODEL_STATUS=$(curl -s "${BASE_URL}/api/admin/insights/model-status")
MODEL_DB_ID=$(echo "$MODEL_STATUS" | jq -r ".allModels[] | select(.version == $VERSION) | .id")

if [ -z "$MODEL_DB_ID" ] || [ "$MODEL_DB_ID" == "null" ]; then
  echo "   ⚠️  Could not find model in database"
  echo "   You may need to activate it manually"
  echo "   Model version: $VERSION"
  exit 0
fi

echo "   ✅ Found model record: $MODEL_DB_ID"

# Step 6: Ask about activation
echo ""
read -p "🤔 Step 6: Activate this model now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "   Activating model..."
  ACTIVATE_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/admin/insights/model-status" \
    -H "Content-Type: application/json" \
    -d "{\"modelId\": \"$MODEL_DB_ID\", \"action\": \"activate\"}")
  
  SUCCESS=$(echo "$ACTIVATE_RESPONSE" | jq -r '.success // false')
  if [ "$SUCCESS" == "true" ]; then
    echo "   ✅ Model activated successfully!"
  else
    echo "   ❌ Failed to activate model"
    echo "$ACTIVATE_RESPONSE" | jq '.'
  fi
else
  echo "   ⏭️  Skipping activation. Activate later with:"
  echo "   curl -X POST ${BASE_URL}/api/admin/insights/model-status \\"
  echo "     -H 'Content-Type: application/json' \\"
  echo "     -d '{\"modelId\": \"$MODEL_DB_ID\", \"action\": \"activate\"}'"
fi

echo ""
echo "✅ Model update process complete!"
echo ""
echo "📝 Summary:"
echo "   - Training data: $EXPORT_FILE ($LINE_COUNT examples)"
echo "   - Fine-tuning job: $JOB_ID"
echo "   - Model version: $VERSION"
echo "   - Fine-tuned model: $FINE_TUNED_MODEL"
if [ "$SUCCESS" == "true" ]; then
  echo "   - Status: ✅ Activated"
else
  echo "   - Status: ⏸️  Not activated (activate manually)"
fi



