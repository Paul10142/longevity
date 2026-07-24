/**
 * Extraction stage (v2): transcript → chunks → raw_insights.
 *
 * Ported from the v1 lib/pipeline.ts, restructured to:
 *  - write immutable `raw_insights` (never dedup here — that's consolidation),
 *  - checkpoint per chunk so a killed worker resumes,
 *  - embed each chunk's insights in one batched call.
 *
 * Deduplication, tagging, and synthesis are separate job stages.
 */

import { supabaseAdmin } from './supabaseServer'
import { generateEmbeddingsBatch, insightEmbeddingText } from './embeddings'
import { finishRun, failRun } from './pipelineRuns'
import { claudeJson, CLAUDE_BULK_MODEL } from './llm'
import { stripNonContent } from './transcriptHygiene'
import {
  normalizeYouTubeSegments,
  buildTranscriptFromSegments,
  computeChunkTimings,
  type TimedSegment,
  type ChunkTiming,
} from './transcriptSegments'
import type { EvidenceType, Confidence, Actionability, Audience, InsightType, InsightQualifiers } from './types'

// Bulk tier: one call per transcript chunk, so this is the pipeline's
// highest-volume model by a wide margin.
const EXTRACTION_MODEL = CLAUDE_BULK_MODEL
const CHUNK_SIZE = 2400
const CHUNK_OVERLAP = 200

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

// ── Extracted-insight shape (LLM output) ────────────────────
type ExtractedInsight = {
  statement: string
  context_note?: string | null
  direct_quote?: string | null   // verbatim span from the chunk supporting the insight
  evidence_type: EvidenceType
  qualifiers?: InsightQualifiers | null
  confidence: Confidence
  importance?: 1 | 2 | 3
  actionability?: Actionability
  primary_audience?: Audience
  insight_type?: InsightType
}

// ── Prompt (ported verbatim from the v1 optimized prompt) ───
const EXTRACTION_SYSTEM_PROMPT = `
Extract show-note–worthy insights from transcript chunks for a large, multi-source lifestyle and health knowledge base.

Your job is NOT to capture everything that was said. Your job is to extract only the ideas that would appear in polished show notes or an educational article. Prefer FEWER, HIGHER-VALUE, GENERALIZABLE insights over many small, conversational, or anecdotal ones.

PURPOSE (CRITICAL)
The insights you produce will be merged with insights from thousands of other chunks and sources to form a unified knowledge base. Because they will be recombined across episodes, each insight must:
• Stand alone without relying on the surrounding conversation.
• Express generalizable, durable knowledge—NOT episode-specific details.
• Capture mechanisms, principles, evolutionary logic, or explanatory frameworks.
• Translate personal anecdotes into the *underlying principle* rather than retelling the story.
• Include specific, practical examples (foods, practices, protocols) that help readers apply the insight.
• Avoid any dependency on host interactions, podcast structure, or context.

STITCHABILITY (CRITICAL)
Write each insight so it can combine cleanly with insights from other chunks, episodes, and sources:
• No references to "earlier we discussed…", "as you said…", or speaker names.
• No reliance on personal anecdotes unless the insight explicitly states the principle illustrated.
• Clear, standalone phrasing that conveys a durable meaning.
• Emphasis on mechanisms, frameworks, and conceptual distinctions, supported by concrete examples when helpful.

WHAT COUNTS AS A HIGH-VALUE INSIGHT
Produce an insight ONLY if it is: conceptually important; generalizable beyond the transcript; mechanistic or explanatory; self-contained and clear; and non-obvious (avoid generic statements like "testosterone affects behavior"—extract the deeper takeaway).

WHAT SHOULD NOT BECOME AN INSIGHT
Never extract: host anecdotes, jokes, or personal reflections; biographical info about the guest; podcast logistics ("on this show we talk about…"); narrative transitions; one-off anecdotes that don't generalize; observations without mechanism; context-dependent statements; platitudes ("biology is complex").
DO extract concrete examples of foods, exercises, practices, or protocols when they illustrate a principle.

NUMERIC DETAIL PRESERVATION
Preserve ALL important numeric details: lab thresholds, ranges, percentages, doses (mg, IU), frequencies (times/week, hours/night), durations, population qualifiers (e.g. postmenopausal women, T2DM, elite athletes), and context qualifiers (fasting, post-exercise, on medication).

INSIGHT TYPES
Protocol – concrete action or threshold; Explanation – how/why something works; Mechanism – biological/developmental/evolutionary process; Warning – risk, trade-off, contraindication; Anecdote – ONLY if it illustrates a generalizable principle; Controversy – mixed/uncertain evidence; Other – rare.

EVIDENCE TYPE
Choose one: RCT | Cohort | MetaAnalysis | CaseSeries | Mechanistic | Animal | ExpertOpinion | Other. If evidence isn't described, choose the most appropriate type (often ExpertOpinion).

CONFIDENCE
"high" = strongly supported (multiple RCTs, meta-analyses, strong consensus); "medium" = supported but not definitive, or a mix of data and expert opinion; "low" = speculative, early, conflicting, or the speaker emphasizes uncertainty.

IMPORTANCE (1–3)
3 = core idea that shapes understanding; 2 = helpful secondary bullet; 1 = background nuance.

ACTIONABILITY: High = directly guides decisions; Medium = influences interpretation; Low = conceptual background.
AUDIENCE: Patient | Clinician | Both.

WRITING STYLE
1–3 sentences per insight; clear accessible language; briefly define jargon; never include speaker names or podcast references; include practical examples when they help; if context from earlier is required, put it in the statement or context_note.

DIRECT QUOTE (for verifiability)
For each insight, also return "direct_quote": the SHORTEST verbatim span copied EXACTLY from the chunk text above that best supports the insight — same words, punctuation, and casing, no paraphrasing or ellipses. This is used to quote the source precisely, so it must appear character-for-character in the chunk. If no single span cleanly supports it, return null.

OUTPUT FORMAT (STRICT JSON)
{"insights":[{"statement":"...","context_note":"...","direct_quote":"exact words from the chunk or null","evidence_type":"...","qualifiers":{"population":"...","dose":"...","duration":"...","outcome":"...","effect_size":"..."},"confidence":"...","importance":1|2|3,"actionability":"...","primary_audience":"...","insight_type":"..."}]}
If no high-value insights are present, return {"insights":[]}.
`.trim()

