/**
 * Stage 6 — the groundedness audit (design §4.6, §6.5). Runs after the answer
 * has been sent, on Haiku 5.5, in the same shape as `scoreGroundedness` in
 * lib/synthesis.ts: for each stored sentence, is every assertion supported by
 * the claims it cites? A sentence with no citation is shown to the checker as
 * "(none cited)", so a connective sentence that quietly asserts something is
 * caught here too.
 *
 * A checker failure yields `null` (unscored), never 1: an error must not read as
 * a perfect score.
 */

import { claudeJson, trackLlmUsage } from '../llm'
import type { Sentence } from '../blocks'
import { ASK_AUDIT_MODEL } from './types'
import { setAudit } from './store'

/** Sentences audited per call; a brief is ~15-25 sentences, this is only a ceiling on pathological output. */
const MAX_AUDITED = 80
const AUDIT_MAX_TOKENS = 6000

export const AUDIT_SYSTEM =
  'You audit a physician brief for groundedness. For each numbered sentence, decide whether EVERY factual or clinical assertion in it is supported by its listed supporting claims. A sentence with no supporting claims is fine only if it asserts nothing (a transition or framing line). Do not penalise wording that is a faithful paraphrase. Return STRICT JSON {"ungrounded":[<indices of sentences containing an assertion NOT supported by their claims>]}.'

/** The numbered sentence/support listing the checker sees. */
export function buildAuditItems(sentences: Sentence[], statementById: Map<string, string>): string {
  return sentences
    .slice(0, MAX_AUDITED)
    .map((s, i) => {
      const support = s.kind === 'connective' ? [] : s.claim_ids.map(id => statementById.get(id)).filter(Boolean)
      return `[${i}] SENTENCE: ${s.text}\nSUPPORTING CLAIMS: ${support.join(' | ') || '(none cited)'}`
    })
    .join('\n\n')
}

/** 1 - share of sentences flagged; flags outside the listed range are ignored. */
export function scoreFromUngrounded(ungrounded: unknown, audited: number): number | null {
  if (audited <= 0) return null
  const flagged = Array.isArray(ungrounded)
    ? new Set(ungrounded.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < audited))
    : new Set<number>()
  return Math.max(0, 1 - flagged.size / audited)
}

export type AuditResult = { score: number | null; stats: Record<string, unknown> }

export async function auditSentences(sentences: Sentence[], statementById: Map<string, string>): Promise<AuditResult> {
  const audited = Math.min(sentences.length, MAX_AUDITED)
  if (audited === 0) return { score: null, stats: { skipped: 'no sentences' } }
  const startedAt = Date.now()
  try {
    const { result, usage } = await trackLlmUsage(() =>
      // Low effort and room to spare: Haiku 5.5 thinks adaptively, and at 2000 tokens
      // the thinking alone could use the whole budget and leave no JSON (4 of 5
      // measured audits came back "Empty Claude response", 2026-10-25).
      claudeJson<{ ungrounded?: unknown }>(AUDIT_SYSTEM, buildAuditItems(sentences, statementById), AUDIT_MAX_TOKENS, ASK_AUDIT_MODEL, 'low')
    )
    const u = usage.get(ASK_AUDIT_MODEL)
    return {
      score: scoreFromUngrounded(result.ungrounded, audited),
      stats: { ms: Date.now() - startedAt, model: ASK_AUDIT_MODEL, input_tokens: u?.inputTokens ?? 0, output_tokens: u?.outputTokens ?? 0 },
    }
  } catch (e) {
    return { score: null, stats: { ms: Date.now() - startedAt, error: e instanceof Error ? e.message : String(e) } }
  }
}

/** Audit a stored answer and write the score back. Never throws: this runs after the response is sent. */
export async function auditAnswer(answerId: string, sentences: Sentence[], statementById: Map<string, string>): Promise<void> {
  try {
    const { score, stats } = await auditSentences(sentences, statementById)
    await setAudit(answerId, score, stats)
  } catch (e) {
    console.error('[ask] audit write-back failed', answerId, e)
  }
}
