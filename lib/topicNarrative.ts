import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import type { Concept, TopicArticle } from './types'
import { prioritizeInsightsForGeneration, getInsightsForGeneration } from './insightPrioritization'

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

const CLINICIAN_SYSTEM_PROMPT = `
You are assisting a physician building an up-to-date lifestyle medicine reference.

You are given:
- A specific topic (concept name + description)
- A set of highly detailed "insights" extracted from verified source transcripts (podcasts, books, videos, articles). Each insight is a small, precise statement with evidence tags and qualifiers.

Your job is to write a comprehensive, high-fidelity clinician-level topic article that preserves ALL information from the insights.

Sections:
1. Overview
2. Key Mechanisms & Pathophysiology
3. Practical Protocols & Implementation
4. Risks, Caveats & Contraindications
5. Controversies & Areas of Uncertainty

CRITICAL RULES:
- Use ONLY the provided insights as your factual source. Do NOT introduce new factual claims, data, or information from your training data or external knowledge.
- You MUST incorporate ALL insights into the article. The article should be as long as necessary to comprehensively cover all insights - there is NO word limit.
- You may use AI reasoning to: (1) connect related insights together into coherent narratives, (2) organize information in the most logical and useful way, (3) create smooth transitions between concepts, (4) present the same information in clearer or more structured formats.
- You may NOT use AI to: (1) add facts, data, or claims not present in the insights, (2) fill in gaps with general medical knowledge, (3) supplement with information from your training data.
- Integrate the insights into a coherent narrative, grouping related insights together while preserving all details.
- Use numbered lists (1. 2. 3.) for sequential steps, protocols, or ordered actions.
- Use bullet points (-) for non-ordered items, options, or parallel actions.
- Lists MUST start on a new line with a blank line before them. Each list item must be on its own line.
- Preserve ALL important numeric details, dose ranges, frequencies, lab thresholds, time frames, and population qualifiers from the insights.
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
- Every insight should be incorporated into the article. If you have many insights, the article should be correspondingly longer and more comprehensive.
- There is NO word limit - write as much as needed to fully cover all insights with high fidelity.
`

