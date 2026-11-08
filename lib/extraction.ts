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
import { claudeJson, CLAUDE_BULK_MODEL, CLAUDE_JUDGMENT_MODEL } from './llm'
import { PipelineHaltError, UsageLimitError, rethrowIfUsageLimit } from './usageLimit'
import { stripNonContent } from './transcriptHygiene'
import { resolveQuote } from './quoteResolve'
import { applyGate, describeViolation, type GateViolation } from './extractionGate'
import { EXTRACTION_SYSTEM_PROMPT_V2, EXTRACTION_REPAIR_PROMPT_V2 } from './extractionPromptV2'
import { selectAllPaged } from './pagination'
import { createLimiter, envLimit } from './concurrency'
import { withNetworkRetry } from './networkRetry'
import { bareName, bareNames, isCredentialOnly } from './personName'
import { canonicalHostLabel, showForSource, isHostName, DEFAULT_SHOW, type Show } from './shows'
import {
  normalizeYouTubeSegments,
  buildTranscriptFromSegments,
  computeChunkTimings,
  type TimedSegment,
  type ChunkTiming,
} from './transcriptSegments'
import type { EvidenceType, Confidence, Actionability, Audience, InsightType, InsightQualifiers } from './types'

/**
 * Process-wide ceiling on simultaneous `raw_insights` writes (EXTRACT_DB_WRITE_CONCURRENCY, default 3).
 * Each write carries 1536-float embeddings; the database's API pool is about 7 connections and the
 * client times out after 30 s, so 16 chunks per job times N workers landing together is how a
 * request queues behind a full pool and fails (2026-10-20). Shared by every job in the process.
 */
export const insertLimiter = createLimiter(envLimit('EXTRACT_DB_WRITE_CONCURRENCY', 3))

// Default extraction model (Paul, 2026-11-08, after the 8-episode comparison): Opus 5.5 with the
// v2 prompt flagged 8.9% of insights against 33.5% for stored Haiku/v1 extraction, with no loss of
// content. The v1 prompt keeps its original bulk-tier model so `EXTRACTION_PROMPT_VERSION=v1` alone
// restores the old behaviour. `EXTRACTION_MODEL` in the environment overrides either (see extractionConfig).
const DEFAULT_EXTRACTION_MODEL = 'claude-opus-5-5'
const V1_EXTRACTION_MODEL = CLAUDE_BULK_MODEL
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
  speaker?: string | null        // who said it, model-inferred (transcripts are unlabeled); null = unsure
  evidence_type: EvidenceType
  qualifiers?: InsightQualifiers | null
  confidence: Confidence
  importance?: 1 | 2 | 3
  actionability?: Actionability
  primary_audience?: Audience
  insight_type?: InsightType
  /** v2 prompt only: the statement depends on something shown on screen (video check). */
  visual_dependent?: boolean
}

