import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import type { Concept, TopicProtocol } from './types'

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

const PROTOCOL_SYSTEM_PROMPT = `
You are assisting a physician building a lifestyle medicine reference.

You will receive:
- A specific topic (concept name + description)
- A list of detailed, structured "insights" that summarize evidence and expert discussion.

Your task is to create clinical protocols for this topic. There may be multiple separate protocols if the insights support different approaches or contexts.

These protocols are meant for motivated patients and clinicians who want clear, safe, actionable steps, not general education.

It should:
1. Be grounded only in the provided insights. Do NOT invent numerical values, effects, or new claims not supported by the insights.
2. Preserve important numeric details, dose ranges, frequencies, lab cutoffs, and qualifiers when they are available.
3. Use numbered lists (1., 2., 3.) for sequential steps, phases, or ordered actions.
4. Use bullet points (- or *) for non-ordered lists, options, or parallel items.
5. Focus on purely actionable information - what to do, when, how often, for how long.
6. Make clear what is high-confidence vs speculative or expert opinion.
7. Balance structure and flexibility: some topics may lend themselves to stepwise phases, others to habit stacks, others to algorithms; you can use any combination that fits the insights.
8. Be safe and conservative: flag contraindications, red flags, and when to involve a physician.
9. Context, limitations, and caveats should appear in the "Contraindications & Safety" section at the bottom, not scattered throughout.

Your output should be a JSON object with this exact shape:

{
  "title": "string",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "paragraphs": [
        {
          "id": "p1",
          "text": "Brief overview. Use numbered lists (1. 2. 3.) for sequential steps or bullet points (-) for parallel items. Focus on actionable information only.",
          "insight_ids": ["", ""]
        }
      ]
    },
    {
      "id": "phases",
      "title": "Phased Plan (if applicable)",
      "paragraphs": [
        {
          "id": "phase1",
          "text": "Phase 1 (e.g., Weeks 1–4): Use numbered lists for steps:\n1. First action\n2. Second action\n3. Lab monitoring (if applicable)",
          "insight_ids": []
        },
        {
          "id": "phase2",
          "text": "Phase 2: Use numbered lists for steps if the insights support phasing",
          "insight_ids": []
        }
      ]
    },
    {
      "id": "habit_stacks",
      "title": "Daily & Weekly Habits",
      "paragraphs": [
        {
          "id": "morning",
          "text": "Morning routine:\n- First habit\n- Second habit\n- Third habit",
          "insight_ids": []
        },
        {
          "id": "evening",
          "text": "Evening routine:\n- First habit\n- Second habit",
          "insight_ids": []
        },
        {
          "id": "weekly",
          "text": "Weekly actions:\n1. First weekly action\n2. Second weekly action",
          "insight_ids": []
        }
      ]
    },
    {
      "id": "algorithms",
      "title": "Decision Paths & Tailoring",
      "paragraphs": [
        {
          "id": "decision1",
          "text": "If-then structure describing how to adjust the protocol based on VO2 max, lab values, comorbidities, etc., only if clearly supported by the insights.",
          "insight_ids": []
        }
      ]
    },
    {
      "id": "monitoring",
      "title": "Monitoring, Labs & Follow-up",
      "paragraphs": [
        {
          "id": "monitoring1",
          "text": "How to monitor progress (lab tests, symptom tracking, performance metrics), based on insights.",
          "insight_ids": []
        }
      ]
    },
    {
      "id": "safety",
      "title": "Contraindications & Safety",
      "paragraphs": [
        {
          "id": "safety1",
          "text": "Contraindications:\n- First contraindication\n- Second contraindication\n\nWhen to stop:\n- Red flag 1\n- Red flag 2\n\nWhen to consult a clinician:\n- Situation 1\n- Situation 2\n\nContext and limitations:\n- Important caveat or limitation\n- Population-specific considerations",
          "insight_ids": []
        }
      ]
    }
  ]
}

Rules:
- It is OK if some sections are shorter for certain topics (e.g., if no strong data on algorithms, keep that section minimal).
- Every paragraph MUST include an insight_ids array listing the IDs of the insights most relevant to that paragraph.
- You may choose to emphasize phases, habit stacks, algorithms, or a mix, depending on what the insights support.
- CRITICAL - List formatting: Lists MUST start on a new line with a blank line before them. Each list item must be on its own line.
  CORRECT: "Phase 1 steps:\n\n1. First action\n2. Second action\n3. Third action"
  WRONG: "Phase 1 steps: 1. First action, 2. Second action, 3. Third action"
  WRONG: "Phase 1 steps:\n1. First action\n2. Second action" (missing blank line before list)
- Numbered lists: Each item on its own line, starting with "1. ", "2. ", "3. ", etc. Must have blank line before the list.
- Bullet lists: Each item on its own line, starting with "- " or "* ". Must have blank line before the list.
- Never put list items inline within a paragraph. Never use commas to separate list items.
- Focus on actionable steps, not explanatory text. Save context and limitations for the safety section.
- Multiple separate protocols are acceptable if insights support different approaches.
- Do not give individual-patient medical advice; keep recommendations general and suggest discussion with a clinician where appropriate.
- Do NOT include a large title heading (H1 with #) - start directly with section content.
`

