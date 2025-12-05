import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import type { Insight } from './pipeline'
import type { Concept } from './types'

// Lazy initialization of OpenAI client to avoid errors during build when API key is not available
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

// Module-level cache for concepts (lasts for the lifetime of the process)
let cachedConcepts: Concept[] | null = null

/**
 * Get concepts with caching - fetches once, then reuses cached result
 */
export async function getConceptsCached(): Promise<Concept[]> {
  if (cachedConcepts) {
    return cachedConcepts
  }

  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  const { data: concepts, error: conceptsError } = await supabaseAdmin
    .from('concepts')
    .select('id, name, slug, description')

  if (conceptsError || !concepts || concepts.length === 0) {
    throw new Error(`Error fetching concepts: ${conceptsError?.message || 'No concepts found'}`)
  }

  cachedConcepts = concepts
  return concepts
}

const AUTOTAG_SYSTEM_PROMPT = `Classify medical insights into topic categories. Return JSON: {"concept_slugs": ["slug1", "slug2"]} or {"concept_slugs": []}. Tag only if clearly relevant. Multiple tags allowed.`

/**
 * Filter concepts by semantic relevance to an insight using keyword matching
 * Returns top N most relevant concepts to reduce token usage
 */
function filterRelevantConcepts(insight: Insight, concepts: Concept[], topN: number = 15): Concept[] {
  const insightText = `${insight.statement} ${insight.context_note || ''} ${insight.qualifiers?.population || ''} ${insight.qualifiers?.dose || ''} ${insight.qualifiers?.duration || ''}`.toLowerCase()
  
  // Score each concept based on keyword matches
  const scored = concepts.map(concept => {
    const conceptText = `${concept.name} ${concept.slug} ${concept.description || ''}`.toLowerCase()
    const keywords = conceptText.split(/\s+/).filter(w => w.length > 3) // Filter short words
    
    // Count keyword matches (case-insensitive)
    let score = 0
    for (const keyword of keywords) {
      if (insightText.includes(keyword)) {
        score += keyword.length // Longer matches = higher score
      }
    }
    
    // Boost score if concept name/slug appears directly
    if (insightText.includes(concept.name.toLowerCase()) || insightText.includes(concept.slug.toLowerCase())) {
      score += 50
    }
    
    return { concept, score }
  })
  
  // Sort by score and return top N
  const topConcepts = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(item => item.concept)
  
  // Always include at least top 10, or all if less than 10
  return topConcepts.length > 0 ? topConcepts : concepts.slice(0, Math.min(10, concepts.length))
}

/**
 * Retry helper for OpenAI API calls with exponential backoff
 * (Duplicated from pipeline.ts to avoid circular dependencies)
 */
async function callOpenAIWithRetry<T>(
  apiCall: () => Promise<T>,
  maxRetries: number = 2,
  label?: string
): Promise<T> {
  let lastError: any
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall()
    } catch (error: any) {
      lastError = error
      const errorStatus = error?.status
      const errorCode = error?.code
      
      // Fatal errors: don't retry
      if (errorStatus === 401 || errorStatus === 403 || errorCode === 'invalid_api_key' || errorCode === 'model_not_found') {
        throw error
      }
      
      // Retry on transient errors (429 rate limit, 5xx server errors)
      const isTransientError = errorStatus === 429 || 
                               errorStatus === 500 || 
                               errorStatus === 502 || 
                               errorStatus === 503 || 
                               errorStatus === 504 ||
                               errorCode === 'rate_limit_exceeded'
      
      if (isTransientError && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
        const logLabel = label ? `[${label}] ` : ''
        console.warn(`${logLabel}Transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${backoffMs}ms...`, {
          status: errorStatus,
          code: errorCode,
          message: error.message
        })
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        continue
      }
      
      // Not a transient error, or out of retries
      throw error
    }
  }
  
  throw lastError
}

/**
 * Auto-tag a single insight to concepts (optimized with concept filtering)
 */
export async function autoTagInsightToConcepts(
  insight: Insight,
  concepts: Concept[]
): Promise<{ conceptIds: string[] }> {
  try {
    // Filter to most relevant concepts (reduces token usage by ~80-90%)
    const relevantConcepts = filterRelevantConcepts(insight, concepts, 15)
    
    // Build compact concept list
    const conceptList = relevantConcepts.map(c => 
      `${c.slug}: ${c.name}${c.description ? ` - ${c.description}` : ''}`
    ).join('\n')

    const userPrompt = `Insight: ${insight.statement}${insight.context_note ? `\nContext: ${insight.context_note}` : ''}\nType: ${insight.insight_type || 'Explanation'}\n\nConcepts:\n${conceptList}\n\nWhich slugs apply?`

    // Use retry helper for OpenAI API call
    const completion = await callOpenAIWithRetry(
      () => getOpenAI().chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: AUTOTAG_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      }),
      2,
      'autotag'
    )

    const content = completion.choices[0]?.message?.content
    if (!content) {
      console.error('No content in OpenAI autotag response')
      return { conceptIds: [] }
    }

    const parsed = JSON.parse(content) as { concept_slugs: string[] }
    
    if (!parsed.concept_slugs || !Array.isArray(parsed.concept_slugs)) {
      console.error('Invalid autotag response format:', parsed)
      return { conceptIds: [] }
    }

    // Map slugs to concept IDs (check against full concept list, not just filtered)
    const conceptIds = parsed.concept_slugs
      .map(slug => concepts.find(c => c.slug === slug)?.id)
      .filter((id): id is string => id !== undefined)

    return { conceptIds }
  } catch (error) {
    console.error('Error in autoTagInsightToConcepts:', error)
    return { conceptIds: [] }
  }
}

