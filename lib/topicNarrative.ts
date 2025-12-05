import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import type { Concept, TopicArticle } from './types'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const CLINICIAN_SYSTEM_PROMPT = `
You are assisting a physician building an up-to-date lifestyle medicine reference.

You are given:
- A specific topic (concept name + description)
- A set of highly detailed "insights" extracted from transcripts. Each insight is a small, precise statement with evidence tags and qualifiers.

Your job is to write a clinician-level topic article with:

Sections:
1. Overview
2. Key Mechanisms & Pathophysiology
3. Practical Protocols & Implementation
4. Risks, Caveats & Contraindications
5. Controversies & Areas of Uncertainty

Rules:
- Use ONLY the provided insights as your factual source. Do not introduce new factual claims not supported by the insights.
- Integrate the insights into a coherent narrative, grouping related insights together.
- Use numbered lists (1. 2. 3.) for sequential steps, protocols, or ordered actions.
- Use bullet points (-) for non-ordered items, options, or parallel actions.
- Lists MUST start on a new line with a blank line before them. Each list item must be on its own line.
- Preserve important numeric details, dose ranges, frequencies, lab thresholds, time frames, and population qualifiers.
- Be explicit about the strength of evidence and confidence when relevant.
- Write in clear, professional prose appropriate for physicians and advanced trainees.
- Do not cite studies by name; instead refer to them generically (e.g., "randomized trials", "cohort studies").
- Do not mention the existence of "insights" or "chunks" or transcripts; just write the article.
- Do NOT include a large title heading (H1 with #) - start directly with section content.

Output JSON with this shape:
{
  "title": "string",
  "sections": [
    {
      "id": "overview" | "mechanisms" | "protocols" | "risks" | "controversies",
      "title": "string",
      "paragraphs": [
        {
          "id": "p1",
          "text": "full paragraph text",
          "insight_ids": ["uuid-1", "uuid-2"]
        }
      ]
    }
  ]
}

- Make sure every paragraph includes an insight_ids array listing the IDs of the insights you primarily relied on for that paragraph.
- It is okay if some insights are not used; it is also okay if some paragraphs use multiple insights.
- Total length should be roughly 1200–2500 words, depending on how much information is available.
`

const PATIENT_SYSTEM_PROMPT = `
You are assisting a physician building an up-to-date lifestyle medicine reference for patients.

You are given:
- A specific topic (concept name + description)
- A set of highly detailed "insights" extracted from transcripts. Each insight is a small, precise statement with evidence tags and qualifiers.

Your job is to write a patient-level topic article with:

Sections:
1. Big Picture
2. How This Affects Your Body
3. What You Can Do
4. Risks & When to Be Careful
5. Open Questions

Rules:
- Audience is motivated patients or laypersons at roughly a 10th-grade reading level.
- Focus on clear explanations, analogies, and practical steps.
- Use numbered lists (1. 2. 3.) for sequential steps or ordered actions.
- Use bullet points (-) for non-ordered items, options, or parallel actions.
- Lists MUST start on a new line with a blank line before them. Each list item must be on its own line.
- Minimize jargon; explain technical terms when needed.
- Emphasize high-confidence, actionable recommendations.
- Avoid giving individual medical advice; keep language general and suggest discussing changes with a clinician.
- Still ground everything strictly in the provided insights; do not invent data.
- Use ONLY the provided insights as your factual source. Do not introduce new factual claims not supported by the insights.
- Preserve important numeric details, dose ranges, frequencies, lab thresholds, time frames, and population qualifiers.
- Do not mention the existence of "insights" or "chunks" or transcripts; just write the article.
- Do NOT include a large title heading (H1 with #) - start directly with section content.

Output JSON with this shape:
{
  "title": "string",
  "sections": [
    {
      "id": "big-picture" | "mechanisms" | "actions" | "risks" | "questions",
      "title": "string",
      "paragraphs": [
        {
          "id": "p1",
          "text": "full paragraph text",
          "insight_ids": ["uuid-1", "uuid-2"]
        }
      ]
    }
  ]
}

- Make sure every paragraph includes an insight_ids array listing the IDs of the insights you primarily relied on for that paragraph.
- It is okay if some insights are not used; it is also okay if some paragraphs use multiple insights.
- Total length should be roughly 800–1500 words, depending on how much information is available.
`

interface InsightForNarrative {
  id: string
  statement: string
  context_note?: string | null
  evidence_type: string
  qualifiers: any
  confidence: string
  importance?: number
  actionability?: string
  insight_type?: string
  direct_quote?: string | null
  tone?: string
}

