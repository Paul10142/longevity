/**
 * The question path, end to end (design §5):
 *
 *   embed ─▶ cache? ─▶ expand ─▶ embed phrasings ─▶ retrieve ─▶ evidence floor
 *     ─▶ compose (streams) ─▶ parse ─▶ store ─▶ audit (after the response)
 *
 * `ask` reports progress as `AskEvent`s through `emit`; the route turns them into
 * NDJSON. It never throws: every failure becomes an `error` event (and a stored
 * `failed` row where there is anything to store).
 */

import { generateEmbedding, generateEmbeddingsBatch } from '../embeddings'
import { ModelRefusalError, trackLlmUsage } from '../llm'
import { expandQuestion } from './expand'
import { retrieve, type Retrieval } from './retrieve'
import { loadContradictions, loadRelatedTopics } from './provenance'
import { candidateMap, composeBrief } from './compose'
import { BriefStream, parseBrief } from './parse'
import { auditAnswer } from './audit'
import { costUsd } from './cost'
import {
  corpusClaimCount,
  findCached,
  normalizeQuestion,
  saveAnswer,
  type AnswerRow,
  type CacheHit,
} from './store'
import { ASK_COMPOSE_MODEL, ASK_EXPAND_MODEL, type AskEvent, type RelatedTopic, type StoredCandidate } from './types'

export const MAX_QUESTION_CHARS = 600
export const MIN_QUESTION_CHARS = 6

export type AskOptions = {
  emit: (event: AskEvent) => void
  /** Run `fn` after the response has been sent (Next's `after`). */
  schedule: (fn: () => Promise<void>) => void
  askedBy?: string
  /** Skip the cache ("refresh"). */
  refresh?: boolean
}

export type QuestionCheck = { ok: true; question: string } | { ok: false; message: string }

export function checkQuestion(raw: unknown): QuestionCheck {
  if (typeof raw !== 'string') return { ok: false, message: 'Ask a question in words.' }
  const question = raw.replace(/\s+/g, ' ').trim()
  if (question.length < MIN_QUESTION_CHARS) return { ok: false, message: 'That question is too short to search on.' }
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, message: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }
  return { ok: true, question }
}

/** What a stored answer looks like as a stream (design §6.7: "one delta with the whole body"). */
function replayCached(hit: CacheHit, startedAt: number, emit: AskOptions['emit']): void {
  const a = hit.answer
  const thin = a.thin
  if (a.status === 'not_covered') {
    emit({ type: 'retrieval', count: a.candidates.length, thin: false, cached: hit.info })
    emit({ type: 'not_covered', answer_id: a.id, nearest_topics: a.related_topics ?? [], cached: hit.info })
    return
  }
  emit({ type: 'retrieval', count: a.candidates.length, thin, cached: hit.info })
  emit({ type: 'delta', text: a.body_markdown ?? '' })
  emit({
    type: 'done',
    answer_id: a.id,
    cited: a.cited_claim_ids.map((claim_id, i) => ({ n: i + 1, claim_id })),
    follow_ups: a.follow_ups ?? [],
    latency_ms: Date.now() - startedAt,
    body: a.body_markdown ?? '',
    thin,
    related_topics: a.related_topics ?? [],
    cached: hit.info,
  })
}

function storedCandidates(r: Retrieval): StoredCandidate[] {
  return [
    ...r.candidates.map(c => ({ id: c.id, similarity: round(c.similarity) })),
    ...r.collapsed.map(c => ({ id: c.id, similarity: round(c.similarity), collapsed_into: c.into })),
  ]
}

const round = (n: number) => Math.round(n * 1000) / 1000

