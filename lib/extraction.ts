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
import { stripNonContent } from './transcriptHygiene'
import { selectAllPaged } from './pagination'
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
  speaker?: string | null        // who said it, model-inferred (transcripts are unlabeled); null = unsure
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
  // One canonical spelling for the host — "Dr. Peter Attia" / "peter attia"
  // variants would otherwise fragment the attribution rollups.
  if (/^(dr\.?\s+)?peter\s+attia(,?\s+m\.?d\.?)?$/i.test(s)) return 'Peter Attia'
  return s
}

/**
 * One cheap LLM read of the transcript's opening to name the guest(s).
 * Podcast episodes introduce guests in the first minutes; titles often don't
 * (213 of 249 sources have no guest in metadata). Empty array = could not tell,
 * which downstream renders as a hedged participant line — never "solo".
 */
export async function inferGuestsFromIntro(transcript: string): Promise<string[]> {
  try {
    const intro = transcript.slice(0, 4000)
    const parsed = await claudeJson<{ guests?: unknown }>(
      `You read the opening of a health-podcast transcript and identify the guest(s) being interviewed. The host is Peter Attia. Return JSON only: {"guests": ["Full Name", ...]} — full names of guests actually introduced or addressed in this opening. Empty array if no guest is identifiable. Never include the host. Never guess.`,
      `Transcript opening:\n${intro}`,
      400,
      CLAUDE_JUDGMENT_MODEL
    )
    if (!Array.isArray(parsed.guests)) return []
    return parsed.guests
      .filter((g): g is string => typeof g === 'string')
      .map(g => g.trim())
      .filter(g => g.length > 1 && g.length <= 80 && !/peter\s+attia/i.test(g))
      .slice(0, 6)
  } catch {
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
/**
 * Resolve the model's `direct_quote` against the chunk it came from, and keep
 * ONLY what is genuinely verbatim.
 *
 * The Evidence panel presents `direct_quote` to a clinician as the source's own
 * words, so an unverified quote is the system asserting substance it cannot
 * trace — principle 1. Measured on the 2026-07-24 corpus (`eval:extraction
 * verify`), **27% of stored quotes could not be found in their chunk**, and the
 * old code stored them anyway with null offsets. They were not fabrications:
 * 89% *started* in the chunk and 41% contained ellipses — the model stitching
 * two non-contiguous spans, which the prompt explicitly forbids.
 *
 * So, in order:
 *   1. exact hit — the normal case;
 *   2. an ellipsis-joined quote whose fragments are each verbatim — a real
 *      multi-span quote, kept as the model wrote it, anchored at fragment one;
 *   3. otherwise the longest verbatim PREFIX (down to a floor, so a stray
 *      three-word match never passes as a citation);
 *   4. nothing verifiable → drop the quote. A missing quote degrades the
 *      Evidence panel; a wrong one misleads it.
 *
 * Matching normalises whitespace and smart punctuation, since a curly apostrophe
 * against a straight one is a transcription artefact, not a fidelity failure.
 */
export function resolveQuote(
  content: string,
  raw: string | null | undefined
): { text: string | null; start: number | null; end: number | null } {
  const quote = raw?.trim()
  if (!quote) return { text: null, start: null, end: null }

  const exact = content.indexOf(quote)
  if (exact >= 0) return { text: quote, start: exact, end: exact + quote.length }

  // Normalised search: fold whitespace runs and unify smart punctuation, then map
  // the hit back to an offset in the ORIGINAL content (offsets are what the UI
  // highlights, so they must index the real text).
  const fold = (s: string) =>
    s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
     .replace(/[–—]/g, '-').replace(/\s+/g, ' ')
  const foldedContent = fold(content)

  /** Offset in `content` of the nth char of `foldedContent`, walking both. */
  const mapBack = (foldedIdx: number): number => {
    let ci = 0, fi = 0
    while (fi < foldedIdx && ci < content.length) {
      const isWs = /\s/.test(content[ci])
      if (isWs) {
        while (ci < content.length && /\s/.test(content[ci])) ci++
        fi++ // the whole run folded to one space
      } else {
        ci++; fi++
      }
    }
    return ci
  }

  const findFolded = (needle: string): { start: number; end: number } | null => {
    const f = fold(needle).trim()
    if (!f) return null
    const at = foldedContent.indexOf(f)
    if (at < 0) return null
    return { start: mapBack(at), end: mapBack(at + f.length) }
  }

  const hit = findFolded(quote)
  if (hit) return { text: quote, start: hit.start, end: hit.end }

  // Ellipsis-joined multi-span quote: legitimate only if EVERY fragment is
  // verbatim. One unverifiable fragment invalidates the whole citation.
  const fragments = quote.split(/\s*(?:\.\.\.|…)\s*/).map(f => f.trim()).filter(f => f.length > 0)
  if (fragments.length > 1) {
    const hits = fragments.map(findFolded)
    if (hits.every(Boolean)) {
      const first = hits[0] as { start: number; end: number }
      const last = hits[hits.length - 1] as { start: number; end: number }
      return { text: quote, start: first.start, end: Math.max(first.end, last.end) }
    }
  }

  // Longest verbatim prefix, trimmed at a word boundary. The floor keeps a
  // fragment too short to be evidence from being presented as a citation.
  const MIN_QUOTE_CHARS = 40
  let lo = MIN_QUOTE_CHARS
  let best: { text: string; start: number; end: number } | null = null
  for (let hi = quote.length; lo <= hi; ) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const candidate = quote.slice(0, mid).replace(/\s+\S*$/, '')
    const found = candidate.length >= MIN_QUOTE_CHARS ? findFolded(candidate) : null
    if (found) {
      best = { text: candidate, start: found.start, end: found.end }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best) return { text: best.text, start: best.start, end: best.end }

  return { text: null, start: null, end: null }
}

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
export async function extractFromChunk(
  content: string,
  label: string,
  // "Host: Peter Attia. Guest(s): Micky Collins." — gives the speaker-attribution
  // rule names to attribute to. Optional: eval harnesses call without it, and the
  // model then attributes only when the dialogue itself names the speaker.
  participants?: string
): Promise<ExtractedInsight[]> {
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
        `${participants ? `Participants in this recording — ${participants}\n\n` : ''}Text to analyze:\n${content}`,
        8000,
        EXTRACTION_MODEL
      )
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!parsed) {
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
  // A well-formed response with no insights is a legitimate outcome — some
  // chunks really are pure banter. That is the ONE case that returns empty.
  if (!Array.isArray(parsed.insights)) return []

  return parsed.insights
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
    }))
}