interface InsightForProtocol {
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
 * Generate a protocol for a concept based on its linked insights
 */
export async function generateProtocolForConcept(conceptId: string): Promise<void> {
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

  const insights: InsightForProtocol[] = (insightsData || [])
    .map((item: any) => item.insights)
    .filter((i: any) => i?.id)

  if (insights.length === 0) {
    throw new Error('No insights found for this concept. Tag some insights first.')
  }

  // 3. Call OpenAI
  const insightsJson = JSON.stringify(insights, null, 2)
  const userPrompt = `Topic: ${concept.name}
Description: ${concept.description || 'No description'}

Insights (${insights.length} total):
${insightsJson}

Generate clinical protocol(s) for this topic. 

IMPORTANT - List Formatting Rules:
- CRITICAL: Lists MUST have a blank line before them and each item on its own line.
  CORRECT: "Steps to follow:\n\n1. First step\n2. Second step\n3. Third step"
  WRONG: "Steps: 1. First, 2. Second, 3. Third" (inline list)
  WRONG: "Steps:\n1. First\n2. Second" (missing blank line before list)
- Use numbered lists (1. 2. 3.) for sequential steps or phases - each on its own line with blank line before
- Use bullet points (-) for non-ordered items, options, or parallel actions - each on its own line with blank line before
- Never put list items inline within paragraphs or separated by commas
- Focus on actionable information: what to do, when, how often, for how long
- Multiple separate protocols are acceptable if insights support different approaches
- Save context, limitations, and caveats for the "Contraindications & Safety" section
- Do NOT include a large title heading (H1 with #) - start directly with section content`

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: PROTOCOL_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      // Note: gpt-5-mini only supports default temperature (1), custom values are not supported
      response_format: { type: 'json_object' }
    })

    const content = completion.choices[0]?.message?.content
    if (!content) {
      throw new Error('No content in OpenAI response')
    }

    // 4. Parse JSON response
    let parsed: {
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
      parsed = JSON.parse(content)
    } catch (parseError) {
      console.error('Failed to parse OpenAI JSON response:', content)
      throw new Error(`Failed to parse protocol JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`)
    }

    // Validate structure
    if (!parsed.title || !parsed.sections || !Array.isArray(parsed.sections)) {
      throw new Error('Invalid protocol structure: missing title or sections')
    }

    // 5. Build outline + body_markdown
    const outline = { sections: parsed.sections }

    // Build markdown body (no H1 title - start with sections directly)
    // First, strip any H1 headings from paragraph text
    const cleanParagraphs = parsed.sections.map(section => ({
      ...section,
      paragraphs: section.paragraphs.map(p => ({
        ...p,
        text: p.text.replace(/^#\s+.+$/gm, '').replace(/\n+#\s+[^\n]+\n+/g, '\n').trim()
      }))
    }))
    
    const markdownSections = cleanParagraphs.map(section => {
      const sectionMarkdown = `## ${section.title}\n\n${section.paragraphs.map(p => p.text).join('\n\n')}`
      return sectionMarkdown
    }).join('\n\n')

    // Post-process markdown to ensure proper formatting
    let bodyMarkdown = markdownSections
      // Strip any H1 headings that might have been generated
      // Match H1 at start of line (with optional leading whitespace)
      .replace(/^#\s+.+$/gm, '') // H1 at start of line
      // Match H1 on its own line with newlines before/after (more flexible)
      .replace(/\n+#\s+[^\n]+\n+/g, '\n') // H1 on its own line
      // Normalize multiple blank lines (3+) to double blank lines
      .replace(/\n{3,}/g, '\n\n')
      // Fix lists missing blank lines before them
      // Pattern: non-newline char, single newline, then list item (number or bullet)
      .replace(/([^\n])(\n)([0-9]+\.\s|-|\*)/g, '$1\n\n$3')
      // Trim leading/trailing whitespace
      .trim()

    // 6. Insert a new version row into topic_protocols
    // Check current max version
    const { data: existingProtocol } = await supabaseAdmin
      .from('topic_protocols')
      .select('version')
      .eq('concept_id', conceptId)
      .order('version', { ascending: false })
      .limit(1)
      .single()

    const newVersion = existingProtocol?.version ? existingProtocol.version + 1 : 1

    // Insert new protocol
    const { error: insertError } = await supabaseAdmin
      .from('topic_protocols')
      .insert({
        concept_id: conceptId,
        version: newVersion,
        title: parsed.title,
        outline,
        body_markdown: bodyMarkdown,
      })

    if (insertError) {
      throw new Error(`Failed to save protocol: ${insertError.message}`)
    }

    console.log(`Generated protocol for concept ${concept.name} (version ${newVersion})`)
  } catch (error) {
    console.error('Error generating protocol:', error)
    throw error
  }
}
