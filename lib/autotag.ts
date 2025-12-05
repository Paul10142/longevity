import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import type { Insight } from './pipeline'
import type { Concept } from './types'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const AUTOTAG_SYSTEM_PROMPT = `
You are helping classify medical insights into topic categories for a lifestyle medicine knowledge base.

You will be given:
- An insight statement with metadata (evidence type, confidence, qualifiers, etc.)
- A list of available concepts (topics) with their names, slugs, and descriptions

Your job is to determine which concepts (0 or more) this insight belongs to.

Rules:
- An insight can belong to multiple concepts if it's relevant to multiple topics
- An insight can belong to zero concepts if it doesn't fit any existing category
- Only map to the provided concepts; do not suggest new concepts
- Be conservative: only tag if the insight is clearly relevant to the concept

Return ONLY valid JSON in this format:
{
  "concept_slugs": ["metabolic-health", "nutrition-diet"]
}

If the insight doesn't belong to any concept, return:
{
  "concept_slugs": []
}
`

export async function autoTagInsightToConcepts(
  insight: Insight,
  concepts: Concept[]
): Promise<{ conceptIds: string[] }> {
  try {
    // Build concept list for the prompt
    const conceptList = concepts.map(c => 
      `- ${c.name} (slug: ${c.slug}): ${c.description || 'No description'}`
    ).join('\n')

    const userPrompt = `Insight to classify:

Statement: ${insight.statement}
${insight.context_note ? `Context: ${insight.context_note}` : ''}
Evidence Type: ${insight.evidence_type}
Confidence: ${insight.confidence}
Insight Type: ${insight.insight_type || 'Explanation'}
${insight.qualifiers?.population ? `Population: ${insight.qualifiers.population}` : ''}
${insight.qualifiers?.dose ? `Dose: ${insight.qualifiers.dose}` : ''}
${insight.qualifiers?.duration ? `Duration: ${insight.qualifiers.duration}` : ''}

Available Concepts:
${conceptList}

Which concept slugs does this insight belong to?`

    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: AUTOTAG_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      // Note: gpt-5-mini only supports default temperature (1), custom values are not supported
      response_format: { type: 'json_object' }
    })

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

    // Map slugs to concept IDs
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
 * Auto-tag a single insight and insert links into insight_concepts
 */
export async function autoTagAndLinkInsight(insightId: string, insight: Insight): Promise<void> {
  if (!supabaseAdmin) {
    console.warn('Supabase admin not configured, skipping auto-tagging')
    return
  }

  try {
    // Fetch all concepts
    const { data: concepts, error: conceptsError } = await supabaseAdmin
      .from('concepts')
      .select('id, name, slug, description')

    if (conceptsError || !concepts || concepts.length === 0) {
      console.error('Error fetching concepts for auto-tagging:', conceptsError)
      return
    }

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
