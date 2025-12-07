/**
 * Embeddings Generation System
 * 
 * Generates vector embeddings for insights and concepts using OpenAI's embedding API
 * Enables semantic search and concept matching
 */

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'

// Lazy initialization of OpenAI client
let openaiInstance: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('Missing credentials. Please pass an `apiKey`, or set the `OPENAI_API_KEY` environment variable.')
    }
    openaiInstance = new OpenAI({
      apiKey,
    })
  }
  return openaiInstance
}

/**
 * Generate embedding for a text string
 * Uses OpenAI text-embedding-3-small (1536 dimensions, cost-effective)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty')
  }

  const openai = getOpenAI()
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.trim(),
  })

  if (!response.data || response.data.length === 0) {
    throw new Error('No embedding returned from OpenAI')
  }

  return response.data[0].embedding
}

/**
 * Generate embedding for an insight
 * Combines statement and context_note for better semantic representation
 */
export async function generateInsightEmbedding(insight: {
  statement: string
  context_note?: string | null
}): Promise<number[]> {
  const text = `${insight.statement}${insight.context_note ? ` ${insight.context_note}` : ''}`
  return generateEmbedding(text)
}

/**
 * Generate embedding for a concept
 * Combines name and description for better semantic representation
 */
export async function generateConceptEmbedding(concept: {
  name: string
  description?: string | null
}): Promise<number[]> {
  const text = `${concept.name}${concept.description ? ` ${concept.description}` : ''}`
  return generateEmbedding(text)
}

/**
 * Generate and store embedding for an insight
 */
export async function generateAndStoreInsightEmbedding(insightId: string): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Fetch insight
  const { data: insight, error: fetchError } = await supabaseAdmin
    .from('insights')
    .select('id, statement, context_note')
    .eq('id', insightId)
    .single()

  if (fetchError || !insight) {
    throw new Error(`Insight not found: ${fetchError?.message}`)
  }

  // Generate embedding
  const embedding = await generateInsightEmbedding(insight)

  // Store embedding
  const { error: updateError } = await supabaseAdmin
    .from('insights')
    .update({ embedding })
    .eq('id', insightId)

  if (updateError) {
    throw new Error(`Failed to store embedding: ${updateError.message}`)
  }
}

/**
 * Generate and store embedding for a concept
 */
export async function generateAndStoreConceptEmbedding(conceptId: string): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Fetch concept
  const { data: concept, error: fetchError } = await supabaseAdmin
    .from('concepts')
    .select('id, name, description')
    .eq('id', conceptId)
    .single()

  if (fetchError || !concept) {
    throw new Error(`Concept not found: ${fetchError?.message}`)
  }

  // Generate embedding
  const embedding = await generateConceptEmbedding(concept)

  // Store embedding
  const { error: updateError } = await supabaseAdmin
    .from('concepts')
    .update({ embedding })
    .eq('id', conceptId)

  if (updateError) {
    throw new Error(`Failed to store embedding: ${updateError.message}`)
  }
}

