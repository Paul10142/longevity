/**
 * Consolidation adjudication prompts, versioned.
 *
 * This module has NO imports on purpose: both the production pipeline
 * (`lib/consolidation.ts`) and the measurement harness (`scripts/evalDedup.ts`)
 * import it, and the harness must load without Supabase/env configured. Keeping
 * the prompt text here — not inline in `consolidation.ts` — means the before/after
 * comparison runs the *exact* two prompts, with zero drift and no duplicated text.
 *
 * `ADJUDICATION_V2` is the live production prompt. `ADJUDICATION_V1` is the
 * pre-v4 prompt, preserved only so the harness can measure what the fix changed.
 */

/**
 * V1 — pre-v4 (retired 2026-07-23). Treated "a different level of detail" as
 * SAME, which merged e.g. "1.6 g/kg protein for adults" into "2.2 g/kg for older
 * adults" — the nuance-destroying false merge the v4 rewrite exists to stop
 * (`docs/v4-build-risks-and-cost.md` §A2). Kept verbatim as the harness baseline.
 */
export const ADJUDICATION_V1 = `
You decide whether a NEW medical/health insight expresses the SAME underlying claim as any of several EXISTING claims in a knowledge base.

"Same claim" means the same substantive assertion — same relationship, mechanism, recommendation, or finding — even if worded differently, at a different level of detail, or with different examples. Two statements are DIFFERENT if they make distinct assertions, apply to different populations/conditions in a way that changes the takeaway, or one is a general principle and the other a specific unrelated fact.

Return STRICT JSON:
{"verdict":"SAME|DIFFERENT|UNSURE","candidate_index":<1-based index of the matching existing claim, or null>,"confidence":<0..1>,"reasoning":"<one sentence>"}

- "SAME" + the index of the existing claim it matches, when you are confident they are the same claim.
- "DIFFERENT" when the new insight is a distinct claim from all candidates.
- "UNSURE" when it plausibly matches one but you cannot be confident (e.g. partial overlap, ambiguous scope).
confidence is your certainty in the verdict.
`.trim()

/**
 * V2 — fidelity-first (v4 §A2, live 2026-07-23). Merges ONLY at matching
 * specificity; a material difference in dose, population, threshold, timeframe,
 * or caveat → DIFFERENT; defaults to DIFFERENT when in doubt. Output shape is
 * identical to V1 so the rest of the pipeline is unchanged.
 */
export const ADJUDICATION_V2 = `
You decide whether a NEW medical/health insight expresses the SAME underlying claim as any of several EXISTING claims in a knowledge base. This judgment is the core of a de-duplication engine whose first duty is fidelity: merging two claims that are not truly identical silently averages away a clinically material distinction — a dose, a population, a threshold — that a physician could act on, and no later check catches it. When in doubt, do NOT merge.

Merge as SAME only when the two statements assert the SAME thing at the SAME specificity: the same relationship, mechanism, recommendation, or finding, for the same population, at the same dose/threshold/timeframe, with the same caveats. Wording may differ; substance and specificity may not.

Treat as DIFFERENT whenever the new insight differs from a candidate in any clinically material way, including:
- a different dose, amount, frequency, or duration (e.g. "1.6 g/kg protein for adults" vs "2.2 g/kg for older adults" are DIFFERENT);
- a different population, subgroup, or condition (general adults vs elderly, healthy vs diseased);
- a different threshold, cutoff, or numeric target;
- a different timeframe or time course;
- a different qualifier, caveat, or boundary condition that changes the takeaway;
- one being a general principle and the other a specific case, or an otherwise distinct/unrelated fact.

A mere difference in LEVEL OF DETAIL is NOT grounds for SAME. The more specific claim carries information the general one does not, so a specific claim and a general one are DIFFERENT — never fold one into the other.

Return STRICT JSON:
{"verdict":"SAME|DIFFERENT|UNSURE","candidate_index":<1-based index of the matching existing claim, or null>,"confidence":<0..1>,"reasoning":"<one sentence naming the material difference, or why they are identical at the same specificity>"}

- "SAME" + the index of the existing claim it matches — only when they are materially identical at the same specificity.
- "DIFFERENT" when the new insight makes a distinct assertion, or differs in any material way above, from all candidates.
- "UNSURE" when it plausibly matches one but you cannot tell whether a difference is material (ambiguous scope or population).
confidence is your certainty in the verdict.
`.trim()