// ── Prompt (ported verbatim from the v1 optimized prompt) ───
const EXTRACTION_SYSTEM_PROMPT = `
Extract show-note–worthy insights from transcript chunks for a large, multi-source lifestyle and health knowledge base.

Your job is NOT to capture everything that was said. Your job is to extract only the ideas that would appear in polished show notes or an educational article. Prefer FEWER, HIGHER-VALUE, GENERALIZABLE insights over many small, conversational, or anecdotal ones.

FAITHFULNESS (ABSOLUTE — this overrides every other instruction below)
Every insight must be FULLY SUPPORTED by THIS chunk. You may rephrase, compress, and generalize the wording, but you may NOT add any information the chunk does not contain. This is a medical knowledge base; an insight that reaches beyond the source is worse than no insight at all.
• Do NOT add a number, dose, threshold, percentage, timeframe, or population the chunk did not state.
• Do NOT name a mechanism, pathway, condition, hormone axis, or entity the chunk only gestures at. ("Sperm production is brain-driven" does NOT license naming a specific hypothalamic-pituitary axis; "it overlaps with other conditions" does NOT license asserting a shared pathway.)
• Do NOT add a recommendation or clinical-management directive of ANY kind unless the chunk states it in those terms. This includes soft or hedged framings — "requiring individualized assessment", "rather than routine intervention", "warrants monitoring", "should be considered" — every one of these is a management claim. If the chunk only describes a FACT ("fibroids are mostly asymptomatic"), state only the fact; do NOT append what to do about it.
• Do NOT narrow the SCOPE the chunk gave. If the chunk speaks generally ("rough play helps children self-regulate"), do NOT restrict it to a subgroup it did not name ("rough play BETWEEN SIBLINGS…"). Adding a population, setting, or condition the chunk did not attach is inventing a boundary — keep the claim exactly as broad or narrow as the source made it.
• Do NOT upgrade the strength or certainty of a claim: "what we do in practice" is NOT "evidence-based"; "may/might/can" is NOT "does"; one example is NOT "typically"; a speaker's opinion is NOT a finding.
When unsure whether the chunk supports a detail, LEAVE IT OUT. A plainer, fully-grounded insight always beats a richer one that adds something unsaid. If the source only implies or gestures at something, do not state it — missing-but-true detail is added later from primary references; your job is never to supply substance the source did not.
Before returning each insight, RE-READ it against the chunk and delete any clause — especially a trailing "requiring…", "suggesting…", "which means…", or a narrowed population — that the chunk does not itself support.

PURPOSE (CRITICAL)
The insights you produce will be merged with insights from thousands of other chunks and sources to form a unified knowledge base. Because they will be recombined across episodes, each insight must:
• Stand alone without relying on the surrounding conversation.
• Express generalizable, durable knowledge—NOT episode-specific details.
• Capture mechanisms, principles, evolutionary logic, or explanatory frameworks THAT THE SOURCE ACTUALLY STATES — never one you infer to fill a gap.
• Translate personal anecdotes into the *underlying principle the speaker drew from them* rather than retelling the story — without adding a principle the speaker did not draw.
• Include specific, practical examples (foods, practices, protocols) that help readers apply the insight, when the chunk provides them.
• Avoid any dependency on host interactions, podcast structure, or context.

STITCHABILITY (CRITICAL)
Write each insight so it can combine cleanly with insights from other chunks, episodes, and sources:
• No references to "earlier we discussed…", "as you said…", or speaker names.
• No reliance on personal anecdotes unless the insight explicitly states the principle illustrated.
• Clear, standalone phrasing that conveys a durable meaning.
• Emphasis on mechanisms, frameworks, and conceptual distinctions, supported by concrete examples when helpful.

WHAT COUNTS AS A HIGH-VALUE INSIGHT
Produce an insight ONLY if it is: conceptually important; generalizable beyond the transcript; mechanistic or explanatory; self-contained and clear; and non-obvious (avoid generic statements like "testosterone affects behavior"—capture the specific point the speaker actually made, staying within what the chunk says).

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

SPEAKER ATTRIBUTION
Also return "speaker": the full name of the person who stated the insight. The transcript has no speaker labels, so infer it from conversational context: who is asking vs answering, names used in the dialogue, and the participant list when one is provided above the text. Attribution matters — an expert guest's claim carries different weight than the host's commentary — so NEVER guess between plausible speakers: return null unless the context makes the speaker clear. Use the person's name as given in the participant list (e.g. "Micky Collins"), not a role word like "guest". This field is the ONLY place a speaker may appear — the statement itself must still contain no speaker names.

OUTPUT FORMAT (STRICT JSON)
{"insights":[{"statement":"...","context_note":"...","direct_quote":"exact words from the chunk or null","speaker":"full name or null","evidence_type":"...","qualifiers":{"population":"...","dose":"...","duration":"...","outcome":"...","effect_size":"..."},"confidence":"...","importance":1|2|3,"actionability":"...","primary_audience":"...","insight_type":"..."}]}
If no high-value insights are present, return {"insights":[]}.
`.trim()


// ── Prompt / gate switch ────────────────────────────────────
export type PromptVersion = 'v1' | 'v2'
export type ExtractionConfig = {
  model: string
  promptVersion: PromptVersion
  /** Deterministic post-extraction gate (lib/extractionGate.ts). */
  gate: boolean
  /** One repair round for insights the gate rejected (only with the gate on). */
  repair: boolean
}

/**
 * How extraction runs, from the environment, with explicit overrides for harnesses.
 *
 *   EXTRACTION_PROMPT_VERSION  v2 (default) | v1 — v1 is the original prompt, unchanged
 *   EXTRACTION_GATE            on | off — default on with v2, off with v1
 *   EXTRACTION_REPAIR          on (default) | off — one repair call for gate-rejected insights
 *   EXTRACTION_MODEL           model id; default claude-opus-5-5 (v1: claude-haiku-4-5, its original model)
 *
 * Old behaviour, exactly: EXTRACTION_PROMPT_VERSION=v1 (gate off by default, Haiku 4.5).
 */
