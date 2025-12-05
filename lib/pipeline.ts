import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import { createHash } from 'crypto'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

interface Insight {
  statement: string
  context_note?: string | null
  evidence_type: 'RCT' | 'Cohort' | 'MetaAnalysis' | 'CaseSeries' | 'Mechanistic' | 'Animal' | 'ExpertOpinion' | 'Other'
  qualifiers: {
    population?: string | null
    dose?: string | null
    duration?: string | null
    outcome?: string | null
    effect_size?: string | null
    caveats?: string | null
  }
  confidence: 'high' | 'medium' | 'low'
  importance?: 1 | 2 | 3
  actionability?: 'Background' | 'Low' | 'Medium' | 'High'
  primary_audience?: 'Patient' | 'Clinician' | 'Both'
  insight_type?: 'Protocol' | 'Explanation' | 'Mechanism' | 'Anecdote' | 'Warning' | 'Controversy' | 'Other'
  has_direct_quote?: boolean
  direct_quote?: string | null
  tone?: 'Neutral' | 'Surprised' | 'Skeptical' | 'Cautious' | 'Enthusiastic' | 'Concerned' | 'Other'
}

interface OpenAIResponse {
  insights: Insight[]
}

/**
 * Normalize a statement for hashing (deduplication)
 */
function normalizeStatement(statement: string): string {
  return statement
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Compute SHA256 hash of normalized statement for deduplication
 */
function computeInsightHash(statement: string): string {
  const normalized = normalizeStatement(statement)
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Filter out low-value insights based on patterns
 */
function filterLowValueInsights(insights: Insight[]): Insight[] {
  const excludePatterns = [
    // Meta-commentary about podcast structure
    /this (podcast|episode|discussion|conversation) (will|is going to|features?)/i,
    /(two-part|multi-part|part \d+)/i,
    
    // Introductions and person mentions
    /^(.* )?(is|are) (a|an) (leading|prominent|notable|expert|researcher|scientist|doctor|professor)/i,
    /^(.* )?(introduc|mention|discuss).* (as|named|called)/i,
    
    // Conflict of interest statements
    /conflict(s)? of interest/i,
    /(disclos|mention|discuss).* conflict/i,
    /no conflict/i,
    /transparency.* (funding|source|method)/i,
    
    // Personal anecdotes and irrelevant details
    /(enjoy|like|dislike|prefer).* (protein bar|product|brand)/i,
    /(company|brand|product).* (doesn't|don't|does not|do not) have/i,
    
    // Vague meta-statements
    /^(protein|nutrition|science) (has|have) become (a|an) (contentious|controversial|debated)/i,
  ]
  
  return insights.filter(insight => {
    const statement = insight.statement.toLowerCase()
    
    // Check against exclusion patterns
    for (const pattern of excludePatterns) {
      if (pattern.test(statement)) {
        return false
      }
    }
    
    // Exclude very short or vague statements
    if (statement.length < 30) {
      return false
    }
    
    // Exclude statements that are just topic introductions without substance
    if (/^(this|the) (podcast|episode|discussion|conversation|topic)/i.test(insight.statement)) {
      return false
    }
    
    return true
  })
}

const EXTRACTION_SYSTEM_PROMPT = `
You are assisting a physician building a high-end lifestyle medicine knowledge base for patients and clinicians.

Your job is to extract ONLY the clinically or behaviorally meaningful insights from a transcript chunk and represent them as detailed, structured data.

These insights will be used to:

- Build protocols and decision aids that patients may pay thousands of dollars to access.

- Help other clinicians update their practice based on high-quality discussions.

GENERAL RULES

- Be HYPER-SPECIFIC. Do NOT oversimplify.

- Preserve ALL important NUMERIC details:

  - lab value thresholds

  - ranges

  - percentages

  - doses (mg, IU, etc.)

  - frequencies (times per week, hours per night)

  - durations (weeks, months, years)

- Preserve important QUALIFIERS:

  - population (e.g., postmenopausal women, people with T2DM, elite athletes)

  - context (e.g., fasting state, post-exercise, on medication)

- Each insight may be 1–3 sentences if needed to carry all necessary detail.

- When in doubt, INCLUDE detail rather than leaving it out.

- Do NOT hallucinate; only use information clearly supported by the text.

WHAT COUNTS AS AN INSIGHT?

Extract an insight ONLY if it is one of the following:

1) PROTOCOL – A concrete recommendation or practice pattern

   - What to do, how often, at what intensity/dose, for how long, under what conditions.

2) EXPLANATION / MECHANISM – An explanation of how or why something works that would matter for understanding or decision-making.

3) WARNING – A risk, harm, contraindication, or caveat that would change how someone safely applies a protocol.

4) ANECDOTE – A clearly labeled story or personal clinical observation that the speaker uses to illustrate a point.

5) CONTROVERSY – An area where data are mixed or experts disagree, and the speaker explicitly frames it as uncertain or debated.

Ignore:

- Jokes, small talk, rhetorical questions.

- Generic "exercise is good" type statements without any specificity.

- Repetitions that add no new nuance.

- Meta-commentary about podcast structure ("This podcast will feature...", "This is a two-part discussion...")

- Introductions of people ("Dr. X is a leading researcher...", "We're joined by...")

- Conflict of interest disclosures ("We have no conflicts...", "Transparency in funding...")

- Personal anecdotes unrelated to medical facts ("I enjoy protein bars...", "Our company doesn't...")

EVIDENCE TYPE

- "RCT" for randomized controlled trials.

- "Cohort" for prospective or retrospective cohort studies.

- "MetaAnalysis" for meta-analyses or systematic reviews.

- "CaseSeries" for small case series or case reports.

- "Mechanistic" for basic science, physiological, or mechanistic work in humans.

- "Animal" for animal or preclinical models.

- "ExpertOpinion" when the speaker is giving their own view, clinical experience, or extrapolation.

- "Other" if it doesn't fit the above.

CONFIDENCE

- "high" when claim is strongly supported (multiple RCTs, meta-analyses, or very strong consensus).

- "medium" when supported but not definitive, or based on a mix of data and expert opinion.

- "low" when speculative, early data, conflicting studies, or the speaker emphasizes uncertainty.

IMPORTANCE (1–3)

Think: "If I were building the world's best notes for this topic, how central is this?"

- 3 = Core, high-value, changes behavior or understanding for most patients/clinicians.

- 2 = Useful, but not central.

- 1 = Niche, background, or edge-case.

ACTIONABILITY

- "High" – directly tells someone what they could do differently (protocols, thresholds).

- "Medium" – indirectly guides behavior (e.g., mechanism that clearly influences decisions).

- "Low" – mostly background knowledge.

- "Background" – interesting but not really changing behavior on its own.

PRIMARY AUDIENCE

- "Patient" – primarily relevant for motivated laypersons wanting to adjust their lifestyle.

- "Clinician" – uses technical language, more about risk calculation, nuance, or mechanistic detail.

- "Both" – accessible enough for patients but still useful to clinicians.

INSIGHT TYPE

- "Protocol" – do X with Y dose/frequency/duration/intensity.

- "Explanation" – non-mechanistic explanation, conceptual framing.

- "Mechanism" – deeper pathophysiology, cellular/biochemical pathways.

- "Anecdote" – personal story or clinical vignette.

- "Warning" – risk, harm, adverse effects, contraindications.

- "Controversy" – explicit disagreement or mixed evidence.

- "Other" – if none of the above fits.

DIRECT QUOTES AND TONE

- If the speaker uses especially strong, memorable, or surprising phrasing, include a SHORT direct quote (at most ~40 words) that captures this, in the "direct_quote" field.

- Set "has_direct_quote" to true when you include a quote, otherwise false.

- TONE:

  - "Surprised" – speaker is clearly surprised or emphasizes counterintuitive results.

  - "Cautious" – emphasizes uncertainty, limitations, or "we're not sure yet".

  - "Enthusiastic" – clearly excited, strongly endorsing.

  - "Concerned" – emphasizing risk or harm.

  - "Skeptical" – expresses doubt about a claim or hype.

  - "Neutral" – default when no strong emotion is conveyed.

  - "Other" – any tone that doesn't fit the above.

OUTPUT FORMAT

Return ONLY valid JSON with this shape:

{
  "insights": [
    {
      "statement": "string, 1–3 sentences, detailed and specific",
      "context_note": "string or null",
      "evidence_type": "RCT|Cohort|MetaAnalysis|CaseSeries|Mechanistic|Animal|ExpertOpinion|Other",
      "qualifiers": {
        "population": "string or null",
        "dose": "string or null",
        "duration": "string or null",
        "outcome": "string or null",
        "effect_size": "string or null",
        "caveats": "string or null"
      },
      "confidence": "high|medium|low",
      "importance": 1 | 2 | 3,
      "actionability": "Background|Low|Medium|High",
      "primary_audience": "Patient|Clinician|Both",
      "insight_type": "Protocol|Explanation|Mechanism|Anecdote|Warning|Controversy|Other",
      "has_direct_quote": true | false,
      "direct_quote": "string or null",
      "tone": "Neutral|Surprised|Skeptical|Cautious|Enthusiastic|Concerned|Other"
    }
  ]
}

If there are no meaningful insights in this chunk, return:

{ "insights": [] }
`

async function extractInsightsFromChunk(chunkContent: string, chunkIndex?: number, totalChunks?: number): Promise<Insight[]> {
  const userPrompt = `Text to analyze:
${chunkContent}`

  const chunkLabel = chunkIndex !== undefined ? `Chunk ${chunkIndex + 1}/${totalChunks || '?'}` : 'Chunk'

  try {
    console.log(`[${chunkLabel}] Calling OpenAI API with model: gpt-5-mini`)
    console.log(`[${chunkLabel}] Chunk content length: ${chunkContent.length} chars`)
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini', // GPT-5 Mini: Better performance with cost efficiency, 400K context window
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      // Note: gpt-5-mini only supports default temperature (1), custom values are not supported
      response_format: { type: 'json_object' }
    })

    console.log(`[${chunkLabel}] OpenAI API call completed`)
    
    // Log token usage if available
    let tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
    if (completion.usage) {
      tokenUsage = {
        promptTokens: completion.usage.prompt_tokens,
        completionTokens: completion.usage.completion_tokens,
        totalTokens: completion.usage.total_tokens
      }
      console.log(`[${chunkLabel}] Token usage: ${tokenUsage.promptTokens} prompt + ${tokenUsage.completionTokens} completion = ${tokenUsage.totalTokens} total`)
    }

    const content = completion.choices[0]?.message?.content
    if (!content) {
      console.error(`[${chunkLabel}] ❌ No content in OpenAI response`)
      console.error(`[${chunkLabel}] Completion object:`, JSON.stringify(completion, null, 2))
      return { insights: [], tokenUsage }
    }

    console.log(`[${chunkLabel}] Received response, length: ${content.length} chars`)

    // Parse JSON response
    let parsed: OpenAIResponse
    try {
      parsed = JSON.parse(content) as OpenAIResponse
    } catch (parseError) {
      console.error(`[${chunkLabel}] ❌ JSON parse error:`, parseError)
      console.error(`[${chunkLabel}] Response content (first 1000 chars):`, content.substring(0, 1000))
      return { insights: [], tokenUsage }
    }
    
    if (!parsed.insights || !Array.isArray(parsed.insights)) {
      console.error(`[${chunkLabel}] ❌ Invalid OpenAI response format`)
      console.error(`[${chunkLabel}] Parsed object keys:`, Object.keys(parsed))
      console.error(`[${chunkLabel}] Full response:`, JSON.stringify(parsed, null, 2).substring(0, 2000))
      return { insights: [], tokenUsage }
    }

    console.log(`[${chunkLabel}] ✓ Extracted ${parsed.insights.length} insights before filtering`)

    // Validate and normalize insights with defaults
    const normalizedInsights = parsed.insights.map(insight => ({
      ...insight,
      importance: insight.importance ?? 2,
      actionability: insight.actionability ?? 'Medium',
      primary_audience: insight.primary_audience ?? 'Both',
      insight_type: insight.insight_type ?? 'Explanation',
      has_direct_quote: insight.has_direct_quote ?? false,
      direct_quote: insight.direct_quote || null,
      tone: insight.tone ?? 'Neutral',
      context_note: insight.context_note ?? null,
    }))

    // Filter out low-value insights
    const filteredInsights = filterLowValueInsights(normalizedInsights)
    
    if (filteredInsights.length < normalizedInsights.length) {
      console.log(`[${chunkLabel}] ⚠️ Filtered out ${normalizedInsights.length - filteredInsights.length} low-value insights (${normalizedInsights.length} → ${filteredInsights.length})`)
    }

    console.log(`[${chunkLabel}] ✓ Returning ${filteredInsights.length} insights after filtering`)
    return { insights: filteredInsights, tokenUsage }
  } catch (error) {
    console.error(`[${chunkLabel}] ❌ Error extracting insights:`, error)
    if (error instanceof Error) {
      console.error(`[${chunkLabel}] Error name:`, error.name)
      console.error(`[${chunkLabel}] Error message:`, error.message)
      if ('status' in error) {
        console.error(`[${chunkLabel}] Error status:`, (error as any).status)
      }
      if ('code' in error) {
        console.error(`[${chunkLabel}] Error code:`, (error as any).code)
      }
      
      // Re-throw fatal errors that should stop processing
      const errorStatus = (error as any).status
      const errorCode = (error as any).code
      
      // Fatal errors: authentication, invalid API key, model not found, etc.
      if (errorStatus === 401 || errorStatus === 403 || errorCode === 'invalid_api_key' || errorCode === 'model_not_found') {
        throw new Error(`Fatal API error at ${chunkLabel}: ${error.message}`)
      }
      
      // Rate limiting - we might want to retry, but for now throw to surface the issue
      if (errorStatus === 429 || errorCode === 'rate_limit_exceeded') {
        throw new Error(`Rate limit exceeded at ${chunkLabel}. Please wait a moment and try again.`)
      }
    }
    
    // For other errors, return empty array and continue (might be transient)
    console.warn(`[${chunkLabel}] Returning empty insights array due to error, continuing with next chunk`)
    return { insights: [], tokenUsage: undefined }
  }
}

