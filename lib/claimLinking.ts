/**
 * Which claims does a cited study belong to? (fix 6 of the 2026-11-08 study-linking report)
 *
 * Until now a study that a speaker cited was attached to EVERY claim extracted from the same chunk of the
 * transcript (a few minutes of talk). In the ten-episode test, the 7 correct citations covered 21 claims and
 * only 11 of them were really about the cited study: a general point about randomization was attached to one
 * specific trial just because it was said a minute later. A citation shown under a claim the study does not
 * support is a wrong citation.
 *
 * Now a model reads the speaker's words, the finding the speaker attributed to the study, the study that was
 * found, and the extracted statements from the same chunk, and picks only the statements that report what THIS
 * study found, did or concluded. Everything else stays unlinked. The candidate pool is unchanged (the chunk's
 * statements), so this can only remove links the old rule would have made, never add new ones.
 *
 * When the model cannot answer (an error, not a refusal) the result is `failed` and the caller leaves the
 * citation pending so it is tried again; it never falls back to the old attach-everything rule.
 *
 * No Supabase here: the model call is injectable, so tests/claimLinking.test.ts runs without a database.
 * lib/references.ts does the reads and writes.
 */

import { claudeJson, CLAUDE_JUDGMENT_MODEL, ModelRefusalError } from './llm'
import { PipelineHaltError, UsageLimitError } from './usageLimit'
import type { EpisodeInfo, ParsedRef, ResolvedRef } from './referenceLookup'

/** One extracted statement from the cited chunk (a raw_insight that belongs to a claim). */
export type InsightCandidate = { id: string; statement: string; quote: string | null }

export type StudyInfo = Pick<ResolvedRef, 'title' | 'authors' | 'year' | 'journal'> & { abstract?: string | null }

export type ClaimLinkInput = {
  raw: string
  parsed: ParsedRef
  episode: EpisodeInfo
  study: StudyInfo
  insights: InsightCandidate[]
}

export type ClaimLinkOutcome =
  | 'selected' // the model answered (possibly with nothing selected)
  | 'failed' // the model call failed: try again later, do not link
  | 'refused' // the model declined this text: retrying will not help, link nothing

export type ClaimLinkResult = {
  outcome: ClaimLinkOutcome
  /** Ids of the insights chosen as being about the study. */
  selectedIds: string[]
  /** How many statements the model looked at. */
  considered: number
}

export type ClaimLinkDeps = {
  /** Model call: the numbers (positions in `input.insights`) of the statements that are about the study. May throw. */
  judge: (input: ClaimLinkInput) => Promise<number[]>
}

/** Statements per model call: a long chunk is judged in several calls. */
export const CLAIM_LINK_BATCH = 40

const SYSTEM = `
A speaker on a medical podcast cited a published study. The study was identified in a database (given below). A numbered list of statements follows; each was extracted from the same few minutes of the conversation.

Choose the statements that report what THIS study found, did or concluded, as the speaker described it: its result, population, sample size, dose, duration, effect size or limitation, or a conclusion the speaker draws from it. A statement that restates the study's own method or setting also counts.

Do NOT choose a statement that is general background, advice, a mechanism, or a point about the field, even when it was said right next to the citation. Do NOT choose a statement about a different study. Do NOT choose a statement that is only loosely related to the topic. When unsure, leave the statement out: a statement wrongly tied to a study is worse than one left unlinked.

Return STRICT JSON {"indexes": [<numbers of the chosen statements>]}. If none qualify, return {"indexes": []}.
`.trim()

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** The text the model sees for one batch of statements. Exported so tests can check what is (and is not) sent. */
export function buildClaimLinkPrompt(input: ClaimLinkInput): string {
  const s = input.study
  const study = [
    `"${s.title}"`,
    `${(s.authors ?? []).slice(0, 3).join(', ') || 'authors n/a'}, ${s.journal ?? 'journal n/a'}, ${s.year ?? 'year n/a'}`,
    s.abstract ? `abstract: ${clip(s.abstract, 600)}` : null,
  ].filter(Boolean).join('\n')
  const list = input.insights
    .map((c, i) => `[${i}] ${clip(c.statement, 400)}${c.quote ? `\n    said: "${clip(c.quote, 240)}"` : ''}`)
    .join('\n')
  const e = input.episode
  return [
    `Speaker said: "${clip(input.raw, 300)}"`,
    `Finding the speaker attributed to the study: ${clip(input.parsed.context, 400) || 'n/a'}`,
    `Episode: ${e.title ?? 'unknown'} (people: ${e.people.join(', ') || 'unknown'})`,
    `\nStudy found in the database:\n${study}`,
    `\nStatements:\n${list}`,
  ].join('\n')
}

async function defaultJudge(input: ClaimLinkInput): Promise<number[]> {
  const j = await claudeJson<{ indexes?: unknown }>(SYSTEM, buildClaimLinkPrompt(input), 600, CLAUDE_JUDGMENT_MODEL)
  if (!Array.isArray(j.indexes)) throw new Error('claim-link answer had no "indexes" list')
  return j.indexes as number[]
}

export function defaultClaimLinkDeps(): ClaimLinkDeps {
  return { judge: defaultJudge }
}

function isFatal(e: unknown): boolean {
  return e instanceof PipelineHaltError || e instanceof UsageLimitError
}

/** Keep only whole numbers that point at a statement in the batch, once each. */
function validIndexes(answer: unknown, size: number): number[] {
  if (!Array.isArray(answer)) return []
  const out = new Set<number>()
  for (const v of answer) if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < size) out.add(v)
  return [...out].sort((a, b) => a - b)
}

/**
 * Pick the statements (from the cited chunk) that are about the study. One model call per
 * CLAIM_LINK_BATCH statements. A usage-limit or halt error propagates; any other failure
 * is `failed` (nothing selected, caller retries later); a refusal is `refused` (nothing selected, final).
 */
export async function selectInsightsAboutStudy(input: ClaimLinkInput, overrides: Partial<ClaimLinkDeps> = {}): Promise<ClaimLinkResult> {
  const deps: ClaimLinkDeps = { ...defaultClaimLinkDeps(), ...overrides }
  const selectedIds: string[] = []
  if (input.insights.length === 0) return { outcome: 'selected', selectedIds, considered: 0 }
  for (let from = 0; from < input.insights.length; from += CLAIM_LINK_BATCH) {
    const batch = input.insights.slice(from, from + CLAIM_LINK_BATCH)
    try {
      const picked = validIndexes(await deps.judge({ ...input, insights: batch }), batch.length)
      for (const i of picked) selectedIds.push(batch[i].id)
    } catch (e) {
      if (isFatal(e)) throw e
      return { outcome: e instanceof ModelRefusalError ? 'refused' : 'failed', selectedIds: [], considered: input.insights.length }
    }
  }
  return { outcome: 'selected', selectedIds, considered: input.insights.length }
}
