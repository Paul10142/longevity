/**
 * Extraction-fidelity judge (spec §6.2) — shared by the eval harness and the
 * live flag rule, so the number Paul validates and the rule that runs the corpus
 * are the SAME judge. If they diverged, the eval would certify one thing and
 * production would do another.
 *
 * The question is FAITHFULNESS TO THE SOURCE, not medical correctness: does the
 * insight assert something its chunk did not say? The cardinal failure is
 * ADDED_DETAIL (invented substance) — a principle-1 violation, and the reason
 * this is worth ~1 LLM call per insight.
 */

import { claudeJson, CLAUDE_JUDGMENT_MODEL } from './llm'

export type FidelityVerdict =
  | 'FAITHFUL'
  | 'ADDED_DETAIL'
  | 'DROPPED_QUALIFIER'
  | 'UNRESOLVED_REFERENCE'
  | 'UNSURE'

export type FidelityResult = {
  verdict: FidelityVerdict
  offending: string
  reasoning: string
}

export const FIDELITY_JUDGE_SYSTEM = `
You audit whether a one-sentence INSIGHT faithfully represents the TRANSCRIPT CHUNK it was extracted from.

You are checking FAITHFULNESS TO WHAT THE SOURCE SAID — not medical correctness, not completeness. A statement can be medically incomplete and still faithful. A statement can be medically true and still UNFAITHFUL, if the chunk did not say it.

Return exactly one verdict:

- "ADDED_DETAIL" — the insight asserts a specific the chunk does not support: a number, dose, population, mechanism, or named entity that is absent from the chunk, OR a claim the chunk only gestures at. Being TRUE does not excuse it. This is the most serious verdict; look for it first.
- "DROPPED_QUALIFIER" — the chunk stated a qualifier that limits when the claim holds (population, dose, duration, comorbidity, "in athletes", "after age 50", "on a low-carb diet") and the insight states the claim without it, so it reads as more general than the source made it.
- "UNRESOLVED_REFERENCE" — the insight depends on something this chunk never defines ("that protocol", "this rebalancing", "the second mechanism"), because extraction sees one chunk at a time and the referent was established elsewhere.
- "FAITHFUL" — every load-bearing element traces to the chunk, and no stated qualifier was lost.
- "UNSURE" — the chunk is too garbled or the call is genuinely too close.

Ignore: paraphrasing, reordering, compression, and dropped conversational filler. Rewording is the job. Only flag changes that alter what a clinician would DO with the statement.

Return ONLY JSON:
{"verdict":"FAITHFUL|ADDED_DETAIL|DROPPED_QUALIFIER|UNRESOLVED_REFERENCE|UNSURE","offending":"the exact phrase at fault, or empty when FAITHFUL","reasoning":"one sentence"}
`.trim()

const ALLOWED: FidelityVerdict[] = ['FAITHFUL', 'ADDED_DETAIL', 'DROPPED_QUALIFIER', 'UNRESOLVED_REFERENCE', 'UNSURE']
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A judgement whose reasoning starts with `error:` is a swallowed transport
 *  failure, not a verdict — a missing measurement, never counted as FAITHFUL or
 *  as a violation. */
export const isRealFidelity = (r: FidelityResult): boolean => !r.reasoning.startsWith('error:')

/**
 * Judge one insight against its source chunk, retrying transient CLI/parse
 * failures with backoff (the claude-code backend intermittently returns prose).
 * Only after the last attempt is the error recorded, so a throttled batch is a
 * missing measurement rather than a fabricated verdict.
 */
export async function judgeFidelity(
  statement: string,
  chunkText: string,
  opts?: { contextNote?: string | null; directQuote?: string | null; retries?: number }
): Promise<FidelityResult> {
  const retries = opts?.retries ?? 5
  const user = [
    `TRANSCRIPT CHUNK:\n${chunkText}`,
    `\nINSIGHT:\n${statement}`,
    opts?.contextNote ? `\nCONTEXT NOTE:\n${opts.contextNote}` : '',
    opts?.directQuote ? `\nQUOTE THE EXTRACTOR CITED:\n${opts.directQuote}` : '',
  ].join('\n')

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 30_000))
    try {
      const parsed = await claudeJson<{ verdict?: string; offending?: string; reasoning?: string }>(
        FIDELITY_JUDGE_SYSTEM, user, 1200, CLAUDE_JUDGMENT_MODEL
      )
      const verdict = ALLOWED.includes(parsed.verdict as FidelityVerdict) ? (parsed.verdict as FidelityVerdict) : 'UNSURE'
      return { verdict, offending: parsed.offending ?? '', reasoning: parsed.reasoning ?? '' }
    } catch (err) {
      lastErr = err
    }
  }
  return { verdict: 'UNSURE', offending: '', reasoning: `error: ${lastErr instanceof Error ? lastErr.message : lastErr}` }
}

/** The verdicts that constitute an unfaithful extraction (i.e. flag-worthy).
 *  UNSURE and FAITHFUL do not flag. */
export function isViolation(v: FidelityVerdict): boolean {
  return v === 'ADDED_DETAIL' || v === 'DROPPED_QUALIFIER' || v === 'UNRESOLVED_REFERENCE'
}
