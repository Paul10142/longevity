/**
 * Dynamic Concept Discovery System
 * 
 * Automatically discovers and creates new concepts from insights during source processing
 * Uses semantic matching to avoid duplicate concepts
 */

import { supabaseAdmin } from './supabaseServer'
import { generateEmbedding, generateConceptEmbedding } from './embeddings'
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

const CONCEPT_EXTRACTION_PROMPT = `You are analyzing medical insights to identify potential topic concepts.

For each insight, extract 1-3 potential topic keywords or phrases that could be used as concept names.

Return JSON: {"concepts": ["concept1", "concept2", "concept3"]}

Examples:
- "Insulin sensitivity protocols" → ["Insulin Sensitivity", "Metabolic Health"]
- "Sleep optimization strategies" → ["Sleep Optimization", "Circadian Health"]
- "Cardiovascular disease prevention" → ["Cardiovascular Health", "Heart Disease Prevention"]

Only extract concepts that are clearly medical/health topics. Return empty array if no clear concepts found.`

/**
 * Extract potential concepts from a batch of insights
 */
async function extractConceptsFromInsights(insights: Array<{ statement: string; context_note?: string | null }>): Promise<string[]> {
  if (insights.length === 0) return []

  try {
    const insightsText = insights
      .map((insight, idx) => `${idx + 1}. ${insight.statement}${insight.context_note ? ` [Context: ${insight.context_note}]` : ''}`)
      .join('\n\n')

    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: CONCEPT_EXTRACTION_PROMPT },
        { role: 'user', content: `Extract concepts from these insights:\n\n${insightsText}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })

    const content = completion.choices[0]?.message?.content
    if (!content) return []

    const parsed = JSON.parse(content) as { concepts?: string[] }
    return parsed.concepts || []
  } catch (error) {
    console.error('Error extracting concepts:', error)
    return []
  }
}

/**
 * Find similar concepts using semantic matching
 * Returns concepts with similarity > threshold
 */
async function findSimilarConcepts(
  conceptName: string,
  threshold: number = 0.85
): Promise<Array<{ id: string; name: string; similarity: number }>> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Generate embedding for concept name
  const conceptEmbedding = await generateEmbedding(conceptName)

  // Query concepts with embeddings
  const { data: concepts } = await supabaseAdmin
    .from('concepts')
    .select('id, name, embedding')
    .not('embedding', 'is', null)

  if (!concepts || concepts.length === 0) {
    return []
  }

  // Calculate similarity for each concept
  const similar: Array<{ id: string; name: string; similarity: number }> = []

  for (const concept of concepts) {
    if (!concept.embedding) continue

    // Calculate cosine similarity: 1 - (embedding <=> query_embedding)
    // Using pgvector distance operator (<=>) which is cosine distance
    // We need to calculate this in JavaScript since we can't use RPC here
    const similarity = cosineSimilarity(conceptEmbedding, concept.embedding as number[])

    if (similarity > threshold) {
      similar.push({
        id: concept.id,
        name: concept.name,
        similarity,
      })
    }
  }

  // Sort by similarity (descending)
  similar.sort((a, b) => b.similarity - a.similarity)

  return similar
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length')
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

/**
 * Create a concept if it doesn't already exist (semantic matching)
 * Returns the concept ID (existing or newly created)
 */
export async function createConceptIfNew(
  conceptName: string,
  description: string,
  sourceId: string
): Promise<{ id: string; isNew: boolean }> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Check for similar concepts
  const similar = await findSimilarConcepts(conceptName, 0.85)

  if (similar.length > 0) {
    // Similar concept exists, return existing
    console.log(`[Concept Discovery] Found similar concept "${similar[0].name}" (similarity: ${similar[0].similarity.toFixed(2)}) for "${conceptName}"`)
    return { id: similar[0].id, isNew: false }
  }

  // Create new concept
  const slug = conceptName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  // Check if slug already exists (exact match)
  const { data: existing } = await supabaseAdmin
    .from('concepts')
    .select('id')
    .eq('slug', slug)
    .single()

  if (existing) {
    return { id: existing.id, isNew: false }
  }

  // Generate embedding for new concept
  const embedding = await generateConceptEmbedding({ name: conceptName, description })

  // Insert new concept
  const { data: newConcept, error } = await supabaseAdmin
    .from('concepts')
    .insert({
      name: conceptName,
      slug,
      description,
      auto_created: true,
      needs_review: true,
      created_from_source_id: sourceId,
      embedding,
    })
    .select('id')
    .single()

  if (error || !newConcept) {
    throw new Error(`Failed to create concept: ${error?.message}`)
  }

  console.log(`[Concept Discovery] Created new concept "${conceptName}" (slug: ${slug})`)
  return { id: newConcept.id, isNew: true }
}

/**
 * Discover and create concepts from insights for a source
 * Runs as a background job after source processing
 */
export async function discoverConceptsFromSource(sourceId: string): Promise<{
  processed: number
  created: number
  linked: number
}> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Fetch source
  const { data: source } = await supabaseAdmin
    .from('sources')
    .select('id, title')
    .eq('id', sourceId)
    .single()

  if (!source) {
    throw new Error(`Source not found: ${sourceId}`)
  }

  // Fetch insights from this source (recently created, not yet tagged)
  const { data: insightsData } = await supabaseAdmin
    .from('insight_sources')
    .select(`
      insight_id,
      insights (
        id,
        statement,
        context_note
      )
    `)
    .eq('source_id', sourceId)

  if (!insightsData || insightsData.length === 0) {
    return { processed: 0, created: 0, linked: 0 }
  }

  const insights = insightsData
    .map((item: any) => item.insights)
    .filter(Boolean) as Array<{ id: string; statement: string; context_note?: string | null }>

  // Process in batches of 10 insights
  const batchSize = 10
  let processed = 0
  let created = 0
  let linked = 0

  for (let i = 0; i < insights.length; i += batchSize) {
    const batch = insights.slice(i, i + batchSize)

    // Extract concepts from batch
    const conceptNames = await extractConceptsFromInsights(batch)
    const uniqueConceptNames = Array.from(new Set(conceptNames))

    // Create concepts and link to insights
    for (const conceptName of uniqueConceptNames) {
      if (!conceptName || conceptName.trim().length === 0) continue

      try {
        const { id: conceptId, isNew } = await createConceptIfNew(
          conceptName.trim(),
          `Auto-detected from source: ${source.title}`,
          sourceId
        )

        if (isNew) {
          created++
        }

        // Link all insights in batch to this concept
        const insightIds = batch.map(insight => insight.id)
        const links = insightIds.map(insightId => ({
          insight_id: insightId,
          concept_id: conceptId,
        }))

        const { error: linkError } = await supabaseAdmin
          .from('insight_concepts')
          .upsert(links, { onConflict: 'insight_id,concept_id' })

        if (!linkError) {
          linked += links.length
        }

        processed++
      } catch (error) {
        console.error(`Error processing concept "${conceptName}":`, error)
      }
    }
  }

  console.log(`[Concept Discovery] Processed ${processed} concepts, created ${created} new, linked ${linked} insights`)
  return { processed, created, linked }
}

