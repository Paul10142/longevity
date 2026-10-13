/**
 * Enrich-merge: rewrite a claim's canonical statement to carry EVERY detail from
 * all its members (v4 spec §6, "Enrich-merge", Paul confirmed 2026-07-23).
 *
 * The problem this fixes: `attachMember` (lib/consolidation.ts) keeps the SEED
 * claim's canonical and files the new insight underneath, so any detail the new
 * member carried that the seed lacked is BURIED — present in the evidence
 * drill-down, absent from the canonical the article is written from. Enrich-merge
 * regenerates the canonical to hold both sides' detail.
 *
 * This module is deliberately import-light (only `./llm`, which needs no Supabase
 * or DB env): the DB wrapper lives in `lib/consolidation.ts`, and the measurement
 * harness (`scripts/testEnrichMerge.ts`) imports the pure synthesis + fidelity
 * guard here without a configured database — the same split as `adjudicationPrompts.ts`.
 *
 * The two guarantees:
 *   1. Mechanical synthesis on Haiku (spec §C2) — not Opus; this is assembly, not
 *      prose. Compose from member phrasings, never free-generate.
 *   2. FIDELITY GUARD, two directions. The rewritten canonical may not assert a
 *      numeric specific (number / dose / threshold) that NO member carried
 *      (INVENTED), and may not omit one that a member or the prior canonical
 *      carried (DROPPED, added 2026-10-12 — the mirror check). Either one REJECTS
 *      the rewrite and keeps the prior canonical; nothing is lost, the members stay
 *      linked and the canonical keeps its old wording. This is the spec §6
 *      merge-fidelity signal applied at write time. (Scope: it does NOT catch a
 *      lossy *average* of two real values into a range — both endpoints exist in
 *      the members, so they pass. That failure is prevented by the synthesis
 *      prompt, which forbids blending divergent doses/populations into a range, and
 *      detected by the harness's per-side numeric-coverage check. Nor does it see
 *      a dropped QUALIFIER ("in mice", "only in men over 50") — see
 *      docs/judge-speedup.md.)
 */

import { claudeJson, CLAUDE_BULK_MODEL } from './llm'
import { rethrowIfUsageLimit } from './usageLimit'

/**
 * Enrich-merge is ON unless explicitly disabled with `ENRICH_MERGE=0`.
 *
 * It was opt-in (`=== '1'`) so that switching the adjudicator to V3 would not
 * silently start rewriting canonicals before Paul had decided. He decided on
 * 2026-08-16: on. Leaving the gate opt-in after that point actively misled —
 * the flag lived in `.env.local`, which is gitignored, so the local pipeline
 * enriched while the DEPLOYED admin did not. Every merge Paul made from the
 * production review queue silently kept the loser's detail buried, which is the
 * exact failure the decision was meant to end.
 *
 * Defaulting ON makes the behaviour travel with the code to every environment.
 * The escape hatch is inverted rather than removed: set `ENRICH_MERGE=0` to run
 * a lossy merge deliberately (e.g. bisecting a bad rewrite).
 */
export const ENRICH_MERGE_ENABLED = process.env.ENRICH_MERGE !== '0'

/** Mechanical-synthesis tier (Haiku): merge-fidelity is assembly, not prose. */
export const ENRICH_MODEL = CLAUDE_BULK_MODEL

/** Try the rewrite WITHOUT the CLI's default thinking pass first (19.8 s → 2.6 s per call), and re-run it
 *  WITH thinking only when the fidelity guard rejects the fast one (~3% of rewrites on number-bearing
 *  facts; measured 2026-10-12, docs/judge-speedup.md). On at Paul's word, 2026-10-12. `ENRICH_NO_THINKING=0`
 *  restores thinking on every rewrite. The text that survives is always one the guard passed. */
export const ENRICH_NO_THINKING = process.env.ENRICH_NO_THINKING !== '0'

export type EnrichOpts = {
  memberQuotes?: string[]
  model?: string
  /** First attempt without the thinking pass (default `ENRICH_NO_THINKING`). */
  noThinking?: boolean
  /** Re-run with thinking when the fast attempt is rejected by the guard (default true). */
  fallbackToThinking?: boolean
  /** Replaces the model call (tests only). */
  complete?: (system: string, user: string, noThinking: boolean) => Promise<{ canonical?: string }>
}