const LOW_VALUE_PATTERNS: RegExp[] = [
  /this (podcast|episode|discussion|conversation) (will|is going to|features?)/i,
  /(two-part|multi-part|part \d+)/i,
  /^(.* )?(is|are) (a|an) (leading|prominent|notable|expert|researcher|scientist|doctor|professor)/i,
  /conflict(s)? of interest/i,
  /no conflict/i,
  /^(this|the) (podcast|episode|discussion|conversation|topic)/i,
]

function isLowValue(statement: string): boolean {
  if (statement.trim().length < 30) return true
  return LOW_VALUE_PATTERNS.some(p => p.test(statement))
}

// ── Enum coercion ───────────────────────────────────────────
// The LLM occasionally returns values outside our allowed sets (e.g.
// "moderate", "Definition", capitalized confidence). Coerce every enum to a
// valid value with a safe fallback so one stray field can never break the
// whole chunk's insert.
const EVIDENCE_TYPES: EvidenceType[] = ['RCT','Cohort','MetaAnalysis','CaseSeries','Mechanistic','Animal','ExpertOpinion','Other']
const INSIGHT_TYPES: InsightType[] = ['Protocol','Explanation','Mechanism','Anecdote','Warning','Controversy','Other']

function coerceEvidenceType(v: unknown): EvidenceType {
  const match = EVIDENCE_TYPES.find(t => t.toLowerCase() === String(v ?? '').toLowerCase())
  return match ?? 'Other'
}
function coerceConfidence(v: unknown): Confidence {
  const s = String(v ?? '').toLowerCase()
  if (s === 'high' || s === 'medium' || s === 'low') return s
  return 'medium'
}
function coerceImportance(v: unknown): 1 | 2 | 3 {
  const n = Number(v)
  return n === 1 || n === 3 ? n : 2
}
function coerceActionability(v: unknown): Actionability {
  const s = String(v ?? '').toLowerCase()
  if (s === 'high') return 'High'
  if (s === 'low' || s === 'background') return 'Low'
  return 'Medium'
}
function coerceAudience(v: unknown): Audience {
  const s = String(v ?? '').toLowerCase()
  if (s === 'patient') return 'Patient'
  if (s === 'clinician') return 'Clinician'
  return 'Both'
}
function coerceInsightType(v: unknown): InsightType {
  const match = INSIGHT_TYPES.find(t => t.toLowerCase() === String(v ?? '').toLowerCase())
  return match ?? 'Other'
}

