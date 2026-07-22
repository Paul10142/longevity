/**
 * Embeddings Generation System
 * 
 * Generates vector embeddings for raw insights and claims using OpenAI's
 * embedding API. Enables semantic search and `match_claims` / `match_topics`.
 */

import OpenAI from 'openai'

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
 * Generate embeddings for many texts in one API call.
 * Preserves input order; the OpenAI API allows up to 2048 inputs per request,
 * we stay well under that with per-call batches.
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const cleaned = texts.map(t => (t && t.trim().length > 0 ? t.trim() : ' '))

  const openai = getOpenAI()
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: cleaned,
  })

  if (!response.data || response.data.length !== cleaned.length) {
    throw new Error(`Embedding batch size mismatch: sent ${cleaned.length}, got ${response.data?.length ?? 0}`)
  }

  // API returns items with an index field; sort defensively to preserve order
  return [...response.data].sort((a, b) => a.index - b.index).map(d => d.embedding)
}

/**
 * Text used to embed an insight or claim: statement + context note.
 */
export function insightEmbeddingText(item: { statement: string; context_note?: string | null }): string {
  return `${item.statement}${item.context_note ? ` ${item.context_note}` : ''}`
}