export type EnrichResult = {
  /** The canonical to persist — the rewrite when it passed, else the prior one. */
  canonical: string
  /** True when the canonical actually changed (a rewrite passed the guard). */
  changed: boolean
  /** True when the guard rejected the rewrite (invented or dropped specifics) — prior kept. */
  rejected: boolean
  /** Numeric specifics the rewrite asserted that no member carried (guard hits). */
  invented: string[]
  /** Numeric specifics a member (or the prior canonical) carried that the rewrite left out. */
  missing: string[]
  reason: string
  /** The rewrite the model proposed, before the guard — set whenever there was one (diagnostics). */
  proposed?: string
  /** True when the fast (no-thinking) rewrite was rejected, or identical to the prior canonical, and this result is the thinking re-run's. */
  retriedWithThinking?: boolean
  /** Why the fast rewrite was not accepted, when `retriedWithThinking`. */
  fastRejection?: string
}

export const ENRICH_SYNTHESIS_SYSTEM = `
You merge several MEMBER statements — all expressing ONE underlying medical claim — into a SINGLE canonical statement for a clinician knowledge base. Your ONLY job is faithful assembly of what the members already say; you contribute syntax, never substance.

Rules (in priority order):
1. Carry EVERY concrete detail that appears in ANY member: each number, dose, population, threshold, timeframe, caveat, mechanism, effect size, named condition, recommendation, AND — treat these as first-class, never optional — every PRACTICAL EXAMPLE, concrete illustration (a specific food, exercise, practice, protocol, or worked case), and applied nuance. Practical examples are what let a reader FRAME and APPLY the knowledge, so a merge that drops one has failed even if every number survived. Losing a detail is the failure this step exists to prevent.
2. Add NOTHING no member states. Do not introduce a number, dose, population, threshold, or qualifier that is not present in a member. Do not estimate, round, or generalize.
3. NEVER average or blend divergent specifics into a range. When members give different values for different populations or conditions, name EACH explicitly with its population/condition. Correct: "1.6 g/kg for adults; 2.2 g/kg for older adults". WRONG: "1.6-2.2 g/kg" (this erases the population split — the exact failure to avoid).
4. Prefer the members' own words. Compose and stitch; do not paraphrase away specifics.
5. Return ONE coherent statement (a semicolon or short clause list is fine). No preamble, no source narration, no commentary.

Return STRICT JSON: {"canonical":"<the single merged statement>"}
`.trim()

const SCRIPT_DIGITS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
}

/** Sub/superscript digits become plain ones (VO₂ = VO2) and thousands separators go (1,000 → 1000).
 *  Only a comma followed by exactly three digits is a separator: "types 1,2,3" stays three numbers. */
function prep(text: string): string {
  return text
    .replace(/(?:⁻|\^-|\^−)\s*[⁰¹²³⁴-⁹\d]/g, ' ') // a unit exponent (ml·kg⁻¹·min⁻¹, kg^-1) is not a quantity
    .replace(/[₀-₉⁰¹²³⁴-⁹]/g, c => SCRIPT_DIGITS[c] ?? c)
    .replace(/\d{1,3}(?:,\d{3})+(?!\d)/g, m => m.replace(/,/g, ''))
}

/** "5", "5.0", "05" and "5.00" are one number. Very long digit strings (ids) are left as written. */
const canon = (n: string) => (n.length <= 15 ? String(Number(n)) : n)

/** Numeric specifics in a statement: integers/decimals. Percent, units, and ranges
 *  reduce to their numeric literals, which is what the guard compares — an
 *  *invented* value is one whose literal appears in no member. */
export function numericSpecifics(text: string): string[] {
  return (prep(text).match(/\d+(?:\.\d+)?/g) ?? []).map(canon)
}

const WORD_UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90, hundred: 100,
}
// Spelled-out numbers and the fractions people write instead of a percent.
const WORD_NUMBER = new RegExp(
  `\\b(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\\s‑]?)?(?:${Object.keys(WORD_UNITS).join('|')})\\b|\\b(?:half|quarter|third|fifth|tenth)s?\\b`,
  'gi'
)
const FRACTION_WORDS: Record<string, string[]> = { half: ['50', '0.5'], quarter: ['25', '0.25'], third: ['33'], fifth: ['20'], tenth: ['10'] }