// ── Chunking (ported from v1 splitIntoChunks) ───────────────
export function splitIntoChunks(text: string, chunkSize = CHUNK_SIZE, overlapSize = CHUNK_OVERLAP): string[] {
  const forceSplit = (input: string): string[] => {
    const out: string[] = []
    let start = 0
    let guard = Math.ceil(input.length / Math.max(1, chunkSize - overlapSize)) + 10
    while (start < input.length && guard-- > 0) {
      let end = Math.min(start + chunkSize, input.length)
      if (end < input.length) {
        const searchStart = Math.max(start, end - 300)
        const window = input.substring(searchStart, end)
        const best = Math.max(
          window.lastIndexOf(' '), window.lastIndexOf('.'),
          window.lastIndexOf('!'), window.lastIndexOf('?'), window.lastIndexOf('\n')
        )
        if (best > 50) end = searchStart + best + 1
      }
      const chunk = input.substring(start, end).trim()
      if (chunk.length > 0) out.push(chunk)
      const next = end - overlapSize
      start = next <= start ? end : next
      if (end >= input.length) break
    }
    return out.filter(c => c.length > 0)
  }

  if (text.length > chunkSize && !text.includes('\n\n')) return forceSplit(text)

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const p = paragraph.trim()
    if (p.length > chunkSize) {
      if (current.trim().length > 0) { chunks.push(current.trim()); current = '' }
      for (const sub of forceSplit(p)) chunks.push(sub)
      continue
    }
    if (current.length + p.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current.trim())
      current = current.slice(-overlapSize) + '\n\n' + p
    } else {
      current = current ? current + '\n\n' + p : p
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim())
  return chunks.filter(c => c.length > 0)
}

// ── LLM extraction for one chunk ────────────────────────────
async function extractFromChunk(content: string, label: string): Promise<ExtractedInsight[]> {
  // Retry transient failures: the claude-code CLI intermittently prefixes prose
  // ("Extracted the following…") so `claudeJson` throws a parse error. Swallowing
  // that as 0 insights silently drops a whole chunk's content, so retry a few
  // times with backoff before giving up (same exclude-only-after-retries pattern
  // as the eval harnesses).
  let parsed: { insights?: ExtractedInsight[] } | null = null
  let lastErr: unknown
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1500 * 2 ** (attempt - 1), 12_000)))
    try {
      parsed = await claudeJson<{ insights?: ExtractedInsight[] }>(
        EXTRACTION_SYSTEM_PROMPT,
        `Text to analyze:\n${content}`,
        8000,
        EXTRACTION_MODEL
      )
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!parsed) {
    console.warn(`[extract ${label}] extraction failed after retries:`, lastErr instanceof Error ? lastErr.message : lastErr)
    return []
  }
  if (!Array.isArray(parsed.insights)) return []

  return parsed.insights
    .filter(i => i && typeof i.statement === 'string' && !isLowValue(i.statement))
    .map(i => ({
      statement: i.statement,
      context_note: i.context_note ?? null,
      direct_quote: typeof i.direct_quote === 'string' && i.direct_quote.trim() ? i.direct_quote.trim() : null,
      evidence_type: coerceEvidenceType(i.evidence_type),
      confidence: coerceConfidence(i.confidence),
      importance: coerceImportance(i.importance),
      actionability: coerceActionability(i.actionability),
      primary_audience: coerceAudience(i.primary_audience),
      insight_type: coerceInsightType(i.insight_type),
      qualifiers: i.qualifiers ?? null,
    }))
}

export type ExtractCheckpoint = {
  chunk_index: number      // next chunk to process
  total_chunks: number
  insights_created: number
}

/**
 * Extract raw insights for one source, resuming from `checkpoint`.
 *
 * On the first call it (re)builds chunks and a pipeline_runs row, then
 * processes chunks one at a time. `onProgress` persists the checkpoint +
 * heartbeat after each chunk so the worker can be killed and resumed.
 * Idempotent per chunk: a chunk's raw_insights are keyed by run_id, and a
 * resumed run only appends chunks at/after the checkpoint.
 */
