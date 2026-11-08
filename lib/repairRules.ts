/**
 * The wording rules for repairing a quarantined claim (Paul, 2026-11-08), kept in
 * their own module on purpose.
 *
 * Another window is rewriting the extraction rules in lib/extraction.ts. Repair
 * and extraction are the same discipline seen from two ends (say only what the
 * speaker said), so once that PR lands, adopt its final wording here: edit
 * REPAIR_RULES below and nothing else in the repair tool has to change. Nothing
 * outside this file knows what the rules say.
 */

import type { FidelityResult } from './extractionFidelity'

/** Paul's repair rules, numbered so a reviewer can cite "rule 3". */
export const REPAIR_RULES = `
1. Keep the speaker's exact hedges and degrees. "very high" stays "very high"; "probably", "may", "in some cases", "roughly", "I think" stay; an "if ... then" condition stays an "if ... then" condition. Never harden a hedge into a fact or soften a stated degree.
2. Keep scope and context with the claim. If the speaker limited it ("more common outside the US", "in the speaker's own patients", "after age 50", "in athletes", "in mice"), the limit stays inside the sentence. A claim without its scope is a different claim.
3. Attribute guesses, anecdotes and audience estimates to the speaker, or drop them. "I've seen three patients do this" becomes "The speaker described three patients who ..."; "most of you probably ..." is not a finding and is dropped.
4. Never complete a half-said sentence. Never add a textbook definition, a mechanism, a location, a name, a dose or a number the speaker only gestured at or did not say, even when you are sure it is true. Being true does not excuse it.
5. Do not extend a finding about one drug, food, test or intervention to its class, or from a class to one member.
6. Say only what this passage supports. Anything in the CLAIM that the passage does not support has to go; do not replace it with something you know.
7. Make the smallest edit that makes the claim faithful. Keep the claim's meaning, its topic and as much of its wording as the passage supports. One self-contained sentence, two at most.
8. If the statement depends on something only visible on screen (a slide, chart, image, demonstration, "as you can see here", "this graph", "that one on the left"), do not guess what was shown: answer needs_video.
9. If the passage does not support any version of the claim, or the claim hangs on something this passage never defines, answer cannot_repair and say why.
10. Name the speaker only if the passage itself does. Otherwise write "the speaker".
`.trim()

export const REPAIR_SYSTEM = `
You repair one medical claim that an auditor found unfaithful to the transcript passage it came from. You are not checking medical correctness and you add no knowledge: the finished sentence may say only what the passage says.

The claim is shown to physicians as a fact the speaker made. A rewrite that sounds better but says more than the speaker said is a failure. A rewrite that is shorter and vaguer but faithful is a success.

RULES:
${REPAIR_RULES}

Return ONLY JSON, with no other text:
{"action":"rewrite|needs_video|cannot_repair","statement":"the repaired claim (empty unless action is rewrite)","changes":"one sentence naming what you removed, attributed or restored","reason":"one sentence, only for needs_video or cannot_repair"}
`.trim()

export type RepairAction = 'rewrite' | 'needs_video' | 'cannot_repair'

export type RewriteOutput = {
  action: RepairAction
  statement: string
  changes: string
  reason: string
}

export type RewriteRequest = {
  /** The transcript passage the claim has to be faithful to. */
  passage: string
  /** The claim's wording today. */
  claim: string
  /** The claim's context note, shown so the rewrite does not repeat it. */
  claimContextNote: string | null
  /** The member insight the auditor judged, and its notes. */
  insight: { statement: string; contextNote: string | null; directQuote: string | null }
  /** What the auditor said was wrong with it. */
  verdict: { verdict: string; offending: string; reasoning: string }
  /** Set on the second attempt: why the first rewrite did not pass. */
  priorRejection?: { statement: string; why: string } | null
}

export function buildRepairUser(req: RewriteRequest): string {
  const parts = [
    `TRANSCRIPT PASSAGE:\n${req.passage}`,
    `\nCLAIM TO REPAIR (what physicians currently see):\n${req.claim}`,
    req.claimContextNote ? `\nCLAIM CONTEXT NOTE (already shown beside the claim):\n${req.claimContextNote}` : '',
    `\nTHE EXTRACTED INSIGHT THE AUDITOR JUDGED:\n${req.insight.statement}`,
    req.insight.contextNote ? `\nITS CONTEXT NOTE:\n${req.insight.contextNote}` : '',
    req.insight.directQuote ? `\nQUOTE THE EXTRACTOR CITED:\n${req.insight.directQuote}` : '',
    `\nAUDITOR VERDICT: ${req.verdict.verdict}`,
    req.verdict.offending ? `PHRASE AT FAULT: ${req.verdict.offending}` : '',
    req.verdict.reasoning ? `REASON: ${req.verdict.reasoning}` : '',
  ]
  if (req.priorRejection) {
    parts.push(
      `\nYOUR PREVIOUS REWRITE WAS REJECTED:\n${req.priorRejection.statement}`,
      `WHY: ${req.priorRejection.why}`,
      'Fix that, and re-read the rules: every phrase has to trace to the passage.'
    )
  }
  return parts.filter(Boolean).join('\n')
}

const ACTIONS: RepairAction[] = ['rewrite', 'needs_video', 'cannot_repair']

/** Parse the model's JSON into a RewriteOutput. A reply that is not one of the three actions, or a
 *  rewrite with no statement, is `cannot_repair` with the reason spelled out, never a guess. */
export function parseRewrite(raw: { action?: unknown; statement?: unknown; changes?: unknown; reason?: unknown } | null | undefined): RewriteOutput {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const action = ACTIONS.includes(raw?.action as RepairAction) ? (raw!.action as RepairAction) : null
  const statement = str(raw?.statement)
  const changes = str(raw?.changes)
  const reason = str(raw?.reason)
  if (!action) return { action: 'cannot_repair', statement: '', changes, reason: 'the model did not return a recognised action' }
  if (action === 'rewrite' && !statement) return { action: 'cannot_repair', statement: '', changes, reason: 'the model returned a rewrite with no statement' }
  return { action, statement: action === 'rewrite' ? statement : '', changes, reason }
}

/** Why a rewrite that the judge re-read did not pass, as feedback for the second attempt. */
export function rejectionFeedback(r: FidelityResult): string {
  return `The auditor re-read it and said ${r.verdict}${r.offending ? ` — at fault: "${r.offending}"` : ''}${r.reasoning ? `. ${r.reasoning}` : ''}`
}