const PATIENT_SYSTEM_PROMPT = `
You are assisting a physician building an up-to-date lifestyle medicine reference for patients.

You are given:
- A specific topic (concept name + description)
- A comprehensive clinician-level article that was generated from verified source insights

Your job is to translate the clinician article into a patient-accessible version that preserves all the information but makes it understandable for laypersons.

Sections:
1. Big Picture
2. How This Affects Your Body
3. What You Can Do
4. Risks & When to Be Careful
5. Open Questions

CRITICAL RULES:
- Base your article ENTIRELY on the provided clinician article. Do NOT add information not present in the clinician article.
- You may use AI reasoning to: (1) simplify technical language, (2) create analogies to explain complex concepts, (3) reorganize information for better patient understanding, (4) add context that helps patients understand the clinician-level information.
- You may NOT use AI to: (1) add facts, data, or claims not in the clinician article, (2) supplement with general medical knowledge, (3) fill gaps with information from your training data.
- Preserve ALL information from the clinician article - translate it, don't summarize it away.
- Audience is motivated patients or laypersons at roughly a 10th-grade reading level.
- Focus on clear explanations, analogies, and practical steps.
- Use numbered lists (1. 2. 3.) for sequential steps or ordered actions.
- Use bullet points (-) for non-ordered items, options, or parallel actions.
- Lists MUST start on a new line with a blank line before them. Each list item must be on its own line.
- Minimize jargon; explain technical terms when needed.
- Emphasize high-confidence, actionable recommendations.
- Avoid giving individual medical advice; keep language general and suggest discussing changes with a clinician.
- Preserve ALL important numeric details, dose ranges, frequencies, lab thresholds, time frames, and population qualifiers from the clinician article.
- Do not mention the existence of "insights" or "chunks" or transcripts; just write the article.
- Do NOT include a large title heading (H1 with #) - start directly with section content.
- There is NO word limit - write as much as needed to fully translate all information from the clinician article.

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
          "insight_ids": []
        }
      ]
    }
  ]
}

- Since you're translating from the clinician article (not directly from insights), you don't need to track insight_ids in paragraphs.
- The article should be comprehensive and preserve all information from the clinician version.
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
        primary_audience,
        insight_type,
        has_direct_quote,
        direct_quote,
        tone,
        created_at
      )
    `
    )
    .eq('concept_id', conceptId)
    .is('insights.deleted_at', null) // Only non-deleted insights

  if (insightsError) {
    throw new Error(`Error fetching insights: ${insightsError.message}`)
  }

  const allInsights: InsightForNarrative[] = (insightsData || [])
    .map((item: any) => item.insights)
    .filter((i: any) => i?.id)

  if (allInsights.length === 0) {
    throw new Error('No insights found for this concept. Tag some insights first.')
  }

  // 3. Prioritize insights for clinician article (filter by audience)
  const prioritizedClinician = prioritizeInsightsForGeneration(allInsights as any, 350, 'clinician')
  const clinicianInsights = getInsightsForGeneration(prioritizedClinician)

  console.log(`[Clinician Article] Total insights: ${prioritizedClinician.totalCount}, Using: ${clinicianInsights.length} (Tier 1: ${prioritizedClinician.tier1Count}, Tier 2: ${prioritizedClinician.tier2Count}, Tier 3: ${prioritizedClinician.tier3Count} excluded)`)

  if (clinicianInsights.length === 0) {
    throw new Error('No insights selected for clinician article after prioritization.')
  }

  // 4. Generate clinician article first
  console.log(`Generating clinician article for concept ${concept.name}...`)
  
  const clinicianInsightsJson = JSON.stringify(clinicianInsights, null, 2)
  const clinicianUserPrompt = `Topic: ${concept.name}
Description: ${concept.description || 'No description'}

Insights (${clinicianInsights.length} of ${prioritizedClinician.totalCount} total - prioritized by importance, actionability, evidence strength, and recency, filtered for clinician audience):
${clinicianInsightsJson}

Note: This represents the most important and recent insights relevant to clinicians. ${prioritizedClinician.tier3Count > 0 ? `An additional ${prioritizedClinician.tier3Count} insights are available but not included here to stay within token limits.` : ''}

Generate a comprehensive clinician article for this topic. Remember: incorporate ALL insights, use AI to connect and organize them, but do NOT add external knowledge.`

  let clinicianArticle: {
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

  try {
    const clinicianCompletion = await getOpenAI().chat.completions.create({
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: CLINICIAN_SYSTEM_PROMPT },
        { role: 'user', content: clinicianUserPrompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })

    const clinicianContent = clinicianCompletion.choices[0]?.message?.content
    if (!clinicianContent) {
      throw new Error('No content in OpenAI response for clinician article')
    }

    clinicianArticle = JSON.parse(clinicianContent) as typeof clinicianArticle

    // Build markdown body for clinician article
    const clinicianMarkdownSections = clinicianArticle.sections.map(section => {
      const sectionMarkdown = `## ${section.title}\n\n${section.paragraphs.map(p => p.text).join('\n\n')}`
      return sectionMarkdown
    }).join('\n\n')

    let clinicianBodyMarkdown = clinicianMarkdownSections
      .replace(/^#\s+.+$/gm, '')
      .replace(/\n+#\s+[^\n]+\n+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/([^\n])(\n)([0-9]+\.\s|-|\*)/g, '$1\n\n$3')
      .trim()

    // Save clinician article
    const { data: existingClinicianArticle } = await supabaseAdmin
      .from('topic_articles')
      .select('version')
      .eq('concept_id', conceptId)
      .eq('audience', 'clinician')
      .order('version', { ascending: false })
      .limit(1)
      .single()

    const newClinicianVersion = existingClinicianArticle?.version ? existingClinicianArticle.version + 1 : 1

    await supabaseAdmin
      .from('topic_articles')
      .delete()
      .eq('concept_id', conceptId)
      .eq('audience', 'clinician')

    const now = new Date().toISOString()
    const { error: clinicianUpsertError } = await supabaseAdmin
      .from('topic_articles')
      .insert({
        concept_id: conceptId,
        audience: 'clinician',
        version: newClinicianVersion,
        title: clinicianArticle.title,
        outline: { sections: clinicianArticle.sections },
        body_markdown: clinicianBodyMarkdown,
        last_regenerated_at: now,
      })

    if (clinicianUpsertError) {
      throw new Error(`Failed to save clinician article: ${clinicianUpsertError.message}`)
    }

    console.log(`Generated clinician article for concept ${concept.name} (version ${newClinicianVersion})`)
  } catch (error) {
    console.error('Error generating clinician article:', error)
    throw error
  }

  // 4. Generate patient article from clinician article
  console.log(`Generating patient article from clinician article for concept ${concept.name}...`)

  const patientUserPrompt = `Topic: ${concept.name}
Description: ${concept.description || 'No description'}

Clinician Article:
${JSON.stringify(clinicianArticle, null, 2)}

Translate this clinician article into a patient-accessible version. Preserve all information but make it understandable for laypersons.`

  try {
    const patientCompletion = await getOpenAI().chat.completions.create({
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: PATIENT_SYSTEM_PROMPT },
        { role: 'user', content: patientUserPrompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })

    const patientContent = patientCompletion.choices[0]?.message?.content
    if (!patientContent) {
      throw new Error('No content in OpenAI response for patient article')
    }

    const patientArticle = JSON.parse(patientContent) as {
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

    // Build markdown body for patient article
    const patientMarkdownSections = patientArticle.sections.map(section => {
      const sectionMarkdown = `## ${section.title}\n\n${section.paragraphs.map(p => p.text).join('\n\n')}`
      return sectionMarkdown
    }).join('\n\n')

    let patientBodyMarkdown = patientMarkdownSections
      .replace(/^#\s+.+$/gm, '')
      .replace(/\n+#\s+[^\n]+\n+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/([^\n])(\n)([0-9]+\.\s|-|\*)/g, '$1\n\n$3')
      .trim()

    // Save patient article
    const { data: existingPatientArticle } = await supabaseAdmin
      .from('topic_articles')
      .select('version')
      .eq('concept_id', conceptId)
      .eq('audience', 'patient')
      .order('version', { ascending: false })
      .limit(1)
      .single()

    const newPatientVersion = existingPatientArticle?.version ? existingPatientArticle.version + 1 : 1

    await supabaseAdmin
      .from('topic_articles')
      .delete()
      .eq('concept_id', conceptId)
      .eq('audience', 'patient')

    const now = new Date().toISOString()
    const { error: patientUpsertError } = await supabaseAdmin
      .from('topic_articles')
      .insert({
        concept_id: conceptId,
        audience: 'patient',
        version: newPatientVersion,
        title: patientArticle.title,
        outline: { sections: patientArticle.sections },
        body_markdown: patientBodyMarkdown,
        last_regenerated_at: now,
      })

    if (patientUpsertError) {
      throw new Error(`Failed to save patient article: ${patientUpsertError.message}`)
    }

    console.log(`Generated patient article for concept ${concept.name} (version ${newPatientVersion})`)
  } catch (error) {
    console.error('Error generating patient article:', error)
    throw error
  }
}