/** The numbers a statement spells out in words ("five weeks" → 5, "twenty-five" → 25, "half" → 50). */
function numberWords(text: string, skipOne: boolean): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().match(WORD_NUMBER) ?? []) {
    const w = m.replace(/s$/, '')
    if (FRACTION_WORDS[w]) { out.push(...FRACTION_WORDS[w]); continue }
    const parts = w.split(/[-\s‑]+/).filter(Boolean)
    if (parts.length === 1 && parts[0] === 'one' && skipOne) continue // "one of the most…" is not a quantity
    out.push(String(parts.reduce((t, p) => t + (WORD_UNITS[p] ?? 0), 0)))
  }
  return out
}

/**
 * Fidelity guard: does `canonical` assert any numeric specific that appears in
 * none of the `grounding` texts (the member statements/quotes)? Returns the list
 * of invented literals; empty list ⇒ every specific traces to a member. A member
 * that spells a number out ("five") grounds the digit ("5").
 */
export function fidelityCheck(
  canonical: string,
  grounding: string[]
): { ok: boolean; invented: string[] } {
  const groundSet = new Set([...grounding.flatMap(numericSpecifics), ...grounding.flatMap(g => numberWords(g, true))])
  const invented = numericSpecifics(canonical).filter(n => !groundSet.has(n))
  return { ok: invented.length === 0, invented }
}

// What is NOT a clinical specific, and so is not required to survive a rewrite (an invented one
// is still caught — only the "must keep" side ignores these).
const UNIT =
  '(?:mg|mcg|µg|μg|ug|g|kg|iu|kcal|cal|calories?|steps?|ml|dl|l|mmol|nmol|ng|pg|units?|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|reps?|people|persons?|participants?|patients?|subjects?|adults?|women|men|children|cases?|deaths?|events?|metres?|meters?|km|miles?|cm|lbs?|bpm|mmhg|watts?|w|m)'
const NOT_REQUIRED: RegExp[] = [
  // a year, unless a unit follows ("2000 mg", "2000 steps", "2,000" never matches: it has a comma)
  new RegExp(`\\b(?:19|20)\\d{2}[a-z]?\\b(?!\\s*(?:[-–]\\s*\\d+\\s*)?${UNIT}\\b)(?!\\s*%)`, 'gi'),
  /\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, // citation numbers: [12], [3-5]
  /\b(?:PMID|PMCID|PMC|DOI|NCT)\s*:?\s*[\w./-]*\d[\w./-]*/gi, // database ids
  /\b(?:tables?|fig(?:ure)?s?\.?|supplement(?:ary)?|appendix|refs?\.?|references?)\s*S?\d+[a-z]?(?:\s*[,–-]\s*\d+)*/gi,
]

/** The numeric specifics a statement carries that a rewrite must not lose (years, citation
 *  numbers, table/figure numbers and database ids excluded). */
export function requiredSpecifics(text: string): string[] {
  let t = prep(text)
  for (const re of NOT_REQUIRED) t = t.replace(re, ' ')
  return numericSpecifics(t)
}

/**
 * Mirror of the fidelity guard: numeric specifics the `sources` (members and prior
 * canonical) carry that the rewrite leaves out. A specific counts as kept when the
 * rewrite has it as digits, spells it out ("5" / "five", "50%" / "half"), or it falls
 * strictly inside a range the rewrite states ("30-40" covers a member's 35).
 * Written a different way it reads as missing and the rewrite is rejected, which costs
 * one enrichment, not data: "90 minutes" for "1.5 hours" is the known case.
 */
export function droppedSpecifics(rewrite: string, sources: string[]): string[] {
  const required = [...new Set(sources.flatMap(requiredSpecifics))]
  if (required.length === 0) return []
  const have = new Set([...numericSpecifics(rewrite), ...numberWords(rewrite, false)])
  const text = prep(rewrite)
  const ranges: [number, number][] = []
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to|through)\s*(\d+(?:\.\d+)?)/gi)) ranges.push([Number(m[1]), Number(m[2])])
  for (const m of text.matchAll(/between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)/gi)) ranges.push([Number(m[1]), Number(m[2])])
  return required.filter(n => !have.has(n) && !ranges.some(([lo, hi]) => lo < Number(n) && Number(n) < hi))
}

