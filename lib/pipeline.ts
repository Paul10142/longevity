import { supabaseAdmin } from './supabaseServer'
import OpenAI from 'openai'
import { createHash } from 'crypto'
import { generateInsightEmbedding } from './embeddings'

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

// Chunking configuration constants
const DEFAULT_CHUNK_SIZE = 2400
const DEFAULT_CHUNK_OVERLAP = 200

// Feature flag: Use optimized prompt (set to false to use original detailed prompt)
const USE_OPTIMIZED_PROMPT = true

export interface Insight {
  statement: string
  context_note?: string | null
  evidence_type: 'RCT' | 'Cohort' | 'MetaAnalysis' | 'CaseSeries' | 'Mechanistic' | 'Animal' | 'ExpertOpinion' | 'Other'
  qualifiers: {
    population?: string | null
    dose?: string | null
    duration?: string | null
    outcome?: string | null
    effect_size?: string | null
  }
  confidence: 'high' | 'medium' | 'low'
  importance?: 1 | 2 | 3
  actionability?: 'Low' | 'Medium' | 'High' | 'Background'
  primary_audience?: 'Patient' | 'Clinician' | 'Both'
  insight_type?: 'Protocol' | 'Explanation' | 'Mechanism' | 'Anecdote' | 'Warning' | 'Controversy' | 'Other'
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
 * 
 * TO ADD NEW FILTER PATTERNS:
 * 1. Add regex patterns to the excludePatterns array below
 * 2. Patterns are case-insensitive and match against the insight statement
 * 3. Use regex syntax: /pattern/i (the 'i' flag makes it case-insensitive)
 * 4. Test patterns at: https://regex101.com/
 * 
 * EXAMPLES:
 * - /specific phrase/i - matches exact phrase
 * - /^(starts with)/i - matches if statement starts with phrase
 * - /(option1|option2)/i - matches either option
 * - Pattern with .*word.* - matches if statement contains word
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
    
