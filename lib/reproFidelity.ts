/**
 * Fidelity flag rate for the reproducibility harness (2026-11-09). Pure helpers, no model calls,
 * no database: the certified judge itself (lib/extractionFidelity.ts) is called by
 * scripts/evalReproducibility.ts `fidelity`, and these functions turn its verdicts into the
 * number Paul's bar is written in.
 *
 * Paul's third condition (plan section 3.2 and 7, 2026-11-08): the fidelity flag rate on the new
 * extraction setup "not more than 2 points above" the figure PR #59 measured for Opus 5.5 (8.9%),
 * so an exhaustive or context-rich prompt cannot pass by inventing. "Flag rate" is defined exactly
 * as in PR #59's report (scratchpad/extraction-compare/REPORT.md):
 *
 *     (ADDED_DETAIL + DROPPED_QUALIFIER + UNRESOLVED_REFERENCE) / insights with a real verdict
 *
 * UNSURE counts as judged but not flagged; a call that errored is a missing measurement (it is in
 * neither the numerator nor the denominator), exactly as `isRealFidelity` treats it.
 */

import { foldQuote, quoteFragments, type Doc } from './reproducibility'
import { isRealFidelity, isViolation, type FidelityVerdict } from './extractionFidelity'

/** PR #59's figures (8 Attia episodes, same judge, same definition), from scratchpad/extraction-compare/REPORT.md. */
export const FIDELITY_BASELINE = {
  /** The new setup (Opus 5.5, v2 prompt, gate + repair): 83 + 38 + 17 = 138 flagged of 1,550 kept. The plan's 8.9%. */
  opus55NewSetup: { flagged: 138, judged: 1550, rate: 0.089, episodes: 8, perEpisodeMin: 0.036, perEpisodeMax: 0.154 },
  /** The old setup that built the library (Haiku 4.5, v1 prompt, stored insights): 260 + 161 = 421 of 1,258. */
  haiku45OldSetup: { flagged: 421, judged: 1258, rate: 0.335, episodes: 8, perEpisodeMin: 0.286, perEpisodeMax: 0.417 },
  /** Paul's bar: at most this many points above the Opus 5.5 figure. */
  barPoints: 2,
} as const

/** One judged insight as stored in fidelity/<pass>.json. */
export type JudgedRow = {
  id: string
  chunk: number
  verdict: FidelityVerdict
  offending: string
  reasoning: string
  ms: number
  costUsd: number
  /** Did the insight's cited quote appear in the chunk text the judge was shown? null when it cited none. */
  quoteInChunk: boolean | null
}

export type FidelityTally = {
  /** Insights in the pass file. */
  insights: number
  /** Insights with a real verdict (the denominator). */
  judged: number
  /** Calls that errored: a missing measurement, not a verdict. */
  errors: number
  /** Insights with no row yet. */
  missing: number
  faithful: number
  unsure: number
  addedDetail: number
  droppedQualifier: number
  unresolvedReference: number
  flagged: number
  /** flagged / judged, or null when nothing was judged. */
  rate: number | null
  /** 95% Wilson interval for the rate. */
  ci: [number, number] | null
}

/** Wilson score interval (default 95%). Honest about small n, unlike the normal approximation. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

const isReal = (r: JudgedRow): boolean => isRealFidelity({ verdict: r.verdict, offending: r.offending, reasoning: r.reasoning })

/** Tally a pass's rows. `totalInsights` is the pass's insight count, so unjudged insights show as `missing`. */
export function tallyFidelity(rows: JudgedRow[], totalInsights: number): FidelityTally {
  const t: FidelityTally = {
    insights: totalInsights, judged: 0, errors: 0, missing: 0, faithful: 0, unsure: 0,
    addedDetail: 0, droppedQualifier: 0, unresolvedReference: 0, flagged: 0, rate: null, ci: null,
  }
  for (const r of rows) {
    if (!isReal(r)) { t.errors++; continue }
    t.judged++
    if (r.verdict === 'FAITHFUL') t.faithful++
    else if (r.verdict === 'UNSURE') t.unsure++
    else if (r.verdict === 'ADDED_DETAIL') t.addedDetail++
    else if (r.verdict === 'DROPPED_QUALIFIER') t.droppedQualifier++
    else if (r.verdict === 'UNRESOLVED_REFERENCE') t.unresolvedReference++
    if (isViolation(r.verdict)) t.flagged++
  }
  t.missing = Math.max(0, totalInsights - t.judged - t.errors)
  t.rate = t.judged > 0 ? t.flagged / t.judged : null
  t.ci = wilson(t.flagged, t.judged)
  return t
}