export async function ask(rawQuestion: string, opts: AskOptions): Promise<void> {
  const { emit } = opts
  const startedAt = Date.now()
  const question = rawQuestion
  const norm = normalizeQuestion(question)
  const stages: Record<string, unknown> = {}
  let questionEmbedding: number[] | null = null
  let corpusNow = 0
  let retrieval: Retrieval | null = null

  const fail = async (e: unknown): Promise<void> => {
    const detail = e instanceof Error ? e.message : String(e)
    console.error('[ask] failed:', detail)
    try {
      await saveAnswer(blankRow({ question, norm, status: 'failed', askedBy: opts.askedBy, error: detail.slice(0, 500), latency: Date.now() - startedAt, corpusNow, embedding: questionEmbedding }))
    } catch { /* nothing more to do */ }
    emit({
      type: 'error',
      message: e instanceof ModelRefusalError
        ? 'The model declined to answer that question. Try rephrasing it.'
        : 'Something went wrong answering that. Try again in a moment.',
    })
  }

  try {
    // 1. Embed the question and count the corpus together: both are needed before anything else.
    let t = Date.now()
    ;[questionEmbedding, corpusNow] = await Promise.all([generateEmbedding(question), corpusClaimCount()])
    stages.embed_ms = Date.now() - t

    // 2. Cache. A repeated question costs nothing.
    if (!opts.refresh) {
      t = Date.now()
      const hit = await findCached(norm, questionEmbedding, corpusNow)
      stages.cache_ms = Date.now() - t
      if (hit) return replayCached(hit, startedAt, emit)
    }

    // 3. Everything that bills the model runs inside one usage scope.
    const { result: outcome, usage } = await trackLlmUsage(async () => {
      t = Date.now()
      const phrasings = await expandQuestion(question)
      stages.expand_ms = Date.now() - t
      stages.phrasings = phrasings

      t = Date.now()
      const rest = phrasings.filter(p => p !== question)
      const restEmb = rest.length ? await generateEmbeddingsBatch(rest) : []
      stages.embed_phrasings_ms = Date.now() - t

      t = Date.now()
      retrieval = await retrieve([questionEmbedding!, ...restEmb])
      stages.retrieve_ms = Date.now() - t
      stages.candidates = retrieval.candidates.length
      stages.union_size = retrieval.unionSize
      stages.per_query_counts = retrieval.perQueryCounts
      stages.twins_collapsed = retrieval.collapsed.length
      stages.top_similarity = retrieval.candidates[0] ? round(retrieval.candidates[0].similarity) : null

      const thin = retrieval.tier === 'thin'
      emit({ type: 'retrieval', count: retrieval.candidates.length, thin })

      // Nearest public pages: wanted by both outcomes, so start it before the branch.
      const topicsP: Promise<RelatedTopic[]> = loadRelatedTopics(questionEmbedding!).catch(() => [])

      if (retrieval.tier === 'none') return { kind: 'not_covered' as const, topics: await topicsP }

      // 4. Compose, streaming through the marker rewriter.
      const cands = retrieval.candidates
      const byNumber = candidateMap(cands)
      t = Date.now()
      const contradictions = await loadContradictions(cands.map(c => c.id)).catch(() => [])
      stages.provenance_ms = Date.now() - t
      stages.contradiction_pairs = contradictions.length

      const stream = new BriefStream(n => byNumber.has(n), text => emit({ type: 'delta', text }))
      t = Date.now()
      const composed = await composeBrief({ question, candidates: cands, contradictions, thin }, d => stream.push(d))
      stream.finish()
      stages.compose_ms = Date.now() - t
      stages.compose_start_ms = t - startedAt
      return { kind: 'answered' as const, composed, stream, byNumber, thin, topics: await topicsP }
    })

    const r = retrieval as Retrieval | null
    if (!r) throw new Error('retrieval did not run')
    const tokensByModel = Object.fromEntries(
      [...usage].map(([model, u]) => [model, { calls: u.calls, input_tokens: u.inputTokens, output_tokens: u.outputTokens, cost_usd: round6(costUsd(model, u.inputTokens, u.outputTokens)) }])
    )

    // Evidence floor: say "not covered", never a best-effort answer.
    if (outcome.kind === 'not_covered') {
      const row = blankRow({ question, norm, status: 'not_covered', askedBy: opts.askedBy, latency: Date.now() - startedAt, corpusNow, embedding: questionEmbedding })
      row.candidates = storedCandidates(r)
      row.related_topics = outcome.topics
      row.stage_stats = { ...stages, tokens: tokensByModel, total_ms: row.latency_ms }
      const id = await saveAnswer(row)
      emit({ type: 'not_covered', answer_id: id, nearest_topics: outcome.topics })
      return
    }

    // 5. Parse the finished text into the sentence model and store it.
    const { composed, stream, byNumber, thin } = outcome
    const text = stream.received
    if (!text.trim()) throw new Error(`the composer returned no text (stop reason ${composed.stopReason ?? 'unknown'})`)
    const parsed = parseBrief(text, byNumber)
    const totalMs = Date.now() - startedAt

    const row = blankRow({ question, norm, status: 'answered', askedBy: opts.askedBy, latency: totalMs, corpusNow, embedding: questionEmbedding })
    row.candidates = storedCandidates(r)
    row.cited_claim_ids = parsed.cited.map(c => c.claim_id)
    row.body_markdown = parsed.body
    row.sentences = parsed.sentences
    row.follow_ups = parsed.followUps
    row.related_topics = outcome.topics
    row.thin = thin
    row.dangling_markers = parsed.danglingMarkers
    row.model = composed.model
    row.effort = 'low'
    // Request start to the first word the physician sees.
    const firstTokenMs = composed.firstTokenMs === null ? null : (stages.compose_start_ms as number) + composed.firstTokenMs
    row.first_token_ms = firstTokenMs
    row.input_tokens = composed.inputTokens
    row.output_tokens = composed.outputTokens
    row.stage_stats = {
      ...stages,
      total_ms: totalMs,
      first_token_ms: firstTokenMs,
      compose_first_token_ms: composed.firstTokenMs,
      tokens: tokensByModel,
      cost_usd: round6(Object.values(tokensByModel).reduce((s, m) => s + m.cost_usd, 0)),
      fell_back: composed.fellBack,
      stop_reason: composed.stopReason,
      unsupported_sentences: parsed.unsupportedSentences,
      models: { expand: ASK_EXPAND_MODEL, compose: ASK_COMPOSE_MODEL },
    }
    const id = await saveAnswer(row)

    emit({
      type: 'done',
      answer_id: id,
      cited: parsed.cited,
      follow_ups: parsed.followUps,
      latency_ms: totalMs,
      body: parsed.body,
      thin,
      related_topics: outcome.topics,
    })

    // 6. Audit after the response: the physician never waits for it.
    // The cited statements are already in memory: they were the candidates.
    const statementById = new Map(r.candidates.map(c => [c.id, c.statement]))
    opts.schedule(() => auditAnswer(id, parsed.sentences, statementById))
  } catch (e) {
    await fail(e)
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

type Blank = {
  question: string
  norm: string
  status: AnswerRow['status']
  askedBy?: string
  error?: string
  latency: number
  corpusNow: number
  embedding: number[] | null
}

function blankRow(b: Blank) {
  return {
    question: b.question,
    question_norm: b.norm,
    question_embedding: b.embedding,
    status: b.status,
    candidates: [] as StoredCandidate[],
    cited_claim_ids: [] as string[],
    body_markdown: null as string | null,
    sentences: null as AnswerRow['sentences'],
    follow_ups: null as string[] | null,
    related_topics: null as RelatedTopic[] | null,
    thin: false,
    dangling_markers: 0,
    model: null as string | null,
    effort: null as string | null,
    latency_ms: b.latency as number | null,
    first_token_ms: null as number | null,
    input_tokens: null as number | null,
    output_tokens: null as number | null,
    stage_stats: null as AnswerRow['stage_stats'],
    corpus_claims: b.corpusNow || null,
    asked_by: b.askedBy ?? 'admin',
    error: b.error ?? null,
  }
}