    // ============================================
    // USER FEEDBACK PATTERNS - Add your patterns here
    // ============================================
    // Add patterns below based on insights you want to filter out
    // Example: /pattern to exclude/i,
    
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

// Original detailed prompt (preserved for comparison/rollback)
const EXTRACTION_SYSTEM_PROMPT_ORIGINAL = `
You are assisting a physician building a high-end lifestyle medicine knowledge base for patients and clinicians.

Your job is to extract ONLY the clinically or behaviorally meaningful insights from a transcript chunk and represent them as detailed, structured data.

These insights will be used to:

- Build protocols and decision aids that patients may pay thousands of dollars to access.

- Help other clinicians update their practice based on high-quality discussions.

GENERAL RULES

- Extract ALL meaningful insights from the chunk. Do not limit yourself to a small number - be thorough and comprehensive.

- Larger chunks contain more content and should yield proportionally more insights. Extract every insight that meets the criteria below.

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

- "Low" – mostly background knowledge (conceptual background).

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
        "effect_size": "string or null"
      },
      "confidence": "high|medium|low",
      "importance": 1 | 2 | 3,
      "actionability": "Low|Medium|High",
      "primary_audience": "Patient|Clinician|Both",
      "insight_type": "Protocol|Explanation|Mechanism|Anecdote|Warning|Controversy|Other"
    }
  ]
}

If there are no meaningful insights in this chunk, return:

{ "insights": [] }
`

// New prompt focused on high-value, generalizable, standalone insights
const EXTRACTION_SYSTEM_PROMPT_OPTIMIZED = `
Extract show-note–worthy insights from transcript chunks for a large, multi-source lifestyle and health knowledge base.

Your job is NOT to capture everything that was said. Your job is to extract only the ideas that would appear in polished show notes or an educational article. Prefer FEWER, HIGHER-VALUE, GENERALIZABLE insights over many small, conversational, or anecdotal ones.

====================================================================
PURPOSE OF THESE INSIGHTS  (CRITICAL)
====================================================================

The insights you produce will be merged with insights from thousands of other chunks and sources to form a unified medical and behavioral knowledge base. Because they will be recombined across episodes, each insight must:

• Stand alone without relying on the surrounding conversation.  
• Express generalizable, durable knowledge—NOT episode-specific details.  
• Capture mechanisms, principles, evolutionary logic, or explanatory frameworks.  
• Translate personal anecdotes into the *underlying principle* rather than retelling the story.  
• Include specific, practical examples (foods, practices, protocols) that help readers connect with and apply the insight.  
• Avoid any dependency on host interactions, podcast structure, or context.  

These insights must be written so a downstream system can automatically stitch them into high-quality show notes, clinician narratives, patient narratives, and protocols.

====================================================================
STITCHABILITY ACROSS CHUNKS  (CRITICAL)
====================================================================

Write each insight so it can combine cleanly with insights from:

• Other chunks of this episode  
• Other episodes  
• Other sources entirely  

This requires:

• No references to "earlier we discussed…", "as you said…", or speaker names.  
• No reliance on personal anecdotes or stories unless the insight explicitly states the *principle illustrated*.  
• Include specific, practical examples (e.g., "breakfast with eggs, cheese, and Greek yogurt; lunch with salmon, venison, or chicken breast and quinoa; vegetables") when they illustrate how to apply a principle or protocol.  
• Clear, standalone phrasing that conveys a durable meaning.  
• Emphasis on mechanisms, frameworks, and conceptual distinctions, supported by concrete examples when helpful.  

====================================================================
WHAT COUNTS AS A HIGH-VALUE INSIGHT
====================================================================

Produce an insight ONLY if it satisfies ALL of the following:

1. **Conceptually Important**  
   The idea deepens understanding of biology, behavior, development, hormones, evolutionary logic, risk, or mechanism.

2. **Generalizable Beyond the Transcript**  
   The insight must hold outside this conversation. Do NOT extract commentary, personal stories, or contextual talk unless they demonstrate a principle. However, DO include specific examples (foods, exercises, practices) that illustrate how to apply the principle—these help readers translate insights into action.

3. **Mechanistic or Explanatory**  
   Prioritize explanations of *why* or *how* a phenomenon works (e.g., developmental windows, receptor sensitivity, evolutionary trade-offs).

4. **Self-Contained and Clear**  
   The insight must make sense even to someone who never heard the podcast.

5. **Non-Obvious**  
   Avoid generic statements ("testosterone affects behavior"). Extract the deeper educational takeaway (e.g., "prenatal and pubertal testosterone act as separate developmental windows with different behavioral consequences").

====================================================================
WHAT SHOULD **NOT** BECOME AN INSIGHT
====================================================================

NEVER extract:

• Host anecdotes, parenting stories, personal reflections, or jokes.  
• Biographical information about the guest.  
• Podcast logistics ("on this show we talk about…", "let's switch gears…").  
• Pure narrative transitions ("let's go back to development").  
• One-off personal anecdotes that do not generalize.  
• Observations without mechanisms or explanations.  
• Statements whose meaning depends on conversational context.  
• High-level platitudes ("biology is complex", "hormones matter").

DO extract (when they illustrate principles or protocols):

• Specific examples of foods, exercises, practices, or protocols (e.g., "eggs, cheese, and Greek yogurt for breakfast; salmon, venison, or chicken breast with quinoa for lunch").  
• Concrete illustrations that help readers understand how to apply the insight in their own lives.  
• Practical examples that make abstract principles tangible and actionable.  

====================================================================
NUMERIC DETAIL PRESERVATION
====================================================================

Preserve ALL important numeric details:
• Lab value thresholds, ranges, percentages
• Doses (mg, IU, etc.)
• Frequencies (times per week, hours per night)
• Durations (weeks, months, years)
• Population qualifiers (e.g., postmenopausal women, people with T2DM, elite athletes)
• Context qualifiers (e.g., fasting state, post-exercise, on medication)

====================================================================
INSIGHT TYPES
====================================================================

Protocol – concrete action or threshold  
Explanation – how or why something works  
Mechanism – biological / developmental / psychological / evolutionary process  
Warning – risk, trade-off, contraindication  
Anecdote – ONLY if it clearly illustrates a generalizable principle  
Controversy – mixed or uncertain evidence  
Other – rare

====================================================================
EVIDENCE TYPE
====================================================================

Choose one: RCT | Cohort | MetaAnalysis | CaseSeries | Mechanistic | Animal | ExpertOpinion | Other  
If evidence is not described in the transcript, choose the most appropriate type (often ExpertOpinion).

====================================================================
CONFIDENCE
====================================================================

- "high" when claim is strongly supported (multiple RCTs, meta-analyses, or very strong consensus).
- "medium" when supported but not definitive, or based on a mix of data and expert opinion.
- "low" when speculative, early data, conflicting studies, or the speaker emphasizes uncertainty.

====================================================================
IMPORTANCE (1–3)
====================================================================

3 = Core idea that shapes understanding of the topic  
2 = Helpful idea that would appear as a secondary bullet in high-quality show notes  
1 = Background nuance; include only if still conceptually meaningful

====================================================================
ACTIONABILITY
====================================================================

High = Directly guides decisions  
Medium = Influences interpretation or reasoning  
Low = Mainly conceptual background

====================================================================
AUDIENCE
====================================================================

Patient | Clinician | Both

====================================================================
WRITING STYLE
====================================================================

• 1–3 sentences per insight.  
• Write in clear, accessible language for smart laypeople.  
• Briefly define jargon when necessary.  
• Never include speaker names, podcast references, or conversational context.  
• Include specific, practical examples when they help illustrate how to apply a principle or protocol (e.g., specific foods, exercises, timing, or practices).  
• If an insight requires context from earlier in the conversation, include that context in the statement or context_note field.

====================================================================
OUTPUT FORMAT (STRICT JSON)
====================================================================

Return EXACTLY this structure:

{"insights":[
  {
    "statement": "...",
    "context_note": "...",
    "evidence_type": "...",
    "qualifiers": {
      "population": "...",
      "dose": "...",
      "duration": "...",
      "outcome": "...",
      "effect_size": "..."
    },
    "confidence": "...",
    "importance": 1 | 2 | 3,
    "actionability": "...",
    "primary_audience": "...",
    "insight_type": "..."
  }
]}

If no high-value insights are present in the chunk, return:

{"insights":[]}
`

// Use optimized prompt by default, but can be switched via feature flag
const EXTRACTION_SYSTEM_PROMPT = USE_OPTIMIZED_PROMPT 
  ? EXTRACTION_SYSTEM_PROMPT_OPTIMIZED 
  : EXTRACTION_SYSTEM_PROMPT_ORIGINAL

async function extractInsightsFromChunk(chunkContent: string, chunkIndex?: number, totalChunks?: number, previousChunkContext?: string): Promise<{ insights: Insight[], tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  let userPrompt: string
  if (previousChunkContext) {
    userPrompt = `Previous context (for reference only):
${previousChunkContext}

Current text to analyze:
${chunkContent}`
  } else {
    userPrompt = `Text to analyze:
${chunkContent}`
  }

  const chunkLabel = chunkIndex !== undefined ? `Chunk ${chunkIndex + 1}/${totalChunks || '?'}` : 'Chunk'

  try {
    console.log(`[${chunkLabel}] Calling OpenAI API with model: gpt-5-mini`)
    console.log(`[${chunkLabel}] Chunk content length: ${chunkContent.length} chars`)
    
    // Use retry helper for OpenAI API call
    const completion = await callOpenAIWithRetry(
      () => getOpenAI().chat.completions.create({
        model: 'gpt-5-mini', // GPT-5 Mini: Better performance with cost efficiency, 400K context window
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        // Note: gpt-5-mini only supports default temperature (1), custom values are not supported
        response_format: { type: 'json_object' }
      }),
      2, // maxRetries = 2 (3 total attempts)
      chunkLabel
    )

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
    const normalizedInsights = parsed.insights.map(insight => {
      // Map 'Background' actionability to 'Low' for backward compatibility
      let actionability = insight.actionability ?? 'Medium'
      if (actionability === 'Background') {
        actionability = 'Low'
      }
      
      return {
        ...insight,
        importance: insight.importance ?? 2,
        actionability: actionability as 'Low' | 'Medium' | 'High',
        primary_audience: insight.primary_audience ?? 'Both',
        insight_type: insight.insight_type ?? 'Explanation',
        context_note: insight.context_note ?? null,
      }
    })

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
      // (These should have been caught by retry helper, but handle them here as fallback)
      const errorStatus = (error as any).status
      const errorCode = (error as any).code
      
      // Fatal errors: authentication, invalid API key, model not found, etc.
      if (errorStatus === 401 || errorStatus === 403 || errorCode === 'invalid_api_key' || errorCode === 'model_not_found') {
        throw new Error(`Fatal API error at ${chunkLabel}: ${error.message}`)
      }
      
      // If we get here after retries, it's a persistent transient error or unexpected error
      // Log and return empty array to continue processing other chunks
      console.warn(`[${chunkLabel}] Error after retries, returning empty insights array, continuing with next chunk`)
      return { insights: [], tokenUsage: undefined }
    }
    // If error is not an Error instance, return empty array
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
 * Retry helper for OpenAI API calls with exponential backoff and timeout
 * Retries on transient errors (429 rate limit, 5xx server errors)
 * Fails immediately on fatal errors (401, 403, model_not_found, etc.)
 * Times out after 60 seconds to prevent hanging
 */
async function callOpenAIWithRetry<T>(
  apiCall: () => Promise<T>,
  maxRetries: number = 2,
  label?: string,
  timeoutMs: number = 300000 // 5 minute timeout (300 seconds) - allows for longer processing of complex chunks
): Promise<T> {
  let lastError: any
  
  // Helper to create a timeout promise
  const createTimeout = (ms: number): Promise<never> => {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Request timeout after ${ms}ms`))
      }, ms)
    })
  }
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Race between API call and timeout
      const result = await Promise.race([
        apiCall(),
        createTimeout(timeoutMs)
      ])
      return result
    } catch (error: any) {
      lastError = error
      const errorStatus = error?.status
      const errorCode = error?.code
      const isTimeout = error?.message?.includes('timeout') || error?.name === 'TimeoutError'
      
      // Timeout errors: retry if we have attempts left
      if (isTimeout && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
        const logLabel = label ? `[${label}] ` : ''
        console.warn(`${logLabel}Request timeout (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${backoffMs}ms...`)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        continue
      }
      
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
 * Split text into overlapping chunks
 */
function splitIntoChunks(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE, overlapSize: number = DEFAULT_CHUNK_OVERLAP): string[] {
  // Safety check: if entire text is longer than chunk size and has no structure, force split
  if (text.length > chunkSize && !text.includes('\n\n')) {
    console.log(`[Chunking] Text (${text.length} chars) has no paragraph breaks, forcing character-based split`)
    const chunks: string[] = []
    let start = 0
    let iterations = 0
    const maxIterations = Math.ceil(text.length / (chunkSize - overlapSize)) + 10 // Safety limit
    
    while (start < text.length && iterations < maxIterations) {
      iterations++
      let end = Math.min(start + chunkSize, text.length)
      
      // If not at the end, try to break at a word boundary
      if (end < text.length) {
        const searchStart = Math.max(start, end - 300)
        const searchText = text.substring(searchStart, end)
        const lastSpace = searchText.lastIndexOf(' ')
        const lastPeriod = searchText.lastIndexOf('.')
        const lastExclamation = searchText.lastIndexOf('!')
        const lastQuestion = searchText.lastIndexOf('?')
        const bestBreak = Math.max(lastSpace, lastPeriod, lastExclamation, lastQuestion)
        
        if (bestBreak > 50) {
          end = searchStart + bestBreak + 1
        }
      }
      
      const chunk = text.substring(start, end).trim()
      if (chunk.length > 0) {
        chunks.push(chunk)
      }
      
      // Calculate next start position with overlap
      const nextStart = end - overlapSize
      // Ensure we always advance (safety check)
      if (nextStart <= start) {
        start = end // Force advance if overlap calculation would keep us stuck
      } else {
        start = nextStart
      }
      
      // Final safety: if we're at the end, break
      if (end >= text.length) {
        break
      }
    }
    
    if (iterations >= maxIterations) {
      console.error(`[Chunking] WARNING: Hit max iterations (${maxIterations}), possible infinite loop detected`)
    }
    
    const result = chunks.filter(chunk => chunk.length > 0)
    console.log(`[Chunking] Character-based split created ${result.length} chunks from unstructured text`)
    return result
  }
  
  // First split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  console.log(`[Chunking] Found ${paragraphs.length} paragraphs`)
  
  // If we only have one paragraph and it's very long, try to split it
  if (paragraphs.length === 1 && paragraphs[0].length > chunkSize) {
    const longParagraph = paragraphs[0]
    
    // Try splitting by sentences first
    // Match: period/exclamation/question mark, followed by space and capital letter, or end of string
    const sentencePattern = /([.!?])\s+(?=[A-Z])|([.!?])(?=\s*$)/g
    const sentences = longParagraph.split(sentencePattern).filter(s => s && s.trim().length > 0)
    
    // If sentence splitting worked and we got multiple sentences, use that
    if (sentences.length > 1) {
      const chunks: string[] = []
      let currentChunk = ''
      
      // Reconstruct sentences (split includes delimiters, so we need to merge them back)
      let reconstructedSentences: string[] = []
      for (let i = 0; i < sentences.length; i++) {
        const part = sentences[i].trim()
        if (!part) continue
        
        // If this looks like punctuation followed by space, merge with previous
        if (/^[.!?]\s*$/.test(part) && reconstructedSentences.length > 0) {
          reconstructedSentences[reconstructedSentences.length - 1] += part
        } else {
          reconstructedSentences.push(part)
        }
      }
      
      // Merge adjacent parts that are just punctuation
      const finalSentences: string[] = []
      for (let i = 0; i < reconstructedSentences.length; i++) {
        if (i > 0 && /^[.!?]\s*$/.test(reconstructedSentences[i])) {
          finalSentences[finalSentences.length - 1] += reconstructedSentences[i]
        } else {
          finalSentences.push(reconstructedSentences[i])
        }
      }
      
      for (const sentence of finalSentences) {
        const trimmedSentence = sentence.trim()
        if (!trimmedSentence) continue
        
        // If adding this sentence would exceed chunk size, save current chunk and start new one
        if (currentChunk.length + trimmedSentence.length + 1 > chunkSize && currentChunk.length > 0) {
          chunks.push(currentChunk.trim())
          
          // Start new chunk with overlap from end of previous chunk
          const overlap = currentChunk.slice(-overlapSize)
          currentChunk = overlap + ' ' + trimmedSentence
        } else {
          // Add sentence to current chunk
          if (currentChunk) {
            currentChunk += ' ' + trimmedSentence
          } else {
            currentChunk = trimmedSentence
          }
        }
      }
      
      // Don't forget the last chunk
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim())
      }
      
      // If we successfully created multiple chunks, return them
      if (chunks.length > 1) {
        return chunks.filter(chunk => chunk.length > 0)
      }
    }
    
    // Fallback: If sentence splitting didn't work or only created one chunk, 
    // force split by character count at word boundaries
    console.log(`[Chunking] Long paragraph (${longParagraph.length} chars) couldn't be split by sentences, forcing character-based split`)
    const chunks: string[] = []
    let start = 0
    let iterations = 0
    const maxIterations = Math.ceil(longParagraph.length / (chunkSize - overlapSize)) + 10 // Safety limit
    
    while (start < longParagraph.length && iterations < maxIterations) {
      iterations++
      let end = Math.min(start + chunkSize, longParagraph.length)
      
      // If not at the end, try to break at a word boundary
      if (end < longParagraph.length) {
        // Look for the last space, period, exclamation, question mark, or newline within the last 300 chars
        const searchStart = Math.max(start, end - 300)
        const searchText = longParagraph.substring(searchStart, end)
        const lastSpace = searchText.lastIndexOf(' ')
        const lastPeriod = searchText.lastIndexOf('.')
        const lastExclamation = searchText.lastIndexOf('!')
        const lastQuestion = searchText.lastIndexOf('?')
        const lastNewline = searchText.lastIndexOf('\n')
        const bestBreak = Math.max(lastSpace, lastPeriod, lastExclamation, lastQuestion, lastNewline)
        
        if (bestBreak > 50) { // Only use if we found a break point that's not too close to the start
          end = searchStart + bestBreak + 1
        }
      }
      
      const chunk = longParagraph.substring(start, end).trim()
      if (chunk.length > 0) {
        chunks.push(chunk)
      }
      
      // Calculate next start position with overlap
      const nextStart = end - overlapSize
      // Ensure we always advance (safety check)
      if (nextStart <= start) {
        start = end // Force advance if overlap calculation would keep us stuck
      } else {
        start = nextStart
      }
      
      // Final safety: if we're at the end, break
      if (end >= longParagraph.length) {
        break
      }
    }
    
    if (iterations >= maxIterations) {
      console.error(`[Chunking] WARNING: Hit max iterations (${maxIterations}), possible infinite loop detected`)
    }
    
    const result = chunks.filter(chunk => chunk.length > 0)
    console.log(`[Chunking] Character-based split created ${result.length} chunks`)
    return result
  }
  
  // Original paragraph-based chunking for text with proper paragraph breaks
  const chunks: string[] = []
  let currentChunk = ''
  
  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim()
    
    // If paragraph itself is larger than chunk size, split it by sentences
    if (trimmedParagraph.length > chunkSize) {
      // Save current chunk if it has content
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim())
        currentChunk = ''
      }
      
      // Split large paragraph by sentences
      // Use positive lookahead to keep punctuation with the sentence
      const sentences = trimmedParagraph.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/).filter(s => s.trim().length > 0)
      let paragraphChunk = ''
      
      for (const sentence of sentences) {
        const trimmedSentence = sentence.trim()
        if (!trimmedSentence) continue
        
        if (paragraphChunk.length + trimmedSentence.length + 1 > chunkSize && paragraphChunk.length > 0) {
          chunks.push(paragraphChunk.trim())
          const overlap = paragraphChunk.slice(-overlapSize)
          paragraphChunk = overlap + ' ' + trimmedSentence
        } else {
          paragraphChunk = paragraphChunk ? paragraphChunk + ' ' + trimmedSentence : trimmedSentence
        }
      }
      
      if (paragraphChunk.trim().length > 0) {
        currentChunk = paragraphChunk.trim()
      }
      continue
    }
    