/**
 * Progress callback type for real-time updates
 */
export type ProgressCallback = (progress: {
  stage: 'chunking' | 'extracting'
  chunksProcessed: number
  totalChunks: number
  insightsCreated: number
  message: string
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}) => void

/**
 * Split text into overlapping chunks
 */
function splitIntoChunks(text: string, chunkSize: number = 1500, overlapSize: number = 300): string[] {
  // First split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  
  const chunks: string[] = []
  let currentChunk = ''
  
  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim()
    
    // If adding this paragraph would exceed chunk size, save current chunk and start new one
    if (currentChunk.length + trimmedParagraph.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      
      // Start new chunk with overlap from end of previous chunk
      const overlap = currentChunk.slice(-overlapSize)
      currentChunk = overlap + '\n\n' + trimmedParagraph
    } else {
      // Add paragraph to current chunk
      if (currentChunk) {
        currentChunk += '\n\n' + trimmedParagraph
      } else {
        currentChunk = trimmedParagraph
      }
    }
  }
  
  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }
  
  return chunks.filter(chunk => chunk.length > 0)
}

/**
 * Process a source from plain text transcript
 */
export async function processSourceFromPlainText(
  sourceId: string, 
  text: string,
  onProgress?: ProgressCallback
): Promise<void> {
  // 1. Split text into chunks
  const chunks = splitIntoChunks(text)
  console.log(`Split transcript into ${chunks.length} chunks`)
  
  onProgress?.({
    stage: 'chunking',
    totalChunks: chunks.length,
    chunksProcessed: 0,
    insightsCreated: 0,
    message: `Split transcript into ${chunks.length} chunks`
  })

  // 2. Insert chunks into database
  const chunkInserts = chunks.map((content, index) => ({
    source_id: sourceId,
    locator: `seg-${String(index + 1).padStart(3, '0')}`,
    content,
    embedding: null // We'll add embeddings later
  }))

  const { error: chunksError } = await supabaseAdmin
    .from('chunks')
    .insert(chunkInserts)

  if (chunksError) {
    throw new Error(`Failed to insert chunks: ${chunksError.message}`)
  }

  console.log(`Inserted ${chunkInserts.length} chunks`)

  // 3. Process each chunk to extract insights
  let insightsCreated = 0
  let chunksProcessed = 0
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalTokens = 0
  
  for (const chunk of chunkInserts) {
    chunksProcessed++
    console.log(`\n[${chunk.locator}] Processing chunk ${chunksProcessed}/${chunkInserts.length}`)
    console.log(`[${chunk.locator}] Content length: ${chunk.content.length} characters`)
    console.log(`[${chunk.locator}] Content preview: ${chunk.content.substring(0, 150)}...`)
    
    onProgress?.({
      stage: 'extracting',
      chunksProcessed,
      totalChunks: chunkInserts.length,
      insightsCreated,
      message: `Processing chunk ${chunk.locator} (${chunksProcessed}/${chunkInserts.length})...`,
      tokenUsage: totalTokens > 0 ? {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalTokens
      } : undefined
    })
    
    let insights: Insight[]
    let chunkTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
    try {
      const result = await extractInsightsFromChunk(chunk.content, chunksProcessed - 1, chunkInserts.length)
      insights = result.insights
      chunkTokenUsage = result.tokenUsage
      
      if (chunkTokenUsage) {
        totalPromptTokens += chunkTokenUsage.promptTokens
        totalCompletionTokens += chunkTokenUsage.completionTokens
        totalTokens += chunkTokenUsage.totalTokens
      }
    } catch (chunkError) {
      console.error(`[${chunk.locator}] ❌ Fatal error extracting insights from chunk:`, chunkError)
      const errorMessage = chunkError instanceof Error ? chunkError.message : "Unknown error during extraction"
      const errorStack = chunkError instanceof Error ? chunkError.stack : undefined
      throw new Error(`Failed to process chunk ${chunk.locator} (${chunksProcessed}/${chunkInserts.length}): ${errorMessage}${errorStack ? `\n\nStack: ${errorStack}` : ''}`)
    }
    
    console.log(`[${chunk.locator}] Got ${insights.length} insights from extraction`)
    
    // Small delay between chunks to avoid rate limiting (especially important for gpt-5-mini)
    if (chunksProcessed < chunkInserts.length) {
      await new Promise(resolve => setTimeout(resolve, 200)) // 200ms delay between chunks
    }
    
    if (insights.length === 0) {
      console.warn(`[${chunk.locator}] ⚠️ No insights extracted - this might indicate an API error or all insights were filtered`)
      // Don't fail the whole process if one chunk has no insights, but log it
      continue
    }

    // 4. For each insight, check for duplicates and insert/link
    for (const insight of insights) {
      const insightHash = computeInsightHash(insight.statement)

      // Check if insight with this hash already exists
      const { data: existingInsight, error: lookupError } = await supabaseAdmin
        .from('insights')
        .select('id')
        .eq('insight_hash', insightHash)
        .single()

      let insightId: string

      if (existingInsight && !lookupError) {
        // Insight already exists, use its ID
        insightId = existingInsight.id
        console.log(`[${chunk.locator}] Found existing insight with hash ${insightHash.substring(0, 8)}...`)
      } else {
        // Insert new insight with all new fields
        const { data: newInsight, error: insertError } = await supabaseAdmin
          .from('insights')
          .insert({
            statement: insight.statement,
            context_note: insight.context_note || null,
            evidence_type: insight.evidence_type,
            qualifiers: insight.qualifiers,
            confidence: insight.confidence,
            insight_hash: insightHash,
            importance: insight.importance ?? 2,
            actionability: insight.actionability ?? 'Medium',
            primary_audience: insight.primary_audience ?? 'Both',
            insight_type: insight.insight_type ?? 'Explanation',
            has_direct_quote: insight.has_direct_quote ?? false,
            direct_quote: insight.direct_quote || null,
            tone: insight.tone ?? 'Neutral'
          })
          .select('id')
          .single()

        if (insertError || !newInsight) {
          console.error(`[${chunk.locator}] ❌ Failed to insert insight:`, insertError)
          if (insertError) {
            console.error(`[${chunk.locator}] Insert error details:`, JSON.stringify(insertError, null, 2))
          }
          console.error(`[${chunk.locator}] Insight data that failed:`, JSON.stringify({
            statement: insight.statement.substring(0, 100),
            evidence_type: insight.evidence_type,
            confidence: insight.confidence,
            importance: insight.importance,
            actionability: insight.actionability,
            primary_audience: insight.primary_audience,
            insight_type: insight.insight_type,
          }, null, 2))
          continue
        }

        insightId = newInsight.id
        insightsCreated++
        console.log(`[${chunk.locator}] ✓ Created new insight ${insightId.substring(0, 8)}... with hash ${insightHash.substring(0, 8)}...`)
        
        // Auto-tag the new insight to concepts
        try {
          const { autoTagAndLinkInsight } = await import('./autotag')
          await autoTagAndLinkInsight(insightId, insight)
        } catch (autoTagError) {
          console.error(`[${chunk.locator}] Error auto-tagging insight:`, autoTagError)
          // Continue processing even if auto-tagging fails
        }
        
        onProgress?.({
          stage: 'extracting',
          chunksProcessed,
          totalChunks: chunkInserts.length,
          insightsCreated,
          message: `Created ${insightsCreated} insights so far...`
        })
      }

      // 5. Link insight to source (insert into insight_sources)
      const { error: linkError } = await supabaseAdmin
        .from('insight_sources')
        .insert({
          insight_id: insightId,
          source_id: sourceId,
          locator: chunk.locator
        })

      if (linkError) {
        // Might be a duplicate link, which is okay
        if (!linkError.message.includes('duplicate') && !linkError.message.includes('unique')) {
          console.error(`[${chunk.locator}] ❌ Failed to link insight ${insightId.substring(0, 8)}... to source:`, linkError)
        } else {
          console.log(`[${chunk.locator}] ✓ Linked insight ${insightId.substring(0, 8)}... (or already linked)`)
        }
      } else {
        console.log(`[${chunk.locator}] ✓ Linked insight ${insightId.substring(0, 8)}... to source`)
      }
    }
  }

  console.log(`\n✅ Processing complete! Created ${insightsCreated} insights from ${chunkInserts.length} chunks.`)
  if (totalTokens > 0) {
    console.log(`📊 Total API usage: ${totalPromptTokens.toLocaleString()} prompt tokens + ${totalCompletionTokens.toLocaleString()} completion tokens = ${totalTokens.toLocaleString()} total tokens`)
    // Estimate cost (gpt-5-mini pricing - adjust if needed)
    // Note: Actual pricing may vary, this is an estimate
    const estimatedCost = (totalPromptTokens / 1_000_000) * 0.15 + (totalCompletionTokens / 1_000_000) * 0.60
    console.log(`💰 Estimated cost: $${estimatedCost.toFixed(4)}`)
  }
  
  onProgress?.({
    stage: 'extracting',
    chunksProcessed: chunkInserts.length,
    totalChunks: chunkInserts.length,
    insightsCreated,
    message: `Processing complete! Created ${insightsCreated} insights from ${chunkInserts.length} chunks.`,
    tokenUsage: totalTokens > 0 ? {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalTokens
    } : undefined
  })
}
