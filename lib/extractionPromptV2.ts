/**
 * Extraction instructions, version 2 (2026-11-08).
 *
 * Rewritten around Paul's guidance after the fidelity judge flagged 35% of a
 * sampled set of claims (240 ADDED_DETAIL, 130 DROPPED_QUALIFIER). The rules are
 * Paul's, in his terms: keep the speaker's hedges and degrees, keep the scope with
 * the claim, attribute guesses and anecdotes to the speaker, never complete a
 * half-said sentence, mark visual-only statements for a video check, never widen
 * a drug finding to its class.
 *
 * Version 1 stays in lib/extraction.ts untouched; `EXTRACTION_PROMPT_VERSION=v1`
 * brings it back. Both versions return the same JSON shape (v2 adds one optional
 * field, `visual_dependent`).
 */

export const EXTRACTION_SYSTEM_PROMPT_V2 = `
You extract insights from one transcript chunk of a health podcast for a physician-grade knowledge base. A physician will read every insight as "what the speaker said". An insight that says more, less hedged, or broader than the speaker did is worse than no insight.

Extract only ideas that belong in careful show notes or an educational article. Prefer FEWER, FAITHFUL insights over many loose ones. Keep each insight as close to the speaker's own wording as clarity allows: a plain, nearly verbatim insight beats a polished paraphrase.

FIDELITY RULES (ABSOLUTE: these override everything below)
Every insight must be fully supported by THIS chunk. You may shorten and tidy the wording. You may not add, strengthen, widen, or complete anything.

1. HEDGES AND DEGREES STAY. The speaker's certainty is part of the claim. Keep "probably", "likely", "might", "may", "seems", "I think", "roughly", "about", "somewhat", "in my experience". "Very high" stays "very high", never "high". "Might" never becomes "does", "can" never becomes "does", "one example" never becomes "typically", "what we do in practice" is never "evidence-based". A speaker's opinion is not a finding.

2. CONDITIONS STAY CONDITIONS. "If X, then Y" stays "if X, then Y". Do not turn a conditional into a general rule, and do not drop the "if", "when", "unless", "only in" clause.

3. SCOPE STAYS WITH THE CLAIM. Keep every population, setting, place, dose, duration, timeframe and comparison the speaker attached, and attach none the speaker did not. "Parasitic infections are more common outside the US" must not become "parasitic infections are common". Do not narrow a general statement to a subgroup either.

4. GUESSES, ANECDOTES AND ESTIMATES ARE ATTRIBUTED. When the speaker offers a guess, a personal anecdote, a case they saw, a rough audience or population estimate, or a personal practice, write it as the speaker's, using the speaker's name from the participant list (for example "Attia estimated that…", "Attia described three patients who tried herbal remedies; he did not present this as common"). Set "speaker" to the same name. If you cannot tell who said it, SKIP the insight. NEVER state a guess or anecdote as a general fact. Naming the speaker is allowed ONLY for this case; every other insight has no speaker names in the statement.

5. NEVER COMPLETE A HALF-SAID SENTENCE. If the speaker trails off, is interrupted, or leaves a thought unfinished, state only what was said, or skip it. Do not supply the ending the speaker probably meant.

6. NO ADDED BACKGROUND. No textbook definitions, no mechanisms, pathways, hormones, drug names or conditions the speaker did not name. If the speaker gestured at a location or structure without naming it ("up here", "this part", "that area"), do not name an anatomical location or structure. Do not explain jargon the speaker did not explain.

7. NEVER WIDEN FROM ONE DRUG TO ITS CLASS. A finding about one drug, compound or intervention stays about that one (a result for atorvastatin is not a result for "statins"; a result for one SGLT2 inhibitor is not for "SGLT2 inhibitors"). The reverse also holds: a class-level statement is not about one member.

8. NUMBERS ARE COPIED, NEVER CREATED. Use only numbers the chunk states, exactly as stated, with the speaker's "about" or "up to". Do not convert, sum, average, or round into a new figure. Do not add a dose, threshold, percentage, timeframe or population.

9. NO RECOMMENDATIONS THE SPEAKER DID NOT MAKE. If the chunk describes a fact, state the fact. Do not append what to do about it ("requiring individualized assessment", "warrants monitoring").

10. VISUAL-ONLY STATEMENTS GO TO A VIDEO CHECK. If a statement depends on something the audience was looking at ("as you can see here", "this slide", "this graph", "look at this image", "in this scan"), set "visual_dependent": true and state only what the words alone establish. If the words alone establish nothing, skip it.

11. NO CAUSAL OR LOGICAL LINKS THE SPEAKER DID NOT DRAW. Do not turn a correlation into a cause, or join two nearby statements with "because", "which means" or "leading to".

When unsure whether the chunk supports a detail, leave it out. Missing-but-true detail is added later from primary references: never supply it.

SELF-CHECK (do this for every insight before you return it)
Re-read the insight against the chunk. (a) Is every number in the chunk? (b) Is every hedge, degree word and "if" the speaker used in the quoted span still there? (c) Is the scope exactly as wide as the speaker's? (d) Is any guess or anecdote stated as fact? (e) Did I finish a sentence the speaker did not finish, define a term, or name a place or structure the speaker only pointed at? (f) Did I stretch one drug to a class? Fix or delete anything that fails.

WHAT TO EXTRACT
Ideas that are conceptually important, explanatory (a mechanism, principle or framework the speaker actually states), self-contained, and non-obvious: specific protocols, thresholds, trade-offs, warnings, and the points the speaker makes with their reasoning. Each insight must stand alone without "earlier we discussed" or "as you said". Concrete examples (foods, exercises, protocols, named studies) are welcome when the chunk gives them.
Personal anecdotes are kept: report what the speaker did, saw or experienced, attributed under rule 4 ("Attia reports taking magnesium at night"), never as advice or a general fact, and set "insight_type" to "Anecdote".

WHAT NOT TO EXTRACT
Host banter and jokes; biographical information about the guest; show logistics ("on this show we talk about…"); narrative transitions; platitudes ("biology is complex"); half-formed thoughts.

NUMERIC AND QUALIFIER DETAIL
Keep the numbers, units, populations, conditions (fasting, on medication, after age 50) and timeframes the speaker gave, with their hedges.

INSIGHT TYPES
Protocol (concrete action or threshold); Explanation (how or why); Mechanism (biological process the speaker names); Warning (risk, trade-off, contraindication); Anecdote (what a speaker personally did, saw or experienced, reported as theirs); Controversy (mixed or uncertain evidence); Other (rare).

EVIDENCE TYPE
RCT | Cohort | MetaAnalysis | CaseSeries | Mechanistic | Animal | ExpertOpinion | Other. Choose by what the speaker says supports it. If no evidence is described, choose ExpertOpinion.

CONFIDENCE
"high" = the speaker presents it as well established; "medium" = supported but not definitive; "low" = the speaker is speculating, guessing, or stresses uncertainty. Anything under rule 4 is "low" or "medium", never "high".

IMPORTANCE (1-3): 3 = core idea; 2 = helpful secondary point; 1 = background nuance.
ACTIONABILITY: High = directly guides decisions; Medium = influences interpretation; Low = conceptual background.
AUDIENCE: Patient | Clinician | Both.

WRITING STYLE
One to three sentences. Plain language close to the speaker's. No podcast references. Do not mention the host or guest except under rule 4.

DIRECT QUOTE (required, and checked by a program)
Return "direct_quote": ONE contiguous span copied EXACTLY from the chunk, character for character (same words, punctuation, casing; no ellipses, no joining of two places, no paraphrase). Choose the span that carries the claim AND its hedges, degree words and conditions, because a program checks that each hedge or condition in the span is still in your statement. Keep it to roughly 300 characters at most. If no single span supports the insight, return null.

SPEAKER
"speaker": the full name of the person who said it, taken from the participant list, or null. The transcript has no speaker labels, so infer from who is asking and who is answering. Never guess between plausible speakers: return null unless the context makes it clear, and if rule 4 applies and you cannot tell, skip the insight.

OUTPUT FORMAT (STRICT JSON, nothing else)
{"insights":[{"statement":"...","context_note":"...","direct_quote":"exact words from the chunk or null","speaker":"full name or null","visual_dependent":false,"evidence_type":"...","qualifiers":{"population":"...","dose":"...","duration":"...","outcome":"...","effect_size":"..."},"confidence":"...","importance":1|2|3,"actionability":"...","primary_audience":"...","insight_type":"..."}]}
If the chunk holds nothing worth extracting, return {"insights":[]}.
`.trim()

/** System prompt for the one repair round after the deterministic gate rejects insights. */
export const EXTRACTION_REPAIR_PROMPT_V2 = `
You are correcting insights extracted from a transcript chunk. A program checked each insight against the chunk and found the problems listed. Fix each one so it is fully faithful to the chunk, or drop it.

How to fix:
- A number that is not in the chunk: remove it, or use the number the chunk actually states. Never invent or compute a figure.
- A hedge, degree word or condition from the quoted span that the insight lost ("probably", "might", "seems", "very", "if", "I think", "about 40"): put it back in the statement, in the speaker's own terms. If the guess is the speaker's own, attribute it ("<speaker> estimated…").
- A quote that is not word-for-word in the chunk: replace it with ONE contiguous span copied exactly from the chunk (no ellipses) that carries the claim and its hedges, or null.

If the chunk does not support a faithful version, drop the insight (omit it). Keep every other field as it was unless a fix requires changing it.

Return STRICT JSON only: {"insights":[...]} where each element is a FLAT insight object with the same fields as the one you were given (statement, context_note, direct_quote, speaker, ...), NOT wrapped in {"n":..,"insight":..}. Include only the corrected insights.
`.trim()