export function extractionConfig(overrides: Partial<ExtractionConfig> = {}): ExtractionConfig {
  const promptVersion: PromptVersion =
    overrides.promptVersion ?? (process.env.EXTRACTION_PROMPT_VERSION === 'v1' ? 'v1' : 'v2')
  const gateEnv = process.env.EXTRACTION_GATE?.toLowerCase()
  const gate = overrides.gate ?? (gateEnv === 'on' ? true : gateEnv === 'off' ? false : promptVersion === 'v2')
  const repair = overrides.repair ?? process.env.EXTRACTION_REPAIR?.toLowerCase() !== 'off'
  const model = overrides.model ??
    (process.env.EXTRACTION_MODEL?.trim() || (promptVersion === 'v1' ? V1_EXTRACTION_MODEL : DEFAULT_EXTRACTION_MODEL))
  return { model, promptVersion, gate, repair: gate && repair }
}

const LOW_VALUE_PATTERNS: RegExp[] = [
  /this (podcast|episode|discussion|conversation) (will|is going to|features?)/i,
  /(two-part|multi-part|part \d+)/i,
  /^(.* )?(is|are) (a|an) (leading|prominent|notable|expert|researcher|scientist|doctor|professor)/i,
  /conflict(s)? of interest/i,
  /no conflict/i,
  /^(this|the) (podcast|episode|discussion|conversation|topic)/i,
]

/** Keep only a real person-name attribution; role words and "unknown" become null. */
export function sanitizeSpeaker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 80) return null
  if (/^(host|guest|speaker|interviewer|interviewee|narrator|unknown|unclear|n\/?a|none|null)s?$/i.test(s)) return null
  // A speaker is the bare name: `Sally Greenwald, M.D.` and `Sally Greenwald` are one
  // person (sources.authors carries the credentials; attributions never do).
  const bare = bareName(s)
  if (!bare || isCredentialOnly(bare)) return null
  // One canonical spelling for a HOST — "Dr. Peter Attia" / "peter attia"
  // variants would otherwise fragment the attribution rollups. Every registered
  // show's host collapses (lib/shows.ts), not just the episode's own: Attia
  // guesting on Huberman Lab must roll up with Attia on The Drive.
  return canonicalHostLabel(bare)
}

/**
 * One cheap LLM read of the transcript's opening to name the guest(s).
 * Podcast episodes introduce guests in the first minutes; titles often don't
 * (213 of 249 sources have no guest in metadata). Empty array = could not tell,
 * which downstream renders as a hedged participant line — never "solo".
 */
export async function inferGuestsFromIntro(transcript: string, show: Show = DEFAULT_SHOW): Promise<string[]> {
  try {
    const intro = transcript.slice(0, 4000)
    const parsed = await claudeJson<{ guests?: unknown }>(
      `You read the opening of a health-podcast transcript and identify the guest(s) being interviewed. The host is ${show.hostLabel}. Return JSON only: {"guests": ["Full Name", ...]} — full names of guests actually introduced or addressed in this opening. Empty array if no guest is identifiable. Never include the host. Never guess.`,
      `Transcript opening:\n${intro}`,
      400,
      CLAUDE_JUDGMENT_MODEL
    )
    if (!Array.isArray(parsed.guests)) return []
    return bareNames(
      parsed.guests
        .filter((g): g is string => typeof g === 'string')
        .map(g => g.trim())
        .filter(g => g.length > 1 && g.length <= 80),
      name => isHostName(show, name)
    ).slice(0, 6)
  } catch (err) {
    // A full usage window is not "could not tell" — defer, don't hedge forever.
    rethrowIfUsageLimit(err)
    // Attribution is an enhancement — a failed inference must never block
    // extraction. The hedged participant line covers this case.
    return []
  }
}

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
// resolveQuote lives in ./quoteResolve (shared with the extraction gate); re-exported for callers and tests.
export { resolveQuote }

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