/**
 * Generate topic articles (clinician and patient) for a concept
 */
export async function generateTopicArticlesForConcept(conceptId: string): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // 1. Load concept
  const { data: concept, error: conceptError } = await supabaseAdmin
    .from('concepts')
    .select('*')
    .eq('id', conceptId)
    .single()

  if (conceptError || !concept) {
    throw new Error(`Concept not found: ${conceptError?.message}`)
  }

  // 2. Load all insights linked to this concept (excluding soft-deleted)
  const { data: insightsData, error: insightsError } = await supabaseAdmin
    .from('insight_concepts')
    .select(
      `
      insights (
        id,
        statement,
        context_note,
        evidence_type,
        qualifiers,
        confidence,
        importance,
        actionability,
        insight_type,
        has_direct_quote,
        direct_quote,
        tone
      )
    `
    )
    .eq('concept_id', conceptId)
    .is('insights.deleted_at', null) // Only non-deleted insights

  if (insightsError) {
    throw new Error(`Error fetching insights: ${insightsError.message}`)
  }

  const insights: InsightForNarrative[] = (insightsData || [])
    .map((item: any) => item.insights)
    .filter((i: any) => i?.id)

  if (insights.length === 0) {
    throw new Error('No insights found for this concept. Tag some insights first.')
  }

  // 3. Generate articles for both audiences
  for (const audience of ['clinician', 'patient'] as const) {
    const systemPrompt = audience === 'clinician' ? CLINICIAN_SYSTEM_PROMPT : PATIENT_SYSTEM_PROMPT

    // Build user prompt with concept and insights
    const insightsJson = JSON.stringify(insights, null, 2)
    const userPrompt = `Topic: ${concept.name}
Description: ${concept.description || 'No description'}

Insights (${insights.length} total):
${insightsJson}

Generate a ${audience} article for this topic.`

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        // Note: gpt-5-mini only supports default temperature (1), custom values are not supported
        response_format: { type: 'json_object' }
      })

      const content = completion.choices[0]?.message?.content
      if (!content) {
        throw new Error('No content in OpenAI response')
      }

      const parsed = JSON.parse(content) as {
        title: string
        sections: Array<{
          id: string
          title: string
          paragraphs: Array<{
            id: string
            text: string
            insight_ids: string[]
          }>
        }>
      }

      // Build markdown body (no H1 title - start with sections directly)
      const markdownSections = parsed.sections.map(section => {
        const sectionMarkdown = `## ${section.title}\n\n${section.paragraphs.map(p => p.text).join('\n\n')}`
        return sectionMarkdown
      }).join('\n\n')

      // Post-process markdown to ensure proper formatting
      let bodyMarkdown = markdownSections
        // Strip any H1 headings that might have been generated
        .replace(/^#\s+.+$/gm, '') // H1 at start of line
        .replace(/\n+#\s+[^\n]+\n+/g, '\n') // H1 on its own line
        // Normalize multiple blank lines (3+) to double blank lines
        .replace(/\n{3,}/g, '\n\n')
        // Fix lists missing blank lines before them
        .replace(/([^\n])(\n)([0-9]+\.\s|-|\*)/g, '$1\n\n$3')
        // Trim leading/trailing whitespace
        .trim()

      // Check if article exists
      const { data: existingArticle } = await supabaseAdmin
        .from('topic_articles')
        .select('version')
        .eq('concept_id', conceptId)
        .eq('audience', audience)
        .order('version', { ascending: false })
        .limit(1)
        .single()

      const newVersion = existingArticle?.version ? existingArticle.version + 1 : 1

      // Delete old versions for this concept+audience, then insert new one
      await supabaseAdmin
        .from('topic_articles')
        .delete()
        .eq('concept_id', conceptId)
        .eq('audience', audience)

      // Insert new article
      const { error: upsertError } = await supabaseAdmin
        .from('topic_articles')
        .insert({
          concept_id: conceptId,
          audience,
          version: newVersion,
          title: parsed.title,
          outline: { sections: parsed.sections },
          body_markdown: bodyMarkdown,
        })

      if (upsertError) {
        throw new Error(`Failed to save ${audience} article: ${upsertError.message}`)
      }

      console.log(`Generated ${audience} article for concept ${concept.name} (version ${newVersion})`)
    } catch (error) {
      console.error(`Error generating ${audience} article:`, error)
      throw error
    }
  }
}