    // If adding this paragraph would exceed chunk size, save current chunk and start new one
    if (currentChunk.length + trimmedParagraph.length + 2 > chunkSize && currentChunk.length > 0) {
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
  
  const result = chunks.filter(chunk => chunk.length > 0)
  
  // Final safety check: if any chunk is way too large, force split it
  const finalChunks: string[] = []
  for (const chunk of result) {
    if (chunk.length > chunkSize * 2) {
      console.warn(`[Chunking] Found oversized chunk (${chunk.length} chars), force splitting by character count`)
      // Force split this chunk
      let start = 0
      while (start < chunk.length) {
        let end = Math.min(start + chunkSize, chunk.length)
        // Try to break at word boundary
        if (end < chunk.length) {
          const searchStart = Math.max(start, end - 200)
          const searchText = chunk.substring(searchStart, end)
          const lastSpace = searchText.lastIndexOf(' ')
          if (lastSpace > 20) {
            end = searchStart + lastSpace + 1
          }
        }
        const subChunk = chunk.substring(start, end).trim()
        if (subChunk.length > 0) {
          finalChunks.push(subChunk)
        }
        start = Math.max(0, end - overlapSize)
        if (start >= end - overlapSize && end < chunk.length) {
          start = end
        }
        if (end >= chunk.length) break
      }
    } else {
      finalChunks.push(chunk)
    }
  }
  
  return finalChunks.filter(chunk => chunk.length > 0)
}

/**
 * Process a source from plain text transcript
 */
export async function processSourceFromPlainText(
  sourceId: string, 
  text: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const startTime = Date.now()
  let chunksCreated = 0
  let chunksProcessed = 0
  let chunksWithInsights = 0
  let chunksWithoutInsights = 0
  let insightsCreated = 0
  let processingError: Error | null = null
  let runId: string | null = null

  try {
    // Create run record at START with status 'processing'
    // This ensures we have a record even if processing is interrupted
    const { data: newRun, error: createRunError } = await supabaseAdmin
      .from('source_processing_runs')
      .insert({
        source_id: sourceId,
        processed_at: new Date(startTime).toISOString(),
        chunks_created: 0, // Will be updated after chunking
        chunks_processed: 0,
        chunks_with_insights: 0,
        chunks_without_insights: 0,
        total_insights_created: 0,
        processing_duration_seconds: 0,
        status: 'processing',
        error_message: null
      })
      .select('id')
      .single()

    if (createRunError || !newRun) {
      console.error('Failed to create processing run record at start:', createRunError)
      // Continue processing even if run record creation fails
    } else {
      runId = newRun.id
      console.log(`Created processing run record: ${runId}`)
    }

    // 1. Split text into chunks
    console.log(`[Chunking] Input text length: ${text.length} characters`)
    let chunks: string[]
    try {
      chunks = splitIntoChunks(text)
      chunksCreated = chunks.length
      console.log(`[Chunking] Split transcript into ${chunks.length} chunks`)
      if (chunks.length > 0) {
        console.log(`[Chunking] Chunk sizes: ${chunks.map(c => c.length).join(', ')} characters`)
        // Validate chunk sizes - warn if any chunk is way too large
        const oversizedChunks = chunks.filter((c, i) => c.length > DEFAULT_CHUNK_SIZE * 2)
        if (oversizedChunks.length > 0) {
          console.error(`[Chunking] WARNING: Found ${oversizedChunks.length} chunks larger than 2x chunk size (${DEFAULT_CHUNK_SIZE * 2} chars)`)
          oversizedChunks.forEach((c, i) => {
            const chunkIndex = chunks.indexOf(c)
            console.error(`[Chunking] Chunk ${chunkIndex + 1} is ${c.length} chars (expected ~${DEFAULT_CHUNK_SIZE})`)
          })
        }
      }
    } catch (chunkingError) {
      console.error('[Chunking] Error during chunking:', chunkingError)
      throw new Error(`Failed to split text into chunks: ${chunkingError instanceof Error ? chunkingError.message : 'Unknown error'}`)
    }
    
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
      run_id: runId, // Link chunks to the processing run
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

    // Update run record with chunks_created now that chunking is complete
    if (runId) {
      const { error: updateError } = await supabaseAdmin
        .from('source_processing_runs')
        .update({
          chunks_created: chunksCreated
        })
        .eq('id', runId)
      
      if (updateError) {
        console.error('Failed to update run record with chunks_created:', updateError)
      } else {
        console.log(`Updated run record: chunks_created = ${chunksCreated}`)
      }
    }

    // 3. Process each chunk to extract insights
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalTokens = 0
    let previousChunkContent: string | undefined = undefined
  
    for (const chunk of chunkInserts) {
      const chunkIndex = chunkInserts.indexOf(chunk) + 1
      console.log(`\n[${chunk.locator}] Processing chunk ${chunkIndex}/${chunkInserts.length} (sequential order: ${chunkIndex})`)
      console.log(`[${chunk.locator}] Content length: ${chunk.content.length} characters`)
      console.log(`[${chunk.locator}] Content preview: ${chunk.content.substring(0, 150)}...`)
      console.log(`[${chunk.locator}] Run ID: ${runId || 'none'}`)
      
      onProgress?.({
        stage: 'extracting',
        chunksProcessed,
        totalChunks: chunkInserts.length,
        insightsCreated,
        message: `Processing chunk ${chunk.locator} (${chunksProcessed + 1}/${chunkInserts.length})...`,
        tokenUsage: totalTokens > 0 ? {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalTokens
        } : undefined
      })
      
      // Prepare previous chunk context (last 300 chars, or whole chunk if < 300 chars)
      let previousChunkContext: string | undefined = undefined
      if (previousChunkContent) {
        if (previousChunkContent.length <= 300) {
          previousChunkContext = previousChunkContent
        } else {
          previousChunkContext = previousChunkContent.slice(-300)
        }
      }
      
      // Validate chunk size before processing
      if (chunk.content.length > DEFAULT_CHUNK_SIZE * 3) {
        console.error(`[${chunk.locator}] ❌ Chunk is too large (${chunk.content.length} chars, max expected: ${DEFAULT_CHUNK_SIZE * 3})`)
        console.error(`[${chunk.locator}] This chunk should have been split but wasn't. Skipping to prevent API errors.`)
        chunksProcessed++
        chunksWithoutInsights++
        continue
      }
      
      let insights: Insight[]
      let chunkTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
      try {
        const result = await extractInsightsFromChunk(chunk.content, chunksProcessed, chunkInserts.length, previousChunkContext)
        insights = result.insights
        chunkTokenUsage = result.tokenUsage
        
        if (chunkTokenUsage) {
          totalPromptTokens += chunkTokenUsage.promptTokens
          totalCompletionTokens += chunkTokenUsage.completionTokens
          totalTokens += chunkTokenUsage.totalTokens
        }
        
        // Store current chunk content for next iteration
        previousChunkContent = chunk.content
      } catch (chunkError) {
        console.error(`[${chunk.locator}] ❌ Fatal error extracting insights from chunk:`, chunkError)
        const errorMessage = chunkError instanceof Error ? chunkError.message : "Unknown error during extraction"
        const errorStack = chunkError instanceof Error ? chunkError.stack : undefined
        throw new Error(`Failed to process chunk ${chunk.locator} (${chunksProcessed + 1}/${chunkInserts.length}): ${errorMessage}${errorStack ? `\n\nStack: ${errorStack}` : ''}`)
      }
      
      // Track that we successfully completed extraction for this chunk
      chunksProcessed++
      console.log(`[${chunk.locator}] Got ${insights.length} insights from extraction`)
      
      if (insights.length === 0) {
        chunksWithoutInsights++
        console.warn(`[${chunk.locator}] ⚠️ No insights extracted`)
        console.warn(`[${chunk.locator}] Chunk size: ${chunk.content.length} chars`)
        console.warn(`[${chunk.locator}] Chunk preview: ${chunk.content.substring(0, 200)}...`)
        if (chunkTokenUsage) {
          console.warn(`[${chunk.locator}] API call succeeded (tokens: ${chunkTokenUsage.totalTokens}), but no insights returned`)
        } else {
          console.warn(`[${chunk.locator}] No token usage info - API call may have failed silently`)
        }
        // Don't fail the whole process if one chunk has no insights, but log it
        continue
      }

      chunksWithInsights++

      // 4. For each insight, always create a new raw insight row
      // No hash-based deduplication - every extraction is a distinct raw insight
      for (const insight of insights) {
        const insightHash = computeInsightHash(insight.statement)

        // Map 'Background' to 'Low' before inserting
        let actionability = insight.actionability ?? 'Medium'
        if (actionability === 'Background') {
          actionability = 'Low'
        }

        // Optional: Check if another insight with same hash has an embedding we can reuse
        let embeddingToReuse: number[] | null = null
        try {
          const { data: existingWithEmbedding } = await supabaseAdmin
            .from('insights')
            .select('embedding')
            .eq('insight_hash', insightHash)
            .not('embedding', 'is', null)
            .limit(1)
            .single()
          
          if (existingWithEmbedding?.embedding) {
            embeddingToReuse = existingWithEmbedding.embedding as number[]
            console.log(`[${chunk.locator}] Found existing embedding for hash ${insightHash.substring(0, 8)}..., will reuse`)
          }
        } catch (error) {
          // No existing embedding found, will generate new one
        }
        
        // Always insert a new raw insight row
        const { data: newInsight, error: insertError } = await supabaseAdmin
          .from('insights')
          .insert({
            statement: insight.statement,
            context_note: insight.context_note || null,
            evidence_type: insight.evidence_type,
            qualifiers: insight.qualifiers,
            confidence: insight.confidence,
            insight_hash: insightHash, // Keep hash for potential embedding reuse / analysis
            importance: insight.importance ?? 2,
            actionability: actionability as 'Low' | 'Medium' | 'High',
            primary_audience: insight.primary_audience ?? 'Both',
            insight_type: insight.insight_type ?? 'Explanation',
            needs_tagging: true, // Mark for async auto-tagging batch job
            // New raw layer fields
            source_id: sourceId,
            locator: chunk.locator,
            start_ms: null, // Chunks from text don't have timestamps
            end_ms: null, // Chunks from text don't have timestamps
            run_id: runId,
            unique_insight_id: null, // Not yet merged into a unique insight
            embedding: embeddingToReuse // Reuse if available, otherwise will be generated async
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

        const insightId = newInsight.id
        insightsCreated++
        console.log(`[${chunk.locator}] ✓ Created new raw insight ${insightId.substring(0, 8)}... with hash ${insightHash.substring(0, 8)}...`)
        
        // Generate embedding asynchronously if we didn't reuse one (fire-and-forget to avoid blocking)
        if (!embeddingToReuse) {
          ;(async () => {
            try {
              const embedding = await generateInsightEmbedding(insight)
              await supabaseAdmin
                .from('insights')
                .update({ embedding })
                .eq('id', insightId)
              console.log(`[${chunk.locator}] ✓ Generated embedding for insight ${insightId.substring(0, 8)}...`)
            } catch (error) {
              // Log but don't fail - embedding generation is non-critical
              console.warn(`[${chunk.locator}] ⚠ Failed to generate embedding for insight ${insightId.substring(0, 8)}...:`, error)
            }
          })()
        }
        
        // NOTE: Auto-tagging has been moved to the async batch job
        // (/api/admin/insights/autotag-batch). This pipeline only extracts insights.
        // New insights are marked with needs_tagging = true for later processing.
        
        onProgress?.({
          stage: 'extracting',
          chunksProcessed,
          totalChunks: chunkInserts.length,
          insightsCreated,
          message: `Created ${insightsCreated} insights so far...`
        })

        // 5. Link insight to source (insert into insight_sources for backward compatibility)
        // Note: New code should use insights.source_id directly, but we keep this for legacy compatibility
        // CRITICAL: This link must succeed - if it fails, we have an orphaned insight
        const { error: linkError } = await supabaseAdmin
          .from('insight_sources')
          .insert({
            insight_id: insightId,
            source_id: sourceId,
            run_id: runId, // Link insight_sources to the processing run
            locator: chunk.locator,
            start_ms: null, // Chunks from text don't have timestamps
            end_ms: null // Chunks from text don't have timestamps
          })

        if (linkError) {
          // Duplicate link is okay (might happen if reprocessing)
          if (linkError.message.includes('duplicate') || linkError.message.includes('unique')) {
            console.log(`[${chunk.locator}] ✓ Linked insight ${insightId.substring(0, 8)}... (or already linked)`)
          } else {
            // Non-duplicate error: this is a problem - we have an orphaned insight
            // Delete the orphaned insight to maintain data integrity
            console.error(`[${chunk.locator}] ❌ Failed to link insight ${insightId.substring(0, 8)}... to source:`, linkError)
            console.error(`[${chunk.locator}] Deleting orphaned insight ${insightId.substring(0, 8)}... to maintain data integrity`)
            const { error: deleteError } = await supabaseAdmin
              .from('insights')
              .delete()
              .eq('id', insightId)
            
            if (deleteError) {
              console.error(`[${chunk.locator}] ❌ Failed to delete orphaned insight ${insightId.substring(0, 8)}...:`, deleteError)
            } else {
              console.log(`[${chunk.locator}] ✓ Deleted orphaned insight ${insightId.substring(0, 8)}...`)
              insightsCreated-- // Adjust count since we're removing this insight
            }
          }
        } else {
          console.log(`[${chunk.locator}] ✓ Linked insight ${insightId.substring(0, 8)}... to source`)
        }
      }

      // Update run record after each chunk is processed
      // This provides real-time progress and ensures we have accurate state if interrupted
      if (runId) {
        const currentDuration = (Date.now() - startTime) / 1000
        const { error: updateError } = await supabaseAdmin
          .from('source_processing_runs')
          .update({
            chunks_created: chunksCreated, // Always include - fixes runs that started before this was set
            chunks_processed: chunksProcessed,
            chunks_with_insights: chunksWithInsights,
            chunks_without_insights: chunksWithoutInsights,
            total_insights_created: insightsCreated,
            processing_duration_seconds: currentDuration
          })
          .eq('id', runId)
        
        if (updateError) {
          console.error(`[${chunk.locator}] Failed to update run record during processing:`, updateError)
        } else {
          // Log if we're fixing a run that had chunks_created = 0
          if (chunksCreated > 0 && chunksProcessed > 0) {
            console.log(`[${chunk.locator}] Updated run record: ${chunksProcessed}/${chunksCreated} chunks processed`)
          }
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
  } catch (error) {
    // Capture error for saving to processing run record
    processingError = error instanceof Error ? error : new Error(String(error))
    throw error
  } finally {
    // Always update processing run record, even if processing failed
    const endTime = Date.now()
    const processingDurationSeconds = (endTime - startTime) / 1000
    const status = processingError || chunksProcessed < chunksCreated ? 'failed' : 'success'
    
    if (runId) {
      // Update existing run record
      const { error: updateError } = await supabaseAdmin
        .from('source_processing_runs')
        .update({
          chunks_created: chunksCreated,
          chunks_processed: chunksProcessed,
          chunks_with_insights: chunksWithInsights,
          chunks_without_insights: chunksWithoutInsights,
          total_insights_created: insightsCreated,
          processing_duration_seconds: processingDurationSeconds,
          status,
          error_message: processingError ? processingError.message : null
        })
        .eq('id', runId)

      if (updateError) {
        console.error('Failed to update processing run record:', updateError)
      } else {
        console.log(`Updated processing run record: ${status}, ${chunksProcessed}/${chunksCreated} chunks processed`)
      }
    } else {
      // Fallback: insert new record if creation at start failed
      const { error: insertError } = await supabaseAdmin
        .from('source_processing_runs')
        .insert({
          source_id: sourceId,
          processed_at: new Date(startTime).toISOString(),
          chunks_created: chunksCreated,
          chunks_processed: chunksProcessed,
          chunks_with_insights: chunksWithInsights,
          chunks_without_insights: chunksWithoutInsights,
          total_insights_created: insightsCreated,
          processing_duration_seconds: processingDurationSeconds,
          status,
          error_message: processingError ? processingError.message : null
        })

      if (insertError) {
        console.error('Failed to save processing run record (fallback):', insertError)
      } else {
        console.log(`Saved processing run record (fallback): ${status}, ${chunksProcessed}/${chunksCreated} chunks processed`)
      }
    }
  }
}