/** One model call with the retry policy extraction has always had (see the comment inside). */
async function callExtractionModel(
  system: string,
  user: string,
  model: string,
  label: string
): Promise<{ insights?: ExtractedInsight[] }> {
  // Retry transient failures: the claude-code CLI intermittently prefixes prose
  // ("Extracted the following…") so `claudeJson` throws a parse error. Swallowing
  // that as 0 insights silently drops a whole chunk's content, so retry a few
  // times with backoff before giving up (same exclude-only-after-retries pattern
  // as the eval harnesses).
  let lastErr: unknown
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(1500 * 2 ** (attempt - 1), 12_000)))
    try {
      return await claudeJson<{ insights?: ExtractedInsight[] }>(system, user, 8000, model)
    } catch (err) {
      // Retrying cannot beat a full usage window; let the worker defer the job.
      rethrowIfUsageLimit(err)
      lastErr = err
    }
  }
  // A failed call is NOT an empty chunk. Returning [] here let the caller
  // advance its checkpoint and mark the source succeeded having extracted
  // nothing — on 2026-07-24 that silently burned 26 of 54 chunks of a source,
  // and the only visible symptom was insights_created stuck at 0. Throw, so
  // the job fails loudly and the queue retries it with its checkpoint intact.
  // (Same rule as adjudicate(): a transport failure is a missing measurement,
  // never a verdict.)
  throw new Error(
    `[extract ${label}] extraction failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  )
}

/** Coerce the model's raw insight list into stored shape; drops malformed and low-value entries. */
function normalizeInsights(raw: unknown): ExtractedInsight[] {
  if (!Array.isArray(raw)) return []
  return (raw as ExtractedInsight[])
    .filter(i => i && typeof i.statement === 'string' && !isLowValue(i.statement))
    .map(i => ({
      statement: i.statement,
      context_note: i.context_note ?? null,
      direct_quote: typeof i.direct_quote === 'string' && i.direct_quote.trim() ? i.direct_quote.trim() : null,
      // Role words ("host", "guest", "speaker", "unknown") are refusals to name a
      // person, not attributions — normalize them to null rather than storing them.
      speaker: sanitizeSpeaker(i.speaker),
      evidence_type: coerceEvidenceType(i.evidence_type),
      confidence: coerceConfidence(i.confidence),
      importance: coerceImportance(i.importance),
      actionability: coerceActionability(i.actionability),
      primary_audience: coerceAudience(i.primary_audience),
      insight_type: coerceInsightType(i.insight_type),
      qualifiers: i.qualifiers ?? null,
      visual_dependent: i.visual_dependent === true,
    }))
}

/** A statement that depends on something shown on screen carries a video-check note (no schema change: it rides in context_note). */
export const VIDEO_CHECK_NOTE = 'Video check: this statement depends on something shown on screen.'
function withVideoCheckNote(i: ExtractedInsight): ExtractedInsight {
  if (!i.visual_dependent) return i
  const note = i.context_note ? `${VIDEO_CHECK_NOTE} ${i.context_note}` : VIDEO_CHECK_NOTE
  return { ...i, context_note: note }
}

export type ChunkExtraction = {
  /** What the pipeline stores: gate-passing insights (all of them when the gate is off). */
  kept: ExtractedInsight[]
  /** Every insight the model returned on its first call, before the gate. */
  firstPass: ExtractedInsight[]
  /** Insights the gate rejected on the first pass, with why. */
  rejected: { insight: ExtractedInsight; violations: GateViolation[] }[]
  /** Corrected insights returned by the repair round (before they were re-gated). */
  repairedCandidates: ExtractedInsight[]
  /** Repair candidates the gate rejected again (dropped). */
  stillRejected: { insight: ExtractedInsight; violations: GateViolation[] }[]
  /** Model calls made for this chunk: 1, or 2 when a repair round ran. */
  calls: number
}

/**
 * Extract one chunk with full detail about what the gate did. The pipeline uses
 * `extractFromChunk` (just the kept insights); the comparison harness
 * (scripts/evalExtractionPrompt.ts) uses this to measure the gate.
 */
export async function extractFromChunkDetailed(
  content: string,
  label: string,
  // "Host: <the show's host>. Guest(s): Micky Collins." — gives the speaker-attribution
  // rule names to attribute to. Optional: eval harnesses call without it, and the
  // model then attributes only when the dialogue itself names the speaker.
  participants?: string,
  overrides: Partial<ExtractionConfig> = {}
): Promise<ChunkExtraction> {
  const cfg = extractionConfig(overrides)
  const system = cfg.promptVersion === 'v2' ? EXTRACTION_SYSTEM_PROMPT_V2 : EXTRACTION_SYSTEM_PROMPT
  const user = `${participants ? `Participants in this recording — ${participants}\n\n` : ''}Text to analyze:\n${content}`
  const parsed = await callExtractionModel(system, user, cfg.model, label)
  // A well-formed response with no insights is a legitimate outcome — some
  // chunks really are pure banter. That is the ONE case that returns empty.
  const firstPass = normalizeInsights(parsed.insights)
  const empty = { rejected: [], repairedCandidates: [], stillRejected: [], calls: 1 }

  if (!cfg.gate) return { kept: firstPass.map(withVideoCheckNote), firstPass, ...empty }

  const first = applyGate(content, firstPass)
  let kept = first.kept
  let repairedCandidates: ExtractedInsight[] = []
  let stillRejected: ChunkExtraction['stillRejected'] = []
  let calls = 1

  if (cfg.repair && first.rejected.length > 0) {
    calls = 2
    const problems = first.rejected.map((r, n) => ({
      n: n + 1,
      insight: r.insight,
      problems: r.violations.map(describeViolation),
    }))
    try {
      const fixed = await callExtractionModel(
        EXTRACTION_REPAIR_PROMPT_V2,
        `${participants ? `Participants in this recording — ${participants}\n\n` : ''}Text:\n${content}\n\nInsights to correct (JSON):\n${JSON.stringify(problems)}`,
        cfg.model,
        `${label} repair`
      )
      // The model sometimes echoes the {n, insight, problems} wrapper it was given; unwrap it.
      repairedCandidates = normalizeInsights(
        (Array.isArray(fixed.insights) ? fixed.insights : []).map(x => {
          const inner = (x as { insight?: ExtractedInsight } | null)?.insight
          return inner && typeof inner === 'object' ? inner : x
        })
      )
      const second = applyGate(content, repairedCandidates)
      kept = [...kept, ...second.kept]
      stillRejected = second.rejected
    } catch (err) {
      // A failed repair loses only the rejected insights, never the chunk.
      rethrowIfUsageLimit(err)
    }
  }

  return {
    kept: kept.map(withVideoCheckNote),
    firstPass,
    rejected: first.rejected,
    repairedCandidates,
    stillRejected,
    calls,
  }
}

export async function extractFromChunk(
  content: string,
  label: string,
  participants?: string,
  overrides: Partial<ExtractionConfig> = {}
): Promise<ExtractedInsight[]> {
  return (await extractFromChunkDetailed(content, label, participants, overrides)).kept
}

export type ExtractCheckpoint = {
  chunk_index: number      // next chunk to process
  total_chunks: number
  insights_created: number
  // Chunks of the CURRENT batch (chunk_index .. chunk_index+concurrency) whose
  // insights are already written. A batch that fails part-way persists this so
  // the retry redoes only the chunks that failed, not the whole batch. Cleared
  // when the batch completes and chunk_index advances.
  done_chunks?: number[]
  // Participant line for speaker attribution, computed once per source (an LLM
  // read of the transcript intro when metadata lists no guest) and carried in
  // the checkpoint so resumed ticks don't re-pay the inference call.
  participants?: string
}

/**
 * Fresh run only: refuse a source that still has claim members, then clear its
 * prior chunks and insights. Every write here is keyed to this one source, apart
 * from the optional library-wide reconcile (see below). Exported for tests.
 */
export async function clearForFreshRun(sourceId: string): Promise<{ hadMembers: boolean }> {
  // Guard (2026-10-11): deleting this source's raw_insights below cascades
  // its claim_members away — a silent, lossy retirement that leaves mixed
  // claims carrying text from members that no longer exist. Replacing a
  // transcript goes through scripts/retireSourceClaims.ts first, which also
  // repairs those claims. A source whose insights are still members of claims
  // therefore refuses a fresh run unless the caller says it knows better.
  const { data: idRows } = await db().from('raw_insights').select('id').eq('source_id', sourceId).limit(200)
  const ids = ((idRows ?? []) as { id: string }[]).map(r => r.id)
  let hadMembers = false
  if (ids.length > 0) {
    const { count } = await db().from('claim_members').select('raw_insight_id', { count: 'exact', head: true }).in('raw_insight_id', ids)
    hadMembers = (count ?? 0) > 0
    if (hadMembers && process.env.ALLOW_MEMBERED_REEXTRACT !== '1') {
      throw new Error(
        `Source ${sourceId} still has claim members from a previous extraction; ` +
          `run scripts/retireSourceClaims.ts --source ${sourceId} --apply first (or set ALLOW_MEMBERED_REEXTRACT=1)`
      )
    }
  }
  // Fresh run: clear any prior chunks + insights, and reset the source's
  // derived state.
  //
  // The insight delete matters when a PARTIAL extraction is restarted from
  // scratch (its checkpoint reset, e.g. after the job was drained mid-source).
  // `scripts/pipeline.ts extract` clears insights before enqueuing, but a job
  // re-run from an empty checkpoint never went through that path — it would
  // append a second copy of every chunk's insights to the ones already there.
  // Guarded by the fresh-run branch, so a RESUME (which has a checkpoint)
  // never deletes the work it is resuming.
  await db().from('chunks').delete().eq('source_id', sourceId)
  const { error: riErr } = await db().from('raw_insights').delete().eq('source_id', sourceId)
  if (riErr) throw new Error(`Failed to clear prior insights for ${sourceId}: ${riErr.message}`)
  // If that delete cascaded claim_members away, the claims seeded from this
  // source are stale or memberless (migration 012). reconcile_claim_membership()
  // repairs them, but it rewrites and retires claims ACROSS the whole library, so
  // it is skipped when nothing could have cascaded — always the case for a new
  // source and for a partial extraction (consolidation only starts after
  // extraction completes). That keeps this stage to rows keyed to its own source,
  // so an extract-only run can overlap a consolidate-only run (docs/EXTRACTION_RUNBOOK.md §9).
  // Only the ALLOW_MEMBERED_REEXTRACT override reaches it, and that is a maintenance
  // operation: scripts/extractDeepgram.ts refuses to start a lane run with it set.
  if (hadMembers) {
    const { error: rcErr } = await db().rpc('reconcile_claim_membership')
    if (rcErr) throw new Error(`Failed to reconcile claims for ${sourceId}: ${rcErr.message}`)
  }
  return { hadMembers }
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
  type SourceRow = {
    id: string
    transcript: string | null
    timed_transcript?: unknown
    authors?: string[] | null
    series?: string | null
    external_id?: string | null
  }
  let source: SourceRow
  {
    const withTiming = await db()
      .from('sources')
      .select('id, transcript, timed_transcript, authors, series, external_id')
      .eq('id', sourceId)
      .single()
    if (withTiming.error && /timed_transcript/.test(withTiming.error.message || '')) {
      const fallback = await db()
        .from('sources')
        .select('id, transcript, authors, series, external_id')
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

    await clearForFreshRun(sourceId)
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
    // Paged: a long transcript can exceed the 1000-row server cap on its own,
    // and a truncated read on RESUME would silently shorten the source — the
    // job would then report `total_chunks` lower than reality and finish early.
    const chunkRows = await selectAllPaged<{ id: string; locator: string; content: string; start_ms: number | null; end_ms: number | null }>(
      (from, to) => db()
        .from('chunks')
        .select('id, locator, content, start_ms, end_ms')
        .eq('source_id', sourceId)
        .order('locator', { ascending: true })
        .range(from, to)
    )
    const byIdx = new Map<number, { id: string; content: string; start_ms: number | null; end_ms: number | null }>()
    for (const c of chunkRows) {
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

  // Names for the speaker-attribution rule. Nothing here asserts who said what —
  // it only tells the model which names exist so attributions use real names or
  // null, never role words.
  //
  // sources.authors (parsed from titles) lists a real guest for only ~36 of 249
  // sources, and naive filtering let "Dr. Peter Attia" through as a "guest" —
  // the first live run attributed guest statements to the host because the
  // prompt claimed interviews were solo. So: metadata guests when they exist,
  // otherwise ONE inference call over the transcript intro (episodes open by
  // introducing the guest), cached in the checkpoint across resume ticks. When
  // even that fails, the line hedges — it never claims a solo episode.
  // The host is the show's, not always Peter Attia: `series`, then the join key's
  // prefix, then authors[0], then The Drive (lib/shows.ts showForSource), so the
  // 409 Drive rows and the pre-feed rows with no external_id still resolve to him.
  const show = showForSource(source)
  // `authors` carries each guest as the show writes them (`Sally Greenwald, M.D., M.P.H.`);
  // the prompt, like the transcript's `Name:` labels, uses the bare name.
  const metaGuests = bareNames(source.authors ?? [], name => isHostName(show, name))
  let participants = checkpoint?.participants
  if (!participants) {
    let guests = metaGuests
    if (guests.length === 0 && source.transcript) {
      guests = await inferGuestsFromIntro(source.transcript, show)
    }
    participants =
      `Host: ${show.hostLabel} (the interviewer).` +
      (guests.length > 0
        ? ` Guest(s): ${guests.join(', ')}.`
        : ` Guest names are unavailable — attribute a statement ONLY when the dialogue itself makes the speaker unambiguous; otherwise return null. Do not assume the host is speaking.`)
  }

  let cp: ExtractCheckpoint = {
    chunk_index: checkpoint?.chunk_index ?? 0,
    total_chunks: total,
    insights_created: checkpoint?.insights_created ?? 0,
    participants,
    done_chunks: checkpoint?.done_chunks ?? [],
  }
  const INSERT_SLICE = 25
  const extractionCfg = extractionConfig()
  const extractionModel = extractionCfg.model

  // Chunks are independent, so they run CONCURRENTLY in batches instead of one
  // at a time. Measured 2026-08-24 on live chunks: serial ~58.5 s/chunk; 8-way
  // 3.2x; 16-way 6.9x (8.5 s/chunk effective), zero failures on the subscription
  // CLI. At ~55 chunks/source that is ~77 min -> ~11 min of extraction.
  //
  // The checkpoint still advances only after a WHOLE batch is written, so
  // resumability is unchanged in kind: a killed worker redoes at most one batch
  // rather than at most one chunk. Never advance it per-chunk here — the chunks
  // of a batch complete out of order, so a per-chunk advance could skip a chunk
  // that had not been inserted yet.
  //
  // Raise/lower with EXTRACT_CONCURRENCY. Each unit is a `claude -p` process, so
  // this is bounded by local CPU/RAM and the account's rate limits, not by us.
  const concurrency = Math.max(1, Number(process.env.EXTRACT_CONCURRENCY) || 16)

  while (cp.chunk_index < total) {
    if (Date.now() - started > timeBudgetMs) {
      // Yield: not done, worker will resume this run on the next tick.
      return { done: false, checkpoint: cp, runId }
    }

    const batchStart = cp.chunk_index
    const batchEnd = Math.min(batchStart + concurrency, total)
    const indices: number[] = []
    for (let i = batchStart; i < batchEnd; i++) indices.push(i)

    // Chunks of this batch already written by a previous attempt. Until
    // 2026-10-11 a batch was all-or-nothing: one chunk whose CLI call failed
    // after its retries threw away the other fifteen chunks' finished work and
    // the retry redid all sixteen. Under an intermittent CLI (a usage-limit
    // window) that collapses progress super-linearly — the 2026-08-28 run
    // managed 32 chunks in 16 hours. Now every chunk that lands is written and
    // recorded at once; a failed batch persists `done_chunks` and the retry
    // redoes only what is missing. `chunk_index` still advances only when the
    // whole batch is in, so the out-of-order-completion hazard is unchanged.
    const done = new Set(cp.done_chunks ?? [])
    const todo = indices.filter(i => !done.has(i))

    const insertChunk = (idx: number, rows: Record<string, unknown>[]) =>
      insertLimiter.run(() => insertChunkRows(idx, rows))
    const insertChunkRows = async (idx: number, rows: Record<string, unknown>[]) => {
      const locator = `seg-${String(idx + 1).padStart(3, '0')}`
      // Delete-then-insert is idempotent: a retried chunk whose earlier insert half-landed would
      // otherwise duplicate its rows (there is no unique key on run_id+locator).
      // This run's rows for the chunk have no members yet — consolidation only
      // starts after extraction completes — so clearing them is safe. That also makes the whole
      // sequence safe to repeat after a brief network drop (lib/networkRetry.ts), so a drop costs a
      // pause, not the chunk.
      const attempt = async (): Promise<{ error: { message: string } | null }> => {
        const { error: delErr } = await db().from('raw_insights').delete().eq('run_id', runId).eq('locator', locator)
        if (delErr) return { error: { message: `Failed to clear chunk ${idx + 1}/${total} before insert: ${delErr.message}` } }
        // Sliced: each row carries a 1536-float embedding, and a multi-megabyte
        // request dies with `TypeError: fetch failed` (a 74-min episode, 2026-08-24).
        for (let i = 0; i < rows.length; i += INSERT_SLICE) {
          const { error: insErr } = await db().from('raw_insights').insert(rows.slice(i, i + INSERT_SLICE))
          if (insErr) {
            return {
              error: {
                message: `Failed to insert raw_insights for chunk ${idx + 1}/${total} (slice ${i / INSERT_SLICE + 1}): ${insErr.message}`,
              },
            }
          }
        }
        return { error: null }
      }
      const { error } = await withNetworkRetry(`insert chunk ${idx + 1}/${total}`, attempt)
      if (error) throw new Error(error.message)
    }

    // allSettled, not all: with `all`, the first rejection returned while the
    // other chunks' CLI processes were still running, and their late results
    // were lost (or, worse, written after the job had already been failed).
    const settled = await Promise.allSettled(
      todo.map(async idx => {
        const label = `${idx + 1}/${total}`
        const content = chunkTexts[idx]
        const locator = `seg-${String(idx + 1).padStart(3, '0')}`

        const extracted = await extractFromChunk(content, label, participants, extractionCfg)
        if (extracted.length === 0) {
          // A genuinely empty chunk (an ad break, a sign-off) is a real result;
          // nothing to write, but the chunk is done.
          return { idx, inserted: 0 }
        }

        const embeddings = await generateEmbeddingsBatch(extracted.map(insightEmbeddingText))
        const timing = chunkTimings[idx]
        const rows = extracted.map((ins, i) => {
          const quote = resolveQuote(content, ins.direct_quote)
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
            direct_quote: quote.text,
            quote_char_start: quote.start,
            quote_char_end: quote.end,
            speaker: ins.speaker ?? null,
            evidence_type: ins.evidence_type,
            confidence: ins.confidence,
            importance: ins.importance ?? null,
            actionability: ins.actionability ?? null,
            primary_audience: ins.primary_audience ?? null,
            insight_type: ins.insight_type ?? null,
            qualifiers: ins.qualifiers ?? null,
            embedding: embeddings[i],
            extraction_model: extractionModel,
          }
        })
        await insertChunk(idx, rows)
        return { idx, inserted: rows.length }
      })
    )

    // Record every chunk that landed BEFORE deciding about failures, so a retry
    // after a partial batch redoes only the missing chunks. A thrown chunk is
    // still a MISSING MEASUREMENT, never an empty one: the batch as a whole
    // fails, the checkpoint keeps chunk_index where it was, and the queue
    // retries with its backoff — now with done_chunks carrying the progress.
    let failure: unknown = null
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        done.add(s.value.idx)
        cp.insights_created += s.value.inserted
      } else if (
        failure === null ||
        (s.reason instanceof PipelineHaltError && !(failure instanceof PipelineHaltError)) ||
        (s.reason instanceof UsageLimitError && !(failure instanceof UsageLimitError || failure instanceof PipelineHaltError))
      ) {
        // A halt, then a usage-limit rejection, outranks any other failure in the batch: it
        // decides what the worker does with the job (requeue, spend no attempt).
        failure = s.reason
      }
    }
    cp = { ...cp, done_chunks: [...done].sort((a, b) => a - b) }
    if (failure !== null) {
      // Persist the partial batch, then fail the job as before.
      await onProgress(cp, runId)
      throw failure instanceof Error ? failure : new Error(String(failure))
    }

    cp = { ...cp, chunk_index: batchEnd, done_chunks: [] }
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
    // A paused job is not a failed source: it resumes from its checkpoint when
    // the usage window reopens, so do not mark it failed in the admin UI.
    if (!(err instanceof UsageLimitError || err instanceof PipelineHaltError)) {
      await db()
        .from('sources')
        .update({
          processing_status: 'failed',
          processing_error: (err instanceof Error ? err.message : String(err)).substring(0, 2000),
        })
        .eq('id', sourceId)
    }
    throw err
  }
}
