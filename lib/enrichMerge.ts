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
 *   2. FIDELITY GUARD — the rewritten canonical may not assert a numeric specific
 *      (number / dose / threshold) that NO member carried. If it invents one, the
 *      rewrite is REJECTED and the prior canonical is kept. This is the spec §6
 *      merge-fidelity signal applied at write time. (Note the guard's scope: it
 *      catches *invented* specifics. It does NOT catch a lossy *average* of two
 *      real values into a range — both endpoints exist in the members, so they
 *      pass. That failure is prevented by the synthesis prompt, which forbids
 *      blending divergent doses/populations into a range, and detected by the
 *      harness's per-side numeric-coverage check.)
 */

import { claudeJson, CLAUDE_BULK_MODEL } from './llm'

/** Enrich-merge runs in the live pipeline only when explicitly enabled. Off by
 *  default so switching the adjudicator to V3 does not silently start rewriting
 *  canonicals on the next consolidation — Paul opts in per the surfaced decision. */
export const ENRICH_MERGE_ENABLED = process.env.ENRICH_MERGE === '1'

/** Mechanical-synthesis tier (Haiku): merge-fidelity is assembly, not prose. */
export const ENRICH_MODEL = CLAUDE_BULK_MODEL

export type EnrichResult = {
  /** The canonical to persist — the rewrite when it passed, else the prior one. */
  canonical: string
  /** True when the canonical actually changed (a rewrite passed the guard). */
  changed: boolean
  /** True when the guard rejected the rewrite (invented specifics) — prior kept. */
  rejected: boolean
  /** Numeric specifics the rewrite asserted that no member carried (guard hits). */
  invented: string[]
  reason: string
}

export const ENRICH_SYNTHESIS_SYSTEM = `
You merge several MEMBER statements — all expressing ONE underlying medical claim — into a SINGLE canonical statement for a clinician knowledge base. Your ONLY job is faithful assembly of what the members already say; you contribute syntax, never substance.

Rules (in priority order):
1. Carry EVERY concrete detail that appears in ANY member: each number, dose, population, threshold, timeframe, caveat, mechanism, effect size, named condition, and recommendation. Losing a detail is the failure this step exists to prevent.
2. Add NOTHING no member states. Do not introduce a number, dose, population, threshold, or qualifier that is not present in a member. Do not estimate, round, or generalize.
3. NEVER average or blend divergent specifics into a range. When members give different values for different populations or conditions, name EACH explicitly with its population/condition. Correct: "1.6 g/kg for adults; 2.2 g/kg for older adults". WRONG: "1.6-2.2 g/kg" (this erases the population split — the exact failure to avoid).
4. Prefer the members' own words. Compose and stitch; do not paraphrase away specifics.
5. Return ONE coherent statement (a semicolon or short clause list is fine). No preamble, no source narration, no commentary.

Return STRICT JSON: {"canonical":"<the single merged statement>"}
`.trim()

/** Numeric specifics in a statement: integers/decimals (commas stripped). Percent,
 *  units, and ranges reduce to their numeric literals, which is what the guard
 *  compares — an *invented* value is one whose literal appears in no member. */
export function numericSpecifics(text: string): string[] {
  const normalized = text.replace(/(\d),(\d)/g, '$1$2') // 1,000 → 1000
  return normalized.match(/\d+(?:\.\d+)?/g) ?? []
}

/**
 * Fidelity guard: does `canonical` assert any numeric specific that appears in
 * none of the `grounding` texts (the member statements/quotes)? Returns the list
 * of invented literals; empty list ⇒ every specific traces to a member.
 */
export function fidelityCheck(
  canonical: string,
  grounding: string[]
): { ok: boolean; invented: string[] } {
  const groundSet = new Set(grounding.flatMap(numericSpecifics))
  const invented = numericSpecifics(canonical).filter(n => !groundSet.has(n))
  return { ok: invented.length === 0, invented }
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
  opts?: { memberQuotes?: string[]; model?: string }
): Promise<EnrichResult> {
  const members = memberStatements.map(s => s.trim()).filter(Boolean)
  // Grounding for the guard: member statements + prior canonical (itself
  // member-derived) + any verbatim quotes. Members are the immutable ground truth.
  const grounding = [priorCanonical, ...members, ...(opts?.memberQuotes ?? [])].filter(Boolean)

  if (members.length === 0) {
    return { canonical: priorCanonical, changed: false, rejected: false, invented: [], reason: 'no members' }
  }

  const user =
    `PRIOR canonical:\n${priorCanonical}\n\n` +
    `MEMBER statements (merge ALL detail from these):\n` +
    members.map((s, i) => `${i + 1}. ${s}`).join('\n')

  let proposed: string
  try {
    const parsed = await claudeJson<{ canonical?: string }>(
      ENRICH_SYNTHESIS_SYSTEM,
      user,
      2000,
      opts?.model ?? ENRICH_MODEL
    )
    proposed = (parsed.canonical ?? '').trim()
  } catch (err) {
    return {
      canonical: priorCanonical,
      changed: false,
      rejected: false,
      invented: [],
      reason: `synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!proposed) {
    return { canonical: priorCanonical, changed: false, rejected: false, invented: [], reason: 'empty synthesis' }
  }

  const guard = fidelityCheck(proposed, grounding)
  if (!guard.ok) {
    // Rewrite invented a specific no member carried — reject, keep prior canonical.
    return {
      canonical: priorCanonical,
      changed: false,
      rejected: true,
      invented: guard.invented,
      reason: `fidelity guard rejected rewrite: invented ${guard.invented.join(', ')}`,
    }
  }

  const changed = proposed !== priorCanonical.trim()
  return {
    canonical: proposed,
    changed,
    rejected: false,
    invented: [],
    reason: changed ? 'enriched' : 'no change',
  }
}