/** Pool several passes into one tally (counts add; the rate and interval are recomputed). */
export function poolTallies(ts: FidelityTally[]): FidelityTally {
  const sum = (f: (t: FidelityTally) => number) => ts.reduce((n, t) => n + f(t), 0)
  const judged = sum(t => t.judged)
  const flagged = sum(t => t.flagged)
  return {
    insights: sum(t => t.insights), judged, errors: sum(t => t.errors), missing: sum(t => t.missing),
    faithful: sum(t => t.faithful), unsure: sum(t => t.unsure), addedDetail: sum(t => t.addedDetail),
    droppedQualifier: sum(t => t.droppedQualifier), unresolvedReference: sum(t => t.unresolvedReference),
    flagged, rate: judged > 0 ? flagged / judged : null, ci: wilson(flagged, judged),
  }
}

export type BaselineComparison = {
  baselineRate: number
  /** The most the bar allows (baseline + barPoints), as a rate. */
  limit: number
  /** Measured rate minus baseline, in percentage points (one decimal). */
  points: number | null
  /** Rate at or under the limit. null when nothing was judged. */
  meetsBar: boolean | null
  /** The whole 95% interval is under the limit: the bar holds even allowing for sampling noise. */
  intervalUnderLimit: boolean | null
  /** The whole 95% interval is over the limit: the bar clearly fails. */
  intervalOverLimit: boolean | null
}

/**
 * Compare a measured rate with a baseline under "not more than `barPoints` points above".
 * The comparison is on the point estimate rounded to 0.1 point, as the plan states it
 * ("<= 10.9%"); the interval flags how much a single episode's figure can be trusted.
 */
export function compareToBaseline(t: FidelityTally, baselineRate: number, barPoints = FIDELITY_BASELINE.barPoints): BaselineComparison {
  const limit = baselineRate + barPoints / 100
  if (t.rate === null || t.ci === null) {
    return { baselineRate, limit, points: null, meetsBar: null, intervalUnderLimit: null, intervalOverLimit: null }
  }
  const points = Math.round((t.rate - baselineRate) * 1000) / 10
  return {
    baselineRate, limit, points,
    meetsBar: points <= barPoints,
    intervalUnderLimit: t.ci[1] <= limit,
    intervalOverLimit: t.ci[0] > limit,
  }
}

/**
 * Does an insight's cited quote appear in the text the judge saw? Every ellipsis-joined fragment must
 * occur in the folded chunk. null when the insight cites no quote. This is the check that the chunk
 * text rebuilt from the pass header is the text extraction really saw.
 */
export function quoteFitsChunk(chunkText: string, quote: string | null): boolean | null {
  if (!quote || !quote.trim()) return null
  const hay = foldQuote(chunkText)
  const frags = quoteFragments(quote).map(foldQuote).filter(Boolean)
  if (frags.length === 0) return null
  return frags.every(f => hay.includes(f))
}

/** The chunk text a pass saw: the chunked document sliced by the pass's plan (context windows are not part of it). */
export function chunkTextOf(doc: Doc, plan: { start: number; end: number }): string {
  return doc.text.slice(plan.start, plan.end)
}

/** Share of rows whose quote fits their chunk, among rows that cite one (null when none do). */
export function quoteFitShare(rows: Pick<JudgedRow, 'quoteInChunk'>[]): number | null {
  const cited = rows.filter(r => r.quoteInChunk !== null)
  if (cited.length === 0) return null
  return cited.filter(r => r.quoteInChunk).length / cited.length
}

/**
 * Flags that are about who is speaking, not about what was said. The extractor is told the participants
 * ("Host: Peter Attia. Guest(s): James Clear."), but the judge is shown the chunk only, so a correct
 * "James Clear said ..." is judged ADDED_DETAIL ("the chunk never names the speaker"). A text match on the
 * judge's own reasoning: a heuristic for reading the flag rate, not part of the certified verdict.
 */
export const SPEAKER_ATTRIBUTION_REASON =
  /(never names|does not name|doesn.t name|not named|names the speaker|unnamed speaker|no speaker|speaker label|only .{0,40}named|attribut)/i

/** Number of violation rows whose reasoning is about speaker attribution. */
export function speakerAttributionFlags(rows: Pick<JudgedRow, 'verdict' | 'offending' | 'reasoning'>[]): number {
  return rows.filter(r => isRealFidelity(r) && isViolation(r.verdict) && SPEAKER_ATTRIBUTION_REASON.test(r.reasoning)).length
}
