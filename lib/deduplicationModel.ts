/**
 * Deduplication Model Inference
 * 
 * Uses fine-tuned model to predict if two insights should be merged
 */

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'

// Lazy initialization
let openaiInstance: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('Missing OPENAI_API_KEY environment variable')
    }
    openaiInstance = new OpenAI({ apiKey })
  }
  return openaiInstance
}

/**
 * Get the active fine-tuned model ID from database
 */
async function getActiveModelId(): Promise<string | null> {
  if (!supabaseAdmin) {
    return null
  }

  const { data: model, error } = await supabaseAdmin
    .from('deduplication_models')
    .select('model_id')
    .eq('is_active', true)
    .single()

  if (error || !model) {
    return null
  }

  return model.model_id
}

/**
 * Predict if two insights should be merged using fine-tuned model
 * 
 * @param insight1 First insight
 * @param insight2 Second insight
 * @param similarityScore Optional embedding similarity score
 * @returns Prediction with confidence
 */
export async function predictMergeDecision(
  insight1: {
    statement: string
    context_note?: string | null
    confidence: string
    evidence_type: string
  },
  insight2: {
    statement: string
    context_note?: string | null
    confidence: string
    evidence_type: string
  },
  similarityScore?: number
): Promise<{
  shouldMerge: boolean
  confidence: number
  reasoning?: string
}> {
  const modelId = await getActiveModelId()

  // If no fine-tuned model, fall back to embedding similarity
  if (!modelId) {
    console.warn('[Deduplication Model] No active fine-tuned model, using similarity threshold')
    const shouldMerge = similarityScore !== undefined && similarityScore >= 0.90
    return {
      shouldMerge,
      confidence: similarityScore || 0.5,
      reasoning: 'Using embedding similarity (no fine-tuned model available)'
    }
  }

  try {
    const openai = getOpenAI()

    const systemPrompt = "You are an expert at determining if two medical insights express the same idea, even if worded differently. Consider the core meaning, not just the exact words."

    const userPrompt = `Insight 1: ${insight1.statement}${insight1.context_note ? `\nContext: ${insight1.context_note}` : ''}\nConfidence: ${insight1.confidence}\nEvidence: ${insight1.evidence_type}\n\nInsight 2: ${insight2.statement}${insight2.context_note ? `\nContext: ${insight2.context_note}` : ''}\nConfidence: ${insight2.confidence}\nEvidence: ${insight2.evidence_type}${similarityScore ? `\nSimilarity Score: ${similarityScore.toFixed(3)}` : ''}\n\nShould these insights be merged into one?`

    const completion = await openai.chat.completions.create({
      model: modelId, // Use fine-tuned model
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.1, // Low temperature for consistent predictions
      max_tokens: 100
    })

    const response = completion.choices[0]?.message?.content || ''
    const shouldMerge = response.toUpperCase().includes('MERGE') && !response.toUpperCase().includes("DON'T")

    // Extract confidence from logprobs if available
    let confidence = 0.5
    if (completion.choices[0]?.logprobs) {
      // Calculate confidence from logprobs
      const logprobs = completion.choices[0].logprobs
      // Check for token_logprobs array (OpenAI API structure)
      const tokenLogprobs = (logprobs as any).token_logprobs
      if (Array.isArray(tokenLogprobs) && tokenLogprobs.length > 0) {
        // Average logprob as confidence proxy
        const avgLogprob = tokenLogprobs.reduce((a: number, b: number | null) => a + (b || 0), 0) / tokenLogprobs.length
        confidence = Math.min(1, Math.max(0, (avgLogprob + 5) / 10)) // Normalize to 0-1
      }
    } else if (similarityScore !== undefined) {
      // Fall back to similarity score as confidence
      confidence = similarityScore
    }

    return {
      shouldMerge,
      confidence,
      reasoning: response
    }
  } catch (error) {
    console.error('[Deduplication Model] Error calling fine-tuned model:', error)
    
    // Fall back to similarity-based decision
    const shouldMerge = similarityScore !== undefined && similarityScore >= 0.90
    return {
      shouldMerge,
      confidence: similarityScore || 0.5,
      reasoning: `Model error, using similarity fallback: ${error instanceof Error ? error.message : 'Unknown error'}`
    }
  }
}

/**
 * Batch predict merge decisions for multiple pairs
 */
export async function batchPredictMergeDecisions(
  pairs: Array<{
    insight1: {
      statement: string
      context_note?: string | null
      confidence: string
      evidence_type: string
    }
    insight2: {
      statement: string
      context_note?: string | null
      confidence: string
      evidence_type: string
    }
    similarityScore?: number
  }>
): Promise<Array<{
  shouldMerge: boolean
  confidence: number
  reasoning?: string
}>> {
  // Process in parallel (with rate limiting consideration)
  const batchSize = 10 // Process 10 at a time to avoid rate limits
  const results: Array<{ shouldMerge: boolean; confidence: number; reasoning?: string }> = []

  for (let i = 0; i < pairs.length; i += batchSize) {
    const batch = pairs.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(pair => predictMergeDecision(pair.insight1, pair.insight2, pair.similarityScore))
    )
    results.push(...batchResults)

    // Small delay between batches to avoid rate limits
    if (i + batchSize < pairs.length) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  return results
}