export async function extractSource(
  sourceId: string,
  checkpoint: Partial<ExtractCheckpoint> | undefined,
  onProgress: (cp: ExtractCheckpoint, runId: string) => Promise<void>,
  timeBudgetMs = 220_000
): Promise<{ done: boolean; checkpoint: ExtractCheckpoint; runId: string }> {
  const started = Date.now()

  // Load transcript + timed segments. Select timed_transcript defensively so
  // extraction still runs if migration 010 has not been applied yet (the column
  // is then absent → we fall back to a select without it and no timing).
  type SourceRow = { id: string; transcript: string | null; timed_transcript?: unknown }
  let source: SourceRow
  {
    const withTiming = await db()
      .from('sources')
      .select('id, transcript, timed_transcript')
      .eq('id', sourceId)
      .single()
    if (withTiming.error && /timed_transcript/.test(withTiming.error.message || '')) {
      const fallback = await db()
        .from('sources')
        .select('id, transcript')
        .eq('id', sourceId)
        .single()
      if (fallback.error || !fallback.data) throw new Error(`Source ${sourceId} not found: ${fallback.error?.message}`)
      source = fallback.data as SourceRow
    } else if (withTiming.error || !withTiming.data) {
      throw new Error(`Source ${sourceId} not found: ${withTiming.error?.message}`)
    } else {
      source = withTiming.data as SourceRow
    }
  }
  if (!source.transcript || source.transcript.trim().length === 0) {
    throw new Error(`Source ${sourceId} has no transcript`)
  }
  const transcript: string = source.transcript
  const timedTranscript: unknown = source.timed_transcript

  // Resume or start a run
  let runId: string = (checkpoint as { run_id?: string })?.run_id ?? ''
  if (!runId) {
    const { data: run, error: runErr } = await db()
      .from('pipeline_runs')
      .insert({ source_id: sourceId, kind: 'extract', status: 'running' })
      .select('id')
      .single()
    if (runErr || !run) throw new Error(`Failed to create pipeline run: ${runErr?.message}`)
    runId = run.id as string

    // Fresh run: clear any prior chunks + reset the source's derived state.
    await db().from('chunks').delete().eq('source_id', sourceId)
    await db().from('sources').update({ processing_status: 'processing', processing_error: null }).eq('id', sourceId)
  }

  try {
  // Chunk texts, per-chunk timing, and chunk ids — resolved identically for a
  // fresh run and a resume so extraction is deterministic across ticks.
  //
  //  - FRESH (no chunks yet): run transcript hygiene ONCE (strip ads/intros/
  //    outros before chunking), chunk the cleaned text, map each chunk onto the
  //    timed segments (start_ms/end_ms), and persist chunk rows carrying both
  //    content and timing.
  //  - RESUME (chunks exist): read the persisted content + timing back. Hygiene
  //    is an LLM pass and must not re-run on every tick — persisting its result
  //    through the chunk rows keeps the pipeline stable and cheap.
  const chunkTexts: string[] = []
  const chunkTimings: (ChunkTiming | null)[] = []
  const chunkIdByIndex = new Map<number, string>()

  const { count: existingChunks } = await db()
    .from('chunks')
    .select('id', { count: 'exact', head: true })
    .eq('source_id', sourceId)

  if (!existingChunks) {
    // Timed segments (empty for manual/pasted transcripts → no timing, which is
    // exactly how the four manual seed sources must behave).
    const segments: TimedSegment[] = normalizeYouTubeSegments(timedTranscript)
    // When we have segments, chunk the transcript rebuilt from them so char
    // offsets line up exactly with the segment index; otherwise chunk the stored
    // transcript as before.
    const rawText = segments.length > 0 ? buildTranscriptFromSegments(segments) : transcript

    // Transcript hygiene — permanent ingestion rule. Conservative; keeps text
    // when unsure and surfaces removed spans for review.
    const { cleaned, removed } = await stripNonContent(rawText)
    if (removed.length > 0) {
      console.warn(
        `[extract ${sourceId}] hygiene removed ${removed.length} non-content span(s):`,
        removed.map(r => `${r.kind}: "${r.preview.slice(0, 60)}"`)
      )
    }

    const texts = splitIntoChunks(cleaned)
    const timings = computeChunkTimings(texts, segments)
    for (let i = 0; i < texts.length; i++) { chunkTexts.push(texts[i]); chunkTimings.push(timings[i]) }

    const rows = texts.map((content, i) => ({
      source_id: sourceId,
      locator: `seg-${String(i + 1).padStart(3, '0')}`,
      content,
      start_ms: timings[i]?.start_ms ?? null,
      end_ms: timings[i]?.end_ms ?? null,
    }))
    const { data: inserted, error: chunkErr } = await db().from('chunks').insert(rows).select('id, locator')
    if (chunkErr) throw new Error(`Failed to insert chunks: ${chunkErr.message}`)
    for (const c of inserted ?? []) {
      const idx = parseInt(c.locator.replace('seg-', ''), 10) - 1
      chunkIdByIndex.set(idx, c.id)
    }
  } else {
    const { data: chunkRows } = await db()
      .from('chunks')
      .select('id, locator, content, start_ms, end_ms')
      .eq('source_id', sourceId)
    const byIdx = new Map<number, { id: string; content: string; start_ms: number | null; end_ms: number | null }>()
    for (const c of chunkRows ?? []) {
      const idx = parseInt(c.locator.replace('seg-', ''), 10) - 1
      chunkIdByIndex.set(idx, c.id)
      byIdx.set(idx, c as { id: string; content: string; start_ms: number | null; end_ms: number | null })
    }
    const total = byIdx.size
    for (let i = 0; i < total; i++) {
      const row = byIdx.get(i)
      chunkTexts.push(row?.content ?? '')
      chunkTimings.push(
        row && row.start_ms != null && row.end_ms != null ? { start_ms: row.start_ms, end_ms: row.end_ms } : null
      )
    }
  }

  const total = chunkTexts.length

  let cp: ExtractCheckpoint = {
    chunk_index: checkpoint?.chunk_index ?? 0,
    total_chunks: total,
    insights_created: checkpoint?.insights_created ?? 0,
  }

  while (cp.chunk_index < total) {
    if (Date.now() - started > timeBudgetMs) {
      // Yield: not done, worker will resume this run on the next tick.
      return { done: false, checkpoint: cp, runId }
    }

    const idx = cp.chunk_index
    const label = `${idx + 1}/${total}`
    const content = chunkTexts[idx]
    const locator = `seg-${String(idx + 1).padStart(3, '0')}`

    const extracted = await extractFromChunk(content, label)

    if (extracted.length > 0) {
      const embeddings = await generateEmbeddingsBatch(extracted.map(insightEmbeddingText))
      const timing = chunkTimings[idx]
      const rows = extracted.map((ins, i) => {
        // Locate the verbatim quote within the chunk to store char offsets
        // (only when it matches exactly — the prompt requires an exact copy).
        const at = ins.direct_quote ? content.indexOf(ins.direct_quote) : -1
        return {
        source_id: sourceId,
        chunk_id: chunkIdByIndex.get(idx) ?? null,
        run_id: runId,
        locator,
        // Carry the clock through: every insight inherits its chunk's timing so
        // an Evidence citation can deep-link to the moment in the video. Null for
        // sources without timed segments (the manual-paste transcripts).
        start_ms: timing?.start_ms ?? null,
        end_ms: timing?.end_ms ?? null,
        statement: ins.statement,
        context_note: ins.context_note ?? null,
        direct_quote: at >= 0 ? ins.direct_quote : (ins.direct_quote ?? null),
        quote_char_start: at >= 0 ? at : null,
        quote_char_end: at >= 0 ? at + (ins.direct_quote as string).length : null,
        evidence_type: ins.evidence_type,
        confidence: ins.confidence,
        importance: ins.importance ?? null,
        actionability: ins.actionability ?? null,
        primary_audience: ins.primary_audience ?? null,
        insight_type: ins.insight_type ?? null,
        qualifiers: ins.qualifiers ?? null,
        embedding: embeddings[i],
        extraction_model: EXTRACTION_MODEL,
        }
      })
      const { error: insErr } = await db().from('raw_insights').insert(rows)
      if (insErr) throw new Error(`Failed to insert raw_insights for chunk ${label}: ${insErr.message}`)
      cp.insights_created += rows.length
    }

    cp = { ...cp, chunk_index: idx + 1 }
    await onProgress(cp, runId)
  }

  // Finalize the run + source status.
  await finishRun(runId, { chunks: total, insights_created: cp.insights_created })
  await db()
    .from('sources')
    .update({ processing_status: 'succeeded', last_processed_at: new Date().toISOString() })
    .eq('id', sourceId)

  return { done: true, checkpoint: cp, runId }
  } catch (err) {
    // Close out the run and the source; otherwise both sit in a permanent
    // in-flight state that the admin UI reports as still running.
    await failRun(runId, err)
    await db()
      .from('sources')
      .update({
        processing_status: 'failed',
        processing_error: (err instanceof Error ? err.message : String(err)).substring(0, 2000),
      })
      .eq('id', sourceId)
    throw err
  }
}
