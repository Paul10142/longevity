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
 * V2 — fidelity-first (v4 §A2). Merges ONLY at matching specificity; a material
 * difference in dose, population, threshold, timeframe, or caveat → DIFFERENT;
 * defaults to DIFFERENT when in doubt. Output shape is identical to V1.
 *
 * SUPERSEDED for production by V3 (2026-07-23). Paul ruled the 92-pair gold set
 * MERGE on all 92 (0 keep-separate): V2's strict-split fix targeted the wrong
 * failure — it splits pairs Paul wants merged (recall 59.8%). Kept ONLY as a
 * harness baseline. Do not wire V2 back into the live pipeline.
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

/**
 * V3 — enrich-merge adjudicator (live 2026-07-23, Paul's confirmed model).
 *
 * REVERSES V2. Paul labelled the 92-pair gold set MERGE on all 92 — so for the
 * high-similarity (ANN-matched) pairs the consolidator actually sees, the answer
 * is almost always "merge". The failure V2 chased (over-merging) is not the real
 * one; the real one is *lossy* merging — `attachMember` keeps the seed canonical
 * and buries any detail the new member carried. V3 fixes the decision half:
 *
 *   1. Merge liberally. Same underlying fact even at a different level of detail,
 *      or when one side adds a compatible specific (dose/population/threshold/
 *      caveat/mechanism), is SAME — to be merged, not split. Two population- or
 *      dose-specific values that COEXIST ("1.6 g/kg adults" + "2.2 g/kg older
 *      adults") are the SAME claim: merged while keeping BOTH, never averaged.
 *   2. Return DIFFERENT only on a genuine contradiction (irreconcilable) or an
 *      unrelated fact — never merely because one side is more detailed.
 *   3. Emit an `enrich` flag: true when the new insight carries a detail the
 *      matched claim's canonical lacks, so the merge step knows to rewrite the
 *      canonical to hold both sides. Defaulted conservatively to false.
 *
 * Output shape adds `enrich` to V1/V2's JSON; the rest is unchanged. The lossy
 * *execution* half is fixed by enrich-merge in `lib/consolidation.ts`.
 */
export const ADJUDICATION_V3 = `
You decide whether a NEW medical/health insight belongs to the SAME underlying claim as any of several EXISTING claims in a knowledge base, and whether merging it would ADD detail the existing claim lacks. This is a de-duplication engine whose target is ONE merged claim per fact, whose statement carries EVERY detail from all its members — never a lossy average, never invented specifics.

Decide in two steps.

STEP 1 — SAME or DIFFERENT.
Two statements are the SAME underlying claim when they describe the same relationship, mechanism, recommendation, or finding — EVEN IF:
- one is more general and the other more specific (a principle and the same principle carrying numbers: "protein RDA is insufficient" and "1.2-1.6 g/kg protein" are the SAME claim at two resolutions);
- one side adds a compatible specific the other lacks (a dose, population, threshold, timeframe, caveat, mechanism, effect size, named condition, or extra example);
- two population- or dose-specific values COEXIST without conflicting ("1.6 g/kg for adults" and "2.2 g/kg for older adults" are the SAME claim — two facets of one recommendation, to be MERGED keeping BOTH values, NEVER averaged into "1.6-2.2 g/kg").
Merge liberally: when in doubt whether it is the same fact, prefer SAME.

Return DIFFERENT ONLY when:
- the two GENUINELY CONTRADICT — irreconcilable assertions about the same thing ("X causes Y" vs "X does not cause Y"; mutually exclusive values for the SAME population); OR
- they are UNRELATED — distinct facts that do not describe the same relationship or finding at all.
A mere difference in level of detail, or one side carrying extra specifics, is NEVER grounds for DIFFERENT — those are SAME, and get merged (and flagged enrich below).

STEP 2 — ENRICH (only when the verdict is SAME).
Set "enrich": true when the NEW insight carries ANY concrete detail the matched EXISTING claim's statement does not already contain — a number, dose, population, threshold, timeframe, caveat, mechanism, effect size, named condition, or actionable recommendation. Set "enrich": false only when the new insight is fully redundant: the existing statement already contains everything it asserts. When unsure, default "enrich": false — a missed enrich only leaves detail in the evidence trail, while a spurious one triggers an unnecessary rewrite. For DIFFERENT or UNSURE, "enrich" is always false.

Return STRICT JSON:
{"verdict":"SAME|DIFFERENT|UNSURE","candidate_index":<1-based index of the matching existing claim, or null>,"confidence":<0..1>,"enrich":<true|false>,"reasoning":"<one sentence: if SAME, name the detail the new insight adds or say it is fully redundant; if DIFFERENT, name the contradiction or why unrelated>"}

- "SAME" + the index of the existing claim it matches — the same underlying fact at any level of detail.
- "DIFFERENT" ONLY on a genuine contradiction or an unrelated fact.
- "UNSURE" only when you truly cannot tell whether it is the same fact or a genuinely different one (rare — prefer SAME).
confidence is your certainty in the verdict.
`.trim()
