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

/** Paul's wording rules for a repair, numbered so a reviewer can cite "rule 3". The "keep everything
 *  any member supports" rule (Paul, 2026-11-08) is KEEP_RULE below and does not live in this list. */
export const REPAIR_RULES = `
1. Keep the speaker's exact hedges and degrees. "very high" stays "very high"; "probably", "may", "in some cases", "roughly", "I think" stay; an "if ... then" condition stays an "if ... then" condition. Never harden a hedge into a fact or soften a stated degree.
2. Keep scope and context with the claim. If the speaker limited it ("more common outside the US", "in the speaker's own patients", "after age 50", "in athletes", "in mice"), the limit stays inside the sentence. A claim without its scope is a different claim.
3. Attribute guesses, anecdotes and audience estimates to the speaker, or drop them. "I've seen three patients do this" becomes "The speaker described three patients who ..."; "most of you probably ..." is not a finding and is dropped.
4. Never complete a half-said sentence. Never add a textbook definition, a mechanism, a location, a name, a dose or a number the speaker only gestured at or did not say, even when you are sure it is true. Being true does not excuse it.
5. Do not extend a finding about one drug, food, test or intervention to its class, or from a class to one member.
6. Say only what the passages support. Anything in the UNIT that no passage supports has to go; do not replace it with something you know.
7. Make the smallest edit that makes the unit faithful. Keep every supported fact and as much of the unit's wording as the passages support. Never merge, shorten or generalise supported content to make it easier to pass.
8. If the statement depends on something only visible on screen (a slide, chart, image, demonstration, "as you can see here", "this graph", "that one on the left"), do not guess what was shown: answer needs_video.
9. If no passage supports any version of the unit, or the unit hangs on something no passage defines, answer remove and say why in "removed".
10. Name the speaker only if a passage itself does. Otherwise write "the speaker".
`.trim()

/** Paul, 2026-11-08: the claim store must stay complete. A merged claim keeps everything ANY of its
 *  member insights supports; only what NO member insight supports may be removed or softened. */
export const KEEP_RULE = `
NOTHING THAT A SOURCE SUPPORTS IS LOST. The claim is a store of what speakers said, built from several insights. Keep every fact that ANY passage supports, in the unit's own words wherever possible. Remove or soften only what no passage supports. Never add content the unit did not state: restore hedges, scope and attribution, but do not pull extra detail from a passage into the unit. Never drop a number, a name, a mechanism, a population or a study the passages support.
`.trim()

export const UNIT_REPAIR_SYSTEM = `
You repair ONE fact (the UNIT) of a medical claim. An auditor found that the unit says more or less than the transcript passages say. You are not checking medical correctness and you add no knowledge: the finished unit may say only what the passages say.

${KEEP_RULE}

RULES:
${REPAIR_RULES}

The repaired unit stays ONE sentence about the same single fact. Every word of the unit must end up either in your statement or in "removed". For each fact you remove, give it in "removed" as a standalone sentence in the unit's own words and say in one clause why no passage supports it. A fact that a passage does support, even loosely, is not removed: it is kept, with its hedge or scope restored.

Return ONLY JSON, with no other text:
{"action":"rewrite|remove|needs_video","statement":"the repaired unit (empty unless action is rewrite)","removed":[{"fact":"...","reason":"..."}],"changes":"one sentence naming what you restored, attributed, softened or removed","reason":"one sentence, only for needs_video"}
`.trim()

export type UnitAction = 'rewrite' | 'remove' | 'needs_video'

export type RemovedFactClaim = { fact: string; reason: string }

export type UnitRewriteOutput = {
  action: UnitAction
  statement: string
  removed: RemovedFactClaim[]
  changes: string
  reason: string
}

export type UnitRewriteRequest = {
  /** The one fact to repair. */
  unit: string
  /** The whole claim, so the unit is read in context (never rewritten). */
  claim: string
  claimContextNote: string | null
  /** The transcript passages that may support the unit, most relevant first. */
  passages: string[]
  /** What the auditor said was wrong with the unit. */
  verdict: { verdict: string; offending: string; reasoning: string }
  /** Set on the second attempt: why the first attempt did not pass. */
  priorRejection?: { statement: string; why: string } | null
}

export function buildUnitUser(req: UnitRewriteRequest): string {
  const parts = [
    ...req.passages.map((p, i) => `TRANSCRIPT PASSAGE ${i + 1}:\n${p}`),
    `\nTHE WHOLE CLAIM (for context only; repair just the unit):\n${req.claim}`,
    req.claimContextNote ? `\nCLAIM CONTEXT NOTE (already shown beside the claim):\n${req.claimContextNote}` : '',
    `\nUNIT TO REPAIR:\n${req.unit}`,
    `\nAUDITOR VERDICT ON THE UNIT: ${req.verdict.verdict}`,
    req.verdict.offending ? `PHRASE AT FAULT: ${req.verdict.offending}` : '',
    req.verdict.reasoning ? `REASON: ${req.verdict.reasoning}` : '',
  ]
  if (req.priorRejection) {
    parts.push(
      `\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${req.priorRejection.statement || '(removed the unit)'}`,
      `WHY: ${req.priorRejection.why}`,
      'Fix that, and re-read the rules: keep everything a passage supports, and every phrase you keep has to trace to a passage.'
    )
  }
  return parts.filter(Boolean).join('\n')
}

