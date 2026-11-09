/**
 * Extraction instructions, "exhaustive" variant (plan fix A; DRAFT 2026-11-08, experiment only).
 *
 * Built from the v2 prompt so every fidelity rule is byte-identical; only the selectivity changes. The v2
 * prompt tells the model to prefer fewer insights and to extract only "ideas that belong in careful show
 * notes"; each pass then chooses a different few, which is the largest measured cause of two passes over
 * the same transcript disagreeing (docs/plans/extraction-reproducibility.md sections 0 and 2).
 *
 * This variant removes the choice: list every distinct substantive claim, one insight per claim, in the
 * order spoken. The deterministic gate and the repair round (lib/extractionGate.ts) stay on, and the
 * fidelity judge remains the safety net, so recall is not bought with invention.
 *
 * Used only by scripts/evalReproducibility.ts. Not wired into extractionConfig() yet.
 */

import { EXTRACTION_SYSTEM_PROMPT_V2 } from './extractionPromptV2'

/**
 * DRAFT until the plan session relays Paul's answer on anecdotes (hub row la-2026-11-08-reproducibility-bar-call).
 * The harness refuses `--prompt exhaustive` while this is DRAFT unless `--allow-draft` is passed.
 */
export const EXHAUSTIVE_PROMPT_STATUS: 'DRAFT' | 'FINAL' = 'DRAFT'

function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`exhaustive prompt: the v2 prompt no longer contains: ${from.slice(0, 60)}…`)
  return text.replace(from, () => to)
}

let p = EXTRACTION_SYSTEM_PROMPT_V2

p = swap(
  p,
  `Extract only ideas that belong in careful show notes or an educational article. Prefer FEWER, FAITHFUL insights over many loose ones. Keep each insight`,
  `Extract EVERY distinct substantive claim the speakers make in the text, one insight per claim, in the order spoken. Completeness matters more than brevity. Never skip a claim because it seems minor, conversational, obvious or repeated: a later step ranks, merges and discards; you do not. Keep each insight`
)

p = swap(
  p,
  /WHAT TO EXTRACT\n[\s\S]*?\n\nWHAT NOT TO EXTRACT\n[\s\S]*?\n\nNUMERIC AND QUALIFIER DETAIL/.exec(p)![0],
  `WHAT TO EXTRACT
Every distinct claim any speaker (host or guest) makes about how something works, what is true, what to do, what happened, or what they believe: mechanisms, protocols, thresholds, trade-offs, warnings, definitions the speaker gives, examples (foods, exercises, protocols, named studies), figures, comparisons, opinions and predictions (attributed under rule 4), and the reasoning the speaker gives for a point. One insight per claim: if a sentence makes two separable claims, return two insights. A claim restated later with new detail is a new insight. Each insight must stand alone without "earlier we discussed" or "as you said".

Personal stories and examples from a speaker's own life are extracted too, as a report of what the speaker did, saw or experienced, never as advice or as a general fact (rule 4 still applies). Set "insight_type" to "Anecdote" for these.

WHAT NOT TO EXTRACT
Greetings, introductions and sign-offs; show logistics ("on this show we talk about…", "after the break"); advertisements and sponsor reads. Nothing else is skipped: a claim that seems small, obvious, conversational or repeated is still extracted.

NUMERIC AND QUALIFIER DETAIL`
)

// Anecdotes (Paul, 2026-11-08): the paragraph above matches the v2 prompt's anecdote wording and the plan (section 4b); the
// rows are held outside the corpus by raw_insights.corpus_excluded (migration 040). EXHAUSTIVE_PROMPT_STATUS stays DRAFT
// until the plan session finalises the whole prompt.

export const EXTRACTION_SYSTEM_PROMPT_EXHAUSTIVE = p.trim()

/** Appended when a chunk arrives with context blocks (plan fix B1, appendix C). */
export const CONTEXT_ADDENDUM = `

CONTEXT BLOCKS
The text arrives in three marked blocks. TEXT TO ANALYZE is what you extract from: extract every fact whose supporting words lie at least partly there. CONTEXT BEFORE and CONTEXT AFTER are the neighbouring words, given only so you can understand the text and complete a sentence that runs across the boundary. Never extract a fact that lies entirely inside a context block: the neighbouring chunk owns it. The fidelity rules apply to the three blocks read as one passage, so a fact supported by a sentence that runs across a boundary is fully supported. The direct_quote may run from TEXT TO ANALYZE into a context block, but must still be ONE contiguous span copied exactly.`

export const CONTEXT_HEADERS = {
  before: 'CONTEXT BEFORE (for understanding only; do not extract facts that lie entirely here):',
  text: 'TEXT TO ANALYZE (extract every fact whose supporting words lie at least partly here):',
  after: 'CONTEXT AFTER (for understanding only; do not extract facts that lie entirely here):',
}