export type ExtractCheckpoint = {
  chunk_index: number      // next chunk to process
  total_chunks: number
  insights_created: number
  // Participant line for speaker attribution, computed once per source (an LLM
  // read of the transcript intro when metadata lists no guest) and carried in
  // the checkpoint so resumed ticks don't re-pay the inference call.
  participants?: string
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
  type SourceRow = { id: string; transcript: string | null; timed_transcript?: unknown; authors?: string[] | null }
  let source: SourceRow
  {
    const withTiming = await db()
      .from('sources')
      .select('id, transcript, timed_transcript, authors')
      .eq('id', sourceId)
      .single()
    if (withTiming.error && /timed_transcript/.test(withTiming.error.message || '')) {
      const fallback = await db()
        .from('sources')
        .select('id, transcript, authors')
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
    // That delete cascaded claim_members away, so claims seeded from this source
    // are now stale or memberless (migration 012 — same reason pipeline.ts calls
    // this right after its own delete).
    const { error: rcErr } = await db().rpc('reconcile_claim_membership')
    if (rcErr) throw new Error(`Failed to reconcile claims for ${sourceId}: ${rcErr.message}`)
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
  const isAttia = (a: string) => /peter\s+attia/i.test(a)
  const metaGuests = (source.authors ?? []).filter(a => a && !isAttia(a))
  let participants = checkpoint?.participants
  if (!participants) {
    let guests = metaGuests
    if (guests.length === 0 && source.transcript) {
      guests = await inferGuestsFromIntro(source.transcript)
    }
    participants =
      `Host: Peter Attia (the interviewer).` +
      (guests.length > 0
        ? ` Guest(s): ${guests.join(', ')}.`
        : ` Guest names are unavailable — attribute a statement ONLY when the dialogue itself makes the speaker unambiguous; otherwise return null. Do not assume the host is speaking.`)
  }

  let cp: ExtractCheckpoint = {
    chunk_index: checkpoint?.chunk_index ?? 0,
    total_chunks: total,
    insights_created: checkpoint?.insights_created ?? 0,
    participants,
  }

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

    // One failure rejects the whole batch: extractFromChunk throws only after
    // its own retries, and a thrown chunk is a MISSING MEASUREMENT, never an
    // empty one. Failing here leaves the checkpoint where it was so the queue
    // retries the batch — the same contract the serial loop had.
    const perChunk = await Promise.all(
      indices.map(async idx => {
        const label = `${idx + 1}/${total}`
        const content = chunkTexts[idx]
        const locator = `seg-${String(idx + 1).padStart(3, '0')}`

        const extracted = await extractFromChunk(content, label, participants)
        if (extracted.length === 0) return []

        const embeddings = await generateEmbeddingsBatch(extracted.map(insightEmbeddingText))
        const timing = chunkTimings[idx]
        return extracted.map((ins, i) => {
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
            extraction_model: EXTRACTION_MODEL,
          }
        })
      })
    )

    // Insert in chunk order, in one call — the rows are keyed by run_id+locator,
    // and the checkpoint has not moved yet, so a retry after a failed insert
    // re-does this batch without duplicating it.
    // Insert in SLICES, not one request. Each row carries a 1536-float
    // embedding, so a 16-chunk batch is megabytes in a single call — the serial
    // version inserted one chunk at a time and never approached that. A 74-min
    // episode failed here with `TypeError: fetch failed`, which is the transport
    // giving up on the payload rather than a rejection we could read.
    // Slicing keeps each request the size the serial path used, while extraction
    // itself stays concurrent.
    const rows = perChunk.flat()
    const INSERT_SLICE = 25
    for (let i = 0; i < rows.length; i += INSERT_SLICE) {
      const slice = rows.slice(i, i + INSERT_SLICE)
      const { error: insErr } = await db().from('raw_insights').insert(slice)
      if (insErr) {
        // The checkpoint has not moved, so the whole batch is redone on retry.
        // Rows already inserted from earlier slices are re-inserted with the
        // same run_id + locator, which is exactly what a fresh-run delete
        // reconciles — the alternative, advancing past a partial batch, would
        // lose chunks silently.
        throw new Error(
          `Failed to insert raw_insights for chunks ${batchStart + 1}-${batchEnd}/${total} ` +
            `(slice ${i / INSERT_SLICE + 1}): ${insErr.message}`
        )
      }
    }
    cp.insights_created += rows.length

    cp = { ...cp, chunk_index: batchEnd }
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