/**
 * Regenerate a canonical from its members, grounded in members only, guarded for
 * invented specifics. Pure (no DB): the caller supplies the prior canonical and
 * every member statement (and, when available, verbatim member quotes for extra
 * grounding). On rejection or no-op it returns the prior canonical unchanged.
 */
export async function synthesizeEnrichedCanonical(
  priorCanonical: string,
  memberStatements: string[],
  opts?: EnrichOpts
): Promise<EnrichResult> {
  const fast = opts?.noThinking ?? ENRICH_NO_THINKING
  const first = await attemptRewrite(priorCanonical, memberStatements, opts, fast)
  // A fast rewrite is retried once with the thinking pass when the guard rejected it, or when it came
  // back identical to the prior canonical (the new member's detail would stay buried; measured 3/111
  // on number-bearing gold pairs, 0/111 with thinking). A failed or empty call is not retried here
  // (the caller's own retry handles those).
  if (fast && (opts?.fallbackToThinking ?? true) && (first.rejected || first.reason === 'no change')) {
    const second = await attemptRewrite(priorCanonical, memberStatements, opts, false)
    return { ...second, retriedWithThinking: true, fastRejection: first.rejected ? first.reason : 'fast rewrite was identical to the prior canonical' }
  }
  return first
}

async function attemptRewrite(
  priorCanonical: string,
  memberStatements: string[],
  opts: EnrichOpts | undefined,
  noThinking: boolean
): Promise<EnrichResult> {
  const members = memberStatements.map(s => s.trim()).filter(Boolean)
  // Grounding for the guard: member statements + prior canonical (itself
  // member-derived) + any verbatim quotes. Members are the immutable ground truth.
  const grounding = [priorCanonical, ...members, ...(opts?.memberQuotes ?? [])].filter(Boolean)

  if (members.length === 0) {
    return { canonical: priorCanonical, changed: false, rejected: false, invented: [], missing: [], reason: 'no members' }
  }

  const user =
    `PRIOR canonical:\n${priorCanonical}\n\n` +
    `MEMBER statements (merge ALL detail from these):\n` +
    members.map((s, i) => `${i + 1}. ${s}`).join('\n')

  let proposed: string
  try {
    const parsed = opts?.complete
      ? await opts.complete(ENRICH_SYNTHESIS_SYSTEM, user, noThinking)
      : await claudeJson<{ canonical?: string }>(ENRICH_SYNTHESIS_SYSTEM, user, 2000, opts?.model ?? ENRICH_MODEL, undefined, { noThinking })
    proposed = (parsed.canonical ?? '').trim()
  } catch (err) {
    rethrowIfUsageLimit(err)
    return {
      canonical: priorCanonical,
      changed: false,
      rejected: false,
      invented: [],
      missing: [],
      reason: `synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!proposed) {
    return { canonical: priorCanonical, changed: false, rejected: false, invented: [], missing: [], reason: 'empty synthesis' }
  }

  // Both directions are always computed, so a rejection reports everything wrong with the rewrite.
  const guard = fidelityCheck(proposed, grounding)
  const missing = droppedSpecifics(proposed, [priorCanonical, ...members])
  if (!guard.ok || missing.length > 0) {
    // The rewrite invented a specific no member carried, or dropped one a member
    // carried — reject, keep the prior canonical (the members stay linked).
    const bits = [
      guard.invented.length ? `invented ${guard.invented.join(', ')}` : '',
      missing.length ? `dropped ${missing.join(', ')}` : '',
    ].filter(Boolean)
    return {
      canonical: priorCanonical,
      changed: false,
      rejected: true,
      invented: guard.invented,
      missing,
      reason: `fidelity guard rejected rewrite: ${bits.join('; ')}`,
      proposed,
    }
  }

  const changed = proposed !== priorCanonical.trim()
  return {
    canonical: proposed,
    changed,
    rejected: false,
    invented: [],
    missing: [],
    reason: changed ? 'enriched' : 'no change',
    proposed,
  }
}