/**
 * Auto-tag multiple insights in a single batch (optimized for token usage)
 * Processes 5-10 insights per API call to reduce system prompt overhead
 */
export async function autoTagInsightsBatch(
  insights: Array<{ insight: Insight; id: string }>,
  concepts: Concept[],
  batchSize: number = 8
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>()
  
  // Process in batches
  for (let i = 0; i < insights.length; i += batchSize) {
    const batch = insights.slice(i, i + batchSize)
    
    try {
      // Filter concepts once for the batch (use union of relevant concepts from all insights)
      const allRelevantConcepts = new Set<Concept>()
      for (const { insight } of batch) {
        const relevant = filterRelevantConcepts(insight, concepts, 15)
        relevant.forEach(c => allRelevantConcepts.add(c))
      }
      const relevantConceptsList = Array.from(allRelevantConcepts)
      
      // Build compact concept list
      const conceptList = relevantConceptsList.map(c => 
        `${c.slug}: ${c.name}${c.description ? ` - ${c.description}` : ''}`
      ).join('\n')
      
      // Build batch prompt
      const insightsList = batch.map((item, idx) => 
        `${idx + 1}. ${item.insight.statement}${item.insight.context_note ? ` [Context: ${item.insight.context_note}]` : ''}`
      ).join('\n\n')
      
      const userPrompt = `Classify these insights:\n\n${insightsList}\n\nAvailable concepts:\n${conceptList}\n\nReturn JSON: {"results": [{"index": 1, "concept_slugs": ["slug1"]}, {"index": 2, "concept_slugs": []}]}`

      const completion = await callOpenAIWithRetry(
        () => getOpenAI().chat.completions.create({
          model: 'gpt-5-mini',
          messages: [
            { role: 'system', content: AUTOTAG_SYSTEM_PROMPT + ' For batch processing, return {"results": [{"index": 1, "concept_slugs": [...]}, ...]} matching input order.' },
            { role: 'user', content: userPrompt }
          ],
          response_format: { type: 'json_object' }
        }),
        2,
        'autotag-batch'
      )

      const content = completion.choices[0]?.message?.content
      if (!content) {
        console.error('[autotag-batch] No content in response')
        // Mark all as having no tags
        batch.forEach(item => results.set(item.id, []))
        continue
      }

      const parsed = JSON.parse(content) as { results?: Array<{ index: number; concept_slugs: string[] }> }
      
      if (parsed.results && Array.isArray(parsed.results)) {
        // Map results back to insight IDs
        parsed.results.forEach((result) => {
          const batchIndex = result.index - 1
          const batchItem = batch[batchIndex]
          if (batchItem) {
            const conceptIds = (result.concept_slugs || [])
              .map(slug => concepts.find(c => c.slug === slug)?.id)
              .filter((id): id is string => id !== undefined)
            results.set(batchItem.id, conceptIds)
          }
        })
        
        // Ensure all batch items have results (in case some were missing from response)
        batch.forEach((item, idx) => {
          if (!results.has(item.id)) {
            console.warn(`[autotag-batch] Missing result for insight ${item.id} (index ${idx + 1}), marking as untagged`)
            results.set(item.id, [])
          }
        })
      } else {
        // Fallback: mark all as having no tags
        console.warn('[autotag-batch] Invalid response format, marking batch as untagged')
        batch.forEach(item => results.set(item.id, []))
      }
    } catch (error) {
      console.error(`[autotag-batch] Error processing batch ${i}-${i + batch.length}:`, error)
      // Mark batch as having no tags on error
      batch.forEach(item => results.set(item.id, []))
    }
  }
  
  return results
}

/**
 * Auto-tag a single insight and insert links into insight_concepts
 */
export async function autoTagAndLinkInsight(insightId: string, insight: Insight): Promise<void> {
  if (!supabaseAdmin) {
    console.warn('Supabase admin not configured, skipping auto-tagging')
    return
  }

  try {
    // Fetch concepts using cache
    const concepts = await getConceptsCached()

    // Auto-tag the insight
    const { conceptIds } = await autoTagInsightToConcepts(insight, concepts)

    if (conceptIds.length === 0) {
      console.log(`No concepts matched for insight ${insightId}`)
      return
    }

    // Insert links (ignore duplicates)
    const linksToInsert = conceptIds.map(conceptId => ({
      concept_id: conceptId,
      insight_id: insightId,
    }))

    const { error: insertError } = await supabaseAdmin
      .from('insight_concepts')
      .insert(linksToInsert)

    if (insertError) {
      // Might be duplicates, which is okay
      if (!insertError.message.includes('duplicate') && !insertError.message.includes('unique')) {
        console.error(`Error inserting auto-tags for insight ${insightId}:`, insertError)
      }
    } else {
      console.log(`Auto-tagged insight ${insightId} to ${conceptIds.length} concepts`)
    }
  } catch (error) {
    console.error(`Error auto-tagging insight ${insightId}:`, error)
    // Don't throw - auto-tagging failure shouldn't break the pipeline
  }
}
