/**
 * Pipeline Integration with Fine-Tuned Model
 * 
 * This is an example of how to integrate the fine-tuned model into the pipeline
 * for automatic deduplication during ingestion.
 * 
 * NOTE: This is a reference implementation. Modify lib/pipeline.ts to integrate.
 */

import { supabaseAdmin } from './supabaseServer'
import { generateInsightEmbedding } from './embeddings'
import { predictMergeDecision } from './deduplicationModel'

/**
 * Check if a new insight should be merged with existing insights
 * Uses fine-tuned model for prediction
 * 
 * This function should be called in pipeline.ts after extracting an insight
 * but before creating a new raw insight row.
 */
export async function checkForSemanticDuplicateWithModel(
  newInsight: {
    statement: string
    context_note?: string | null
    confidence: string
    evidence_type: string
  },
  sourceId: string,
  locator: string
): Promise<{
  shouldMerge: boolean
  existingInsightId?: string
  confidence: number
  method: 'model' | 'similarity_fallback'
}> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Step 1: Generate embedding for new insight
  const embedding = await generateInsightEmbedding(newInsight)

  // Step 2: Find semantically similar insights using existing search
  const { data: similarInsights } = await supabaseAdmin.rpc('search_insights_semantic', {
    query_embedding: embedding,
    match_threshold: 0.80, // Lower threshold to catch more candidates
    match_count: 10 // Check top 10 similar insights
  })

  if (!similarInsights || similarInsights.length === 0) {
    return {
      shouldMerge: false,
      confidence: 0,
      method: 'similarity_fallback'
    }
  }

  // Step 3: For each similar insight, use fine-tuned model to predict merge decision
  let bestMatch: {
    insightId: string
    confidence: number
    shouldMerge: boolean
  } | null = null

  for (const similar of similarInsights) {
    // Fetch full insight details
    const { data: existingInsight } = await supabaseAdmin
      .from('insights')
      .select('statement, context_note, confidence, evidence_type')
      .eq('id', similar.id)
      .single()

    if (!existingInsight) {
      continue
    }

    // Use fine-tuned model to predict
    const prediction = await predictMergeDecision(
      newInsight,
      existingInsight,
      similar.similarity
    )

    // Track the best match (highest confidence merge prediction)
    if (prediction.shouldMerge && prediction.confidence > (bestMatch?.confidence || 0)) {
      bestMatch = {
        insightId: similar.id,
        confidence: prediction.confidence,
        shouldMerge: true
      }
    }
  }

  // Step 4: Return result
  if (bestMatch && bestMatch.confidence >= 0.85) {
    // High confidence: auto-merge
    return {
      shouldMerge: true,
      existingInsightId: bestMatch.insightId,
      confidence: bestMatch.confidence,
      method: 'model'
    }
  } else if (bestMatch && bestMatch.confidence >= 0.70) {
    // Medium confidence: could merge, but might want manual review
    // For now, we'll merge but log it
    return {
      shouldMerge: true,
      existingInsightId: bestMatch.insightId,
      confidence: bestMatch.confidence,
      method: 'model'
    }
  } else {
    // Low confidence or no match: don't merge
    return {
      shouldMerge: false,
      confidence: bestMatch?.confidence || 0,
      method: 'model'
    }
  }
}

/**
 * Record model prediction for evaluation
 */
export async function recordModelPrediction(
  modelId: string,
  insight1Id: string,
  insight2Id: string,
  prediction: 'MERGE' | "DON'T_MERGE",
  confidence: number,
  similarityScore?: number
): Promise<void> {
  if (!supabaseAdmin) {
    return
  }

  await supabaseAdmin
    .from('model_predictions')
    .insert({
      model_id: modelId,
      insight1_id: insight1Id,
      insight2_id: insight2Id,
      prediction,
      confidence,
      similarity_score: similarityScore
    })
}

/**
 * Update model prediction with actual label (from manual review)
 */
export async function updateModelPredictionWithLabel(
  predictionId: string,
  actualLabel: 'MERGE' | "DON'T_MERGE",
  reviewedBy?: string
): Promise<void> {
  if (!supabaseAdmin) {
    return
  }

  // Get the prediction to check if it was correct
  const { data: prediction } = await supabaseAdmin
    .from('model_predictions')
    .select('prediction')
    .eq('id', predictionId)
    .single()

  const isCorrect = prediction?.prediction === actualLabel

  await supabaseAdmin
    .from('model_predictions')
    .update({
      actual_label: actualLabel,
      is_correct: isCorrect,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy
    })
    .eq('id', predictionId)
}