const ACTIONS: UnitAction[] = ['rewrite', 'remove', 'needs_video']

/** Parse the model's JSON. A reply that is not one of the three actions, or a rewrite with no
 *  statement, or a removal that lists nothing, is returned as a `remove` with no removed facts so the
 *  caller rejects it with a reason: never a guess, never a silent deletion. */
export function parseUnitRewrite(raw: { action?: unknown; statement?: unknown; removed?: unknown; changes?: unknown; reason?: unknown } | null | undefined): UnitRewriteOutput {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const action = ACTIONS.includes(raw?.action as UnitAction) ? (raw!.action as UnitAction) : null
  const removed: RemovedFactClaim[] = Array.isArray(raw?.removed)
    ? (raw!.removed as unknown[])
        .map(r => (r && typeof r === 'object' ? { fact: str((r as Record<string, unknown>).fact), reason: str((r as Record<string, unknown>).reason) } : { fact: '', reason: '' }))
        .filter(r => r.fact)
    : []
  const changes = str(raw?.changes)
  const reason = str(raw?.reason)
  if (!action) return { action: 'remove', statement: '', removed: [], changes, reason: 'the model did not return a recognised action' }
  return { action, statement: action === 'rewrite' ? str(raw?.statement) : '', removed, changes, reason }
}

/** Why an attempt that the judge re-read did not pass, as feedback for the second attempt. */
export function rejectionFeedback(r: FidelityResult): string {
  return `The auditor re-read it and said ${r.verdict}${r.offending ? ` — at fault: "${r.offending}"` : ''}${r.reasoning ? `. ${r.reasoning}` : ''}`
}

// ── Splitting a merged claim into separate facts, then regrouping them ──────────

/** Paul, 2026-11-08: a merged claim that holds several distinct facts becomes several claims, so that
 *  no supported fact is lost to a rewrite. Stage 1 cuts the claim into facts; nothing is added or lost. */
export const DECOMPOSE_SYSTEM = `
You split a medical claim into its separate facts, word for word where you can. You add no knowledge and you drop nothing.

RULES:
1. One fact per item: one finding, one number, one mechanism, one study, one recommendation. Two assertions joined by "and", "but", a semicolon or a list become two items. A relation between two things ("A lowers B by doing C", "X rises, but Y falls") stays in one item when it is one assertion.
2. Each item is one complete sentence that can be read alone. Where the claim says "this", "it", "they", "these", "the latter" or "he", write the thing or person it stands for, taken from the claim.
3. Keep every hedge, degree, scope, condition, attribution, number and unit inside the item it belongs to. Use the claim's own words.
4. Add nothing: no definition, no mechanism, no number and no name that the claim does not contain. Drop nothing: every part of the claim must appear in some item.
5. Keep the claim's order.
6. Say each fact once. A sentence that only restates or sums up facts already listed ("which reflects...", "this suggests...", "in other words") is not a new fact: keep its conclusion inside the item it concludes, or list it only if it adds a distinct assertion.

Return ONLY JSON, with no other text: {"facts":["...","..."]}
`.trim()

export function buildDecomposeUser(claim: string, contextNote: string | null, priorGap?: string | null): string {
  return [
    `CLAIM:\n${claim}`,
    contextNote ? `\nCONTEXT NOTE (shown beside the claim; do not copy it in):\n${contextNote}` : '',
    priorGap ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${priorGap}\nFix that and keep everything else.` : '',
  ].filter(Boolean).join('\n')
}

export function parseDecompose(raw: { facts?: unknown } | null | undefined): string[] {
  if (!Array.isArray(raw?.facts)) return []
  return (raw!.facts as unknown[]).map(f => (typeof f === 'string' ? f.trim() : '')).filter(Boolean)
}

/** Stage 3 puts the surviving facts back into claims. It returns numbers only, so no wording changes here. */
export const GROUP_SYSTEM = `
You group numbered facts from one medical claim into separate claims. You do not rewrite anything: you only say which facts belong together.

RULES:
1. Facts belong together when they are one finding, one mechanism, one study or one story that a reader would want on one card. Independent findings go in separate groups.
2. Keep a group small (usually 1 to 4 facts). Never leave a fact out and never put a fact in two groups.
3. Prefer fewer groups when the facts are really one story; do not split a story only to make groups.

Return ONLY JSON, with no other text: {"groups":[[0,1],[2]]}  (each number is a fact's index, every index exactly once)
`.trim()

export function buildGroupUser(facts: string[]): string {
  return facts.map((f, i) => `${i}. ${f}`).join('\n')
}

/** Valid only when every index 0..n-1 appears exactly once; otherwise null (the caller keeps one group). */
export function parseGroups(raw: { groups?: unknown } | null | undefined, n: number): number[][] | null {
  if (!Array.isArray(raw?.groups)) return null
  const groups = (raw!.groups as unknown[]).map(g => (Array.isArray(g) ? g.filter((x): x is number => Number.isInteger(x)) : []))
  const seen = new Set<number>()
  for (const g of groups) for (const i of g) { if (i < 0 || i >= n || seen.has(i)) return null; seen.add(i) }
  if (seen.size !== n) return null
  return groups.filter(g => g.length > 0).map(g => [...g].sort((a, b) => a - b))
}
