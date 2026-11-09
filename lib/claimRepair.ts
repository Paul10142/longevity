/**
 * Repair a quarantined claim in place (Paul, 2026-11-08) without losing information.
 *
 * The extraction-fidelity judge hides a claim (claims.status = 'flagged', see lib/claimGate.ts)
 * when its seed insight says more or less than the ONE transcript passage it came from. A merged
 * claim, though, is built from many insights and many passages, so repairing it from the seed
 * passage alone deleted true content (the 20-claim dry run of 2026-11-08: six of nine merged claims
 * lost 30% or more). Paul's rule: a merged claim keeps everything ANY member insight supports;
 * only what NO member supports may be removed or softened. This module is pure apart from the two
 * model calls, which arrive as `deps`; the DB reads and writes live in scripts/repairFlaggedClaims.ts.
 *
 * How one claim is repaired:
 *   0. SPLIT (Paul, 2026-11-08: a merged claim with several distinct facts becomes several claims).
 *      Opus cuts the claim into separate self-contained facts; a coverage audit checks that every
 *      number and 90% of the wording is still there and nothing new was added (else one retry, then the
 *      claim is cut at sentences instead). The surviving facts are regrouped into claims by index only
 *      (no rewording) and each member insight goes to the group it matches best (see assignMembers).
 *   1. The units are those facts (or, as a fallback, the claim's sentences: splitUnits is lossless).
 *   2. Judge every unit against the passages of ALL member insights, most relevant first (the same
 *      judge that flagged it, lib/extractionFidelity.ts). FAITHFUL against any group = supported =
 *      kept verbatim, never touched again.
 *   3. A unit no passage group supports is repaired by Opus 5.5 (lib/repairRules.ts) with the
 *      smallest edit: restore a dropped hedge, attribute a guess, remove only an unsupported fact.
 *      The edit must pass the judge, and every fact it removes is searched for in ALL passages: if
 *      any passage supports it, the removal is rejected and the model is told where it is.
 *   4. The surviving facts are grouped into claims. A number that a passage and the old claim both had must
 *      survive. The result carries a ledger (kept / edited / removed, with reasons) for the report.
 * A claim whose units all pass untouched is `canonical_ok` (a false alarm). A unit that cannot be
 * repaired in two tries, a claim that depends on the screen (`needs_video`), a claim with nothing
 * supported (`cannot_repair`) or a model refusal leaves the claim hidden for Paul, with a note.
 */

import { fidelityCheck, numericSpecifics, droppedSpecifics } from './enrichMerge'
import type { FidelityResult } from './extractionFidelity'
import { isRealFidelity } from './extractionFidelity'
import { rejectionFeedback, type UnitRewriteOutput, type UnitRewriteRequest, type RemovedFactClaim } from './repairRules'

// ── Types ───────────────────────────────────────────────────────

export type MemberPassage = {
  rawInsightId: string
  matchedBy: string
  statement: string
  contextNote: string | null
  directQuote: string | null
  /** The transcript chunk the insight was extracted from. */
  chunk: string
}

export type FlagFacts = { verdict: string; offending: string; reasoning: string }

export type RepairInput = {
  claimId: string
  claim: string
  claimContextNote: string | null
  flag: FlagFacts
  members: MemberPassage[]
}

export type RepairDeps = {
  judge: (statement: string, chunk: string, opts: { contextNote: string | null; directQuote: string | null }) => Promise<FidelityResult>
  rewrite: (req: UnitRewriteRequest) => Promise<UnitRewriteOutput>
  /** Cut a claim into separate self-contained facts. Absent: the claim is cut at sentences. */
  decompose?: (claim: string, contextNote: string | null, priorGap: string | null) => Promise<string[]>
  /** Group fact indexes into claims (null = keep one claim). Absent: one claim. */
  group?: (facts: string[]) => Promise<number[][] | null>
}

export type RepairOutcome =
  | 'repaired'      // every unit is now supported; the claim goes back to active
  | 'canonical_ok'  // every unit was already supported by some member's passage: a false alarm
  | 'failed'        // a unit could not be repaired in two tries, or information would be lost; stays hidden
  | 'needs_video'   // depends on the screen; stays hidden
  | 'cannot_repair' // no passage supports any part of the claim, or there is no passage; stays hidden
  | 'refused'       // the model's safety filter declined; stays hidden
  | 'error'         // a transport failure, no verdict: nothing recorded, tried again next run

export type RepairSource = 'member' | 'rewrite' | 'unchanged'

export type Attempt = {
  kind: 'unit_check' | 'unit_edit' | 'removal_check' | 'decompose' | 'group'
  /** Which unit (0-based) this belongs to. */
  unit: number
  statement: string
  /** Passage numbers (0-based, in the claim's own passage list) the judge was shown. */
  passages?: number[]
  judge?: FidelityResult
  /** A deterministic rejection before the judge ran (invented number, unaccounted words, ...). */
  guard?: string
  changes?: string
}

export type LedgerStatus = 'kept' | 'edited' | 'removed' | 'unresolved'

export type RemovedFact = RemovedFactClaim & { searchedPassages: number }

/** What happened to one unit of the claim: the audit trail Paul reads. */
export type UnitLedger = {
  index: number
  before: string
  /** '' when the unit was removed. */
  after: string
  status: LedgerStatus
  /** The auditor's verdict on the unit, from the best passage group (FAITHFUL when kept). */
  verdict: string
  offending: string
  reasoning: string
  /** Passage numbers that supported the unit (kept units). */
  supportedBy: number[]
  passagesSearched: number
  changes: string
  removed: RemovedFact[]
  /** Which resulting claim (0 = keeps the original claim's id) holds this unit; null if removed or unresolved. */
  group: number | null
}

/** One claim after the split. Claim 0 keeps the original claim's id; the others are new claims. */
export type SplitClaim = {
  statement: string
  /** Units (indexes into `ledger`) whose text is in this claim. */
  units: number[]
  /** Member insights that now belong to this claim (each insight is in exactly one claim: claim_members.raw_insight_id is unique). */
  memberRawInsightIds: string[]
}

/** A member insight whose statement also matches another resulting claim (it could back both if the schema allowed). */
export type AlsoBacks = { rawInsightId: string; groups: number[] }

export type RepairResult = {
  outcome: RepairOutcome
  source: RepairSource | null
  /** The wording the claim should carry; set for `repaired` only. */
  newStatement: string | null
  memberRawInsightId: string | null
  /** Numbers the passages and the old wording both had that the new wording lost. Must be empty to repair. */
  droppedNumbers: string[]
  note: string
  attempts: Attempt[]
  ledger: UnitLedger[]
  passageCount: number
  /** The claims the original becomes (1 when it stays one claim). Empty unless repaired. */
  claims: SplitClaim[]
  alsoBacks: AlsoBacks[]
  /** 'facts' when the model's split passed the coverage audit, 'sentences' for the fallback. */
  cutAt: 'facts' | 'sentences'
  charsBefore: number
  /** Total characters across the resulting claims. */
  charsAfter: number
  /** Characters of unsupported content that was removed (the only content allowed to leave). */
  charsRemoved: number
}

/** Passages searched per judge call after the first, and the most calls per search. */
export const GROUP_SIZE = 3
export const FIRST_GROUP_SIZE = 2
export const MAX_SEARCH_CALLS = 6
/** "A unit that fails twice stays hidden for Paul's review." */
export const MAX_REWRITES = 2
/** Passages shown to the repair model with a unit. */
export const MAX_REWRITE_PASSAGES = 4
/** Share of a unit's content words that must reappear in the new unit or in its removed facts. */
export const MIN_ACCOUNTED = 0.8
/** A sentence longer than this also splits at semicolons. */
export const LONG_UNIT_CHARS = 380
const MAX_REMOVED_CHECKS = 8
/** A removed fact counts as restated (corrected, not lost) when this share of its wording is in the new unit. */
export const RESTATED_SHARE = 0.7

// ── Small pure helpers ──────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()

const tokens = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 2))
const contentWords = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 3))
/** First five letters: "lowers" and "lower" are the same word for accounting purposes. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w)

/** Word overlap, 0-1. Used only to order candidates, never to decide a verdict. */
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / (A.size + B.size - hit)
}

export const sameText = (a: string, b: string) => norm(a) === norm(b)

// ── Units ───────────────────────────────────────────────────────

export type Unit = { text: string; sep: string }

const ABBREVIATION = /(?:\be\.g|\bi\.e|\bvs|\bapprox|\bca|\bcf|\bdr|\bmr|\bmrs|\bms|\bfig|\bet al|\bno|\bst|\bu\.s|\betc|\b[A-Z])\.$/i

/**
 * Split a claim into units, losslessly: units.map(u => u.text + u.sep).join('') === claim.trim().
 * A unit is a sentence; a sentence over LONG_UNIT_CHARS also splits at semicolons, so one unsupported
 * clause does not drag a whole paragraph-length sentence into a rewrite.
 */
export function splitUnits(claim: string): Unit[] {
  const text = claim.trim()
  if (!text) return []
  const cut = (s: string, re: RegExp, skipAbbrev: boolean): Unit[] => {
    const out: Unit[] = []
    let start = 0
    for (const m of s.matchAll(re)) {
      const end = m.index! + m[1].length
      if (skipAbbrev && ABBREVIATION.test(s.slice(start, end))) continue
      out.push({ text: s.slice(start, end), sep: m[2] })
      start = end + m[2].length
    }
    out.push({ text: s.slice(start), sep: '' })
    return out.filter(u => u.text.length > 0)
  }
  const sentences = cut(text, /([.!?]["')\]]*)(\s+)(?=[A-Z0-9"'([])/g, true)
  const out: Unit[] = []
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]
    if (s.text.length <= LONG_UNIT_CHARS) { out.push(s); continue }
    const parts = cut(s.text, /(;)(\s+)/g, false)
    parts[parts.length - 1].sep = s.sep
    out.push(...parts)
  }
  return out
}

export const joinUnits = (units: Array<{ text: string; sep: string }>) => units.map(u => u.text + u.sep).join('')

// ── Passages ────────────────────────────────────────────────────

export type Passage = { index: number; text: string; members: MemberPassage[] }

/** The distinct transcript chunks behind a claim's members (members that share a chunk share a passage). */
export function passagesOf(members: MemberPassage[]): Passage[] {
  const byText = new Map<string, Passage>()
  for (const m of [...members].sort((a, b) => a.rawInsightId.localeCompare(b.rawInsightId))) {
    const key = m.chunk.trim()
    if (!key) continue
    const p = byText.get(key)
    if (p) p.members.push(m)
    else byText.set(key, { index: byText.size, text: m.chunk, members: [m] })
  }
  return [...byText.values()]
}

/** Passages most relevant to a piece of text first: how much of its wording the passage contains, and
 *  how close the insights extracted from it are. Orders the search only; never decides a verdict. */
export function rankPassages(text: string, passages: Passage[]): Passage[] {
  const U = contentWords(text)
  const score = (p: Passage) => {
    const C = tokens(p.text)
    let hit = 0
    for (const w of U) if (C.has(w)) hit++
    const contained = U.size ? hit / U.size : 0
    const near = Math.max(0, ...p.members.map(m => similarity(text, m.statement)))
    return 0.6 * contained + 0.4 * near
  }
  return passages
    .map(p => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.p.index - b.p.index)
    .map(x => x.p)
}

const PASSAGE_BREAK = '\n\n--- NEXT PASSAGE ---\n\n'
const joinPassages = (ps: Passage[]) => ps.map(p => p.text).join(PASSAGE_BREAK)

/** Groups of passages for one search: the two most relevant first, then threes; at most MAX_SEARCH_CALLS. */
export function searchGroups(ranked: Passage[]): Passage[][] {
  const groups: Passage[][] = []
  let i = 0
  while (i < ranked.length && groups.length < MAX_SEARCH_CALLS) {
    const size = groups.length === 0 ? FIRST_GROUP_SIZE : GROUP_SIZE
    groups.push(ranked.slice(i, i + size))
    i += size
  }
  return groups
}

// ── Checks on model-written text ────────────────────────────────

/** Numbers the old wording and the passages both carried that the new wording no longer has. */
export function lostNumbers(oldWording: string, passages: string, newWording: string): string[] {
  const inPassage = new Set(numericSpecifics(passages))
  return droppedSpecifics(newWording, [oldWording]).filter(n => inPassage.has(n))
}

/** Share of a unit's content words found in the new unit or in the facts removed from it. */
export function accountedShare(unit: string, kept: string, removed: string[]): number {
  const U = [...contentWords(unit)].map(stem)
  if (U.length === 0) return 1
  const have = new Set([...contentWords(`${kept} ${removed.join(' ')}`)].map(stem))
  return U.filter(w => have.has(w)).length / U.length
}

/** Deterministic checks on a model-written unit, before spending a judge call on it. */
export function guardUnitEdit(out: UnitRewriteOutput, unit: string, grounding: string[]): string | null {
  if (out.action === 'rewrite') {
    if (!out.statement) return 'the rewrite was empty'
    if (sameText(out.statement, unit)) return 'the rewrite is the same wording as the unit that was flagged'
    const { ok, invented } = fidelityCheck(out.statement, grounding)
    if (!ok) return `the rewrite states ${invented.join(', ')}, which the passages never say`
  }
  if (out.action === 'remove' && out.removed.length === 0) return 'the unit was removed without listing what was removed'
  const share = accountedShare(unit, out.statement, out.removed.map(r => r.fact))
  if (share < MIN_ACCOUNTED) {
    return `only ${Math.round(share * 100)}% of the unit's wording is either kept or listed under "removed"; every dropped fact has to be listed`
  }
  return null
}

// ── Cutting a claim into facts, and sending members to the claim they match ──────

const FACT_COVERAGE = 0.9

/** Why a model's list of facts is not a faithful cut of the claim, or null. Every number and 90% of the
 *  wording must survive, and no number may appear that the claim does not have. */
export function coverageGap(claim: string, facts: string[]): string | null {
  if (facts.length === 0) return 'no facts were returned'
  if (facts.length > 60) return 'more than 60 facts were returned'
  const joined = facts.join(' ')
  const lost = droppedSpecifics(joined, [claim])
  if (lost.length) return `the facts lose ${lost.join(', ')} from the claim`
  const { ok, invented } = fidelityCheck(joined, [claim])
  if (!ok) return `the facts state ${invented.join(', ')}, which the claim never says`
  const share = accountedShare(claim, joined, [])
  if (share < FACT_COVERAGE) return `only ${Math.round(share * 100)}% of the claim's wording is in the facts; every part of the claim must appear in some fact`
  return null
}

const containment = (member: string, group: string): number => {
  const M = [...contentWords(member)].map(stem)
  if (M.length === 0) return 0
  const G = new Set([...contentWords(group)].map(stem))
  return M.filter(w => G.has(w)).length / M.length
}
/** How well a member insight's statement fits a group's text, 0-1. Used to place members only. */
export const memberFit = (member: string, group: string) => 0.5 * similarity(member, group) + 0.5 * containment(member, group)

export type MemberAssignment = {
  /** Merged groups, each a list of the input group indexes now sharing one claim (usually one). */
  merged: number[][]
  /** For each member (input order), the merged group that owns it. */
  owner: number[]
  /** For each member, the other merged groups it also fits (>= 60% of its best fit and >= 0.2). */
  also: number[][]
}

/**
 * Give every member insight to exactly one group (claim_members.raw_insight_id is unique), the one its
 * statement fits best. A group nobody fits best takes the member that fits it most from a group that has
 * two or more; when no member can be spared the group is merged into the group most like it, so no
 * resulting claim is left without a member insight (a claim with no members is retired by the pipeline).
 */
export function assignMembers(texts: string[], members: MemberPassage[]): MemberAssignment {
  let merged: number[][] = texts.map((_, i) => [i])
  if (members.length === 0 || texts.length <= 1) {
    return { merged: [texts.map((_, i) => i)], owner: members.map(() => 0), also: members.map(() => []) }
  }
  const textOf = (g: number[]) => g.map(i => texts[i]).join(' ')
  for (let guard = 0; guard < texts.length * 3 + 5; guard++) {
    const gt = merged.map(textOf)
    const fit = members.map(m => gt.map(t => memberFit(m.statement, t)))
    const owner = fit.map(row => row.indexOf(Math.max(...row)))
    const counts = merged.map((_, g) => owner.filter(o => o === g).length)
    const empty = counts.findIndex(c => c === 0)
    if (empty === -1) {
      const also = fit.map((row, m) => row.map((f, g) => (g !== owner[m] && f >= 0.2 && f >= 0.6 * row[owner[m]] ? g : -1)).filter(g => g >= 0))
      return { merged, owner, also }
    }
    const donors = members.map((_, m) => m).filter(m => counts[owner[m]] >= 2)
    if (donors.length > 0) {
      const best = donors.sort((a, b) => fit[b][empty] - fit[a][empty])[0]
      // force the move by making the empty group win for that member next round: pin it via a merge-free override
      return finishWithOverride(merged, members, fit, owner, empty, best)
    }
    // Nobody can be spared: fold the empty group into the group most like it.
    let target = -1, top = -1
    merged.forEach((g, gi) => { if (gi !== empty) { const sim = similarity(gt[empty], gt[gi]); if (sim > top) { top = sim; target = gi } } })
    merged[target] = [...merged[target], ...merged[empty]].sort((a, b) => a - b)
    merged = merged.filter((_, gi) => gi !== empty)
  }
  return { merged: [texts.map((_, i) => i)], owner: members.map(() => 0), also: members.map(() => []) }
}

/** Move one member into an empty group, then keep moving until no group is empty (rare: several empty groups). */
function finishWithOverride(merged: number[][], members: MemberPassage[], fit: number[][], owner0: number[], firstEmpty: number, firstMember: number): MemberAssignment {
  const owner = [...owner0]
  owner[firstMember] = firstEmpty
  for (let guard = 0; guard < merged.length * 3; guard++) {
    const counts = merged.map((_, g) => owner.filter(o => o === g).length)
    const empty = counts.findIndex(c => c === 0)
    if (empty === -1) break
    const donors = members.map((_, m) => m).filter(m => counts[owner[m]] >= 2)
    if (donors.length === 0) break
    owner[donors.sort((a, b) => fit[b][empty] - fit[a][empty])[0]] = empty
  }
  const counts = merged.map((_, g) => owner.filter(o => o === g).length)
  if (counts.some(c => c === 0)) {
    // not enough members for these groups: one claim
    return { merged: [merged.flat().sort((a, b) => a - b)], owner: members.map(() => 0), also: members.map(() => []) }
  }
  const also = fit.map((row, m) => row.map((f, g) => (g !== owner[m] && f >= 0.2 && f >= 0.6 * row[owner[m]] ? g : -1)).filter(g => g >= 0))
  return { merged, owner, also }
}

// ── Ordering the work ───────────────────────────────────────────

/** 0 = carries a number or dose, 1 = cause-and-effect language, 2 = everything else. */
export type StakesTier = 0 | 1 | 2

const NUMBER_WORDS = /\b(?:(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b[\s-]*(?:percent|per\s?cent|mg|milligrams?|grams?|mcg|micrograms?|units?|iu|minutes?|hours?|days?|weeks?|months?|years?|times|fold|x)|(?:percent|per\s?cent|twice|double|triple|half|tenfold))\b/i
const CAUSAL = /\b(?:causes?|caused|causing|leads?\s+to|led\s+to|results?\s+in|resulting\s+in|because|due\s+to|prevents?|prevented|reduces?|reduced|lowers?|lowered|raises?|raised|increases?|increased|decreases?|decreased|improves?|improved|worsens?|triggers?|drives?|driven|protects?\s+against|effects?\s+(?:of|on)|induces?|promotes?|mediates?|accelerates?|slows?|boosts?|suppresses?|impairs?)\b/i

/** How much a wrong word here could hurt: a wrong dose first, then a wrong cause. Looks at the
 *  claim and at the phrase the judge faulted. */
export function stakesTier(claim: string, offending = ''): StakesTier {
  const text = `${claim} ${offending}`
  if (numericSpecifics(text).length > 0 || NUMBER_WORDS.test(text)) return 0
  if (CAUSAL.test(text)) return 1
  return 2
}

export type Candidate = {
  claimId: string
  claim: string
  verdict: string
  offending: string
  memberCount: number
  createdAt: string
}

/** High stakes first; ties by creation time then id, so a resumed run sees the same order. */
export function orderCandidates<T extends Candidate>(cands: T[]): T[] {
  return cands
    .map(c => ({ c, t: stakesTier(c.claim, c.offending) }))
    .sort((a, b) => a.t - b.t || a.c.createdAt.localeCompare(b.c.createdAt) || a.c.claimId.localeCompare(b.c.claimId))
    .map(x => x.c)
}

/**
 * The first `limit` claims, round-robin across verdict x (one member | several members), each
 * group in stakes order. Used for the dry run so a sample of 20 shows every verdict type and the
 * several-insight path rather than whichever kind sorts first. `orderCandidates` already ran.
 */
export function stratifiedSample<T extends Candidate>(ordered: T[], limit: number): T[] {
  if (limit <= 0 || ordered.length <= limit) return ordered.slice(0, Math.max(0, limit))
  const key = (c: T) => `${c.verdict}|${c.memberCount > 1 ? 'multi' : 'single'}`
  const groups = new Map<string, T[]>()
  for (const c of ordered) groups.set(key(c), [...(groups.get(key(c)) ?? []), c])
  const queues = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v)
  const out: T[] = []
  for (let round = 0; out.length < limit; round++) {
    let took = false
    for (const q of queues) {
      if (round < q.length && out.length < limit) { out.push(q[round]); took = true }
    }
    if (!took) break
  }
  return out
}

// ── The repair of one claim ─────────────────────────────────────

const isModelRefusal = (err: unknown) => err instanceof Error && err.name === 'ModelRefusalError'

const SUPPORT_VERDICTS = new Set(['FAITHFUL', 'DROPPED_QUALIFIER', 'UNSURE'])
/** What to show the repair model first: the group that shows the unit's support (a dropped qualifier means
 *  the fact IS there), then an invented detail, then the rest. */
const VERDICT_PRIORITY: Record<string, number> = { DROPPED_QUALIFIER: 0, ADDED_DETAIL: 1, UNRESOLVED_REFERENCE: 2, UNSURE: 3 }

type Searched = {
  faithful: boolean
  supportedBy: number[]
  /** The verdict to repair from: the strongest non-FAITHFUL one. */
  best: FidelityResult
  bestGroup: Passage[]
  searched: number
  searchedAll: boolean
  error: FidelityResult | null
}

/** Judge a statement against the passages in groups, most relevant first, until one supports it. */
async function searchSupport(
  statement: string, ranked: Passage[], unit: number, contextNote: string | null,
  accept: (v: FidelityResult) => boolean, deps: RepairDeps, attempts: Attempt[], kind: Attempt['kind']
): Promise<Searched> {
  const groups = searchGroups(ranked)
  let best: FidelityResult = { verdict: 'UNSURE', offending: '', reasoning: 'no passage to check against' }
  let bestGroup: Passage[] = ranked.slice(0, FIRST_GROUP_SIZE)
  let searched = 0
  for (const g of groups) {
    const j = await deps.judge(statement, joinPassages(g), { contextNote, directQuote: null })
    attempts.push({ kind, unit, statement, passages: g.map(p => p.index), judge: j })
    searched += g.length
    if (!isRealFidelity(j)) return { faithful: false, supportedBy: [], best: j, bestGroup: g, searched, searchedAll: false, error: j }
    if (accept(j)) return { faithful: true, supportedBy: g.map(p => p.index), best: j, bestGroup: g, searched, searchedAll: searched >= ranked.length, error: null }
    const rank = (v: FidelityResult) => VERDICT_PRIORITY[v.verdict] ?? 9
    if (best.reasoning === 'no passage to check against' || rank(j) < rank(best)) { best = j; bestGroup = g }
  }
  return { faithful: false, supportedBy: [], best, bestGroup, searched, searchedAll: searched >= ranked.length, error: null }
}

const empty = (outcome: RepairOutcome, note: string, attempts: Attempt[] = [], ledger: UnitLedger[] = [], passageCount = 0): RepairResult => ({
  outcome, source: null, newStatement: null, memberRawInsightId: null, droppedNumbers: [], note, attempts, ledger, passageCount,
  claims: [], alsoBacks: [], cutAt: 'sentences', charsBefore: 0, charsAfter: 0, charsRemoved: 0,
})

/** Run the steps in the file header for one claim. Throws only what must stop the whole run (a usage
 *  limit, a halted CLI); a refusal or a bad reply becomes an outcome on this claim. */
export async function repairClaim(input: RepairInput, deps: RepairDeps): Promise<RepairResult> {
  const passages = passagesOf(input.members)
  if (passages.length === 0) return empty('cannot_repair', 'no member has a transcript passage to check against')
  const attempts: Attempt[] = []
  // 0. Cut the claim into separate facts (or, failing that, sentences).
  const cut = await cutIntoUnits(input, deps, attempts)
  if (cut.refused) return empty('refused', cut.refused, attempts, [], passages.length)
  const units = cut.units
  const fail = (...a: Parameters<typeof empty>): RepairResult => ({ ...empty(...a), cutAt: cut.cutAt })
  if (units.length === 0) return fail('cannot_repair', 'the claim has no text', attempts, [], passages.length)
  const allText = passages.map(p => p.text).join('\n')
  const ledger: UnitLedger[] = []
  const finals: Array<{ text: string; unit: number }> = []

  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const ranked = rankPassages(u.text, passages)
    // 2. Is the unit supported by ANY member's passage?
    const found = await searchSupport(u.text, ranked, i, input.claimContextNote, v => v.verdict === 'FAITHFUL', deps, attempts, 'unit_check')
    if (found.error) return fail('error', `judge failed: ${found.error.reasoning}`, attempts, ledger, passages.length)
    if (found.faithful) {
      ledger.push({ index: i, before: u.text, after: u.text, status: 'kept', verdict: 'FAITHFUL', offending: '', reasoning: found.best.reasoning, supportedBy: found.supportedBy, passagesSearched: found.searched, changes: '', removed: [], group: null })
      finals.push({ text: u.text, unit: i })
      continue
    }

    // 3. The smallest edit, from the passages that bear on the unit.
    const shown = [...new Map([...found.bestGroup, ...ranked].map(p => [p.index, p])).values()].slice(0, MAX_REWRITE_PASSAGES)
    let prior: { statement: string; why: string } | null = null
    let done: { after: string; status: 'edited' | 'removed'; changes: string; removed: RemovedFact[] } | null = null
    let lastWhy = ''
    for (let n = 1; n <= MAX_REWRITES && !done; n++) {
      let out: UnitRewriteOutput
      try {
        out = await deps.rewrite({
          unit: u.text, claim: input.claim, claimContextNote: input.claimContextNote, passages: shown.map(p => p.text),
          verdict: { verdict: found.best.verdict, offending: found.best.offending, reasoning: found.best.reasoning }, priorRejection: prior,
        })
      } catch (err) {
        if (isModelRefusal(err)) return fail('refused', err instanceof Error ? err.message : 'refused', attempts, ledger, passages.length)
        throw err
      }
      if (out.action === 'needs_video') return fail('needs_video', out.reason || 'depends on something shown on screen', attempts, ledger, passages.length)

      const reject = (why: string) => {
        attempts.push({ kind: 'unit_edit', unit: i, statement: out.statement, guard: why, changes: out.changes })
        prior = { statement: out.statement, why }
        lastWhy = why
      }
      const guard = guardUnitEdit(out, u.text, shown.map(p => p.text))
      if (guard) { reject(guard); continue }

      if (out.action === 'rewrite') {
        const j = await deps.judge(out.statement, joinPassages(shown), { contextNote: input.claimContextNote, directQuote: null })
        attempts.push({ kind: 'unit_edit', unit: i, statement: out.statement, passages: shown.map(p => p.index), judge: j, changes: out.changes })
        if (!isRealFidelity(j)) return fail('error', `judge failed: ${j.reasoning}`, attempts, ledger, passages.length)
        if (j.verdict !== 'FAITHFUL') { prior = { statement: out.statement, why: rejectionFeedback(j) }; lastWhy = prior.why; continue }
      }

      // Every removed fact must be unsupported by EVERY passage; one that a passage supports stays.
      const removed: RemovedFact[] = []
      let blocked: string | null = null
      for (const r of out.removed.slice(0, MAX_REMOVED_CHECKS)) {
        // A "removed" fact whose wording the new statement already carries was corrected, not lost (the old
        // claim stated it too loosely; the repaired fact states it as the passage does): nothing to search.
        if (out.action === 'rewrite' && accountedShare(r.fact, out.statement, []) >= RESTATED_SHARE) continue
        const rr = rankPassages(r.fact, passages)
        const s = await searchSupport(r.fact, rr, i, input.claimContextNote, v => SUPPORT_VERDICTS.has(v.verdict), deps, attempts, 'removal_check')
        if (s.error) return fail('error', `judge failed: ${s.error.reasoning}`, attempts, ledger, passages.length)
        if (s.faithful) {
          const at = passages.filter(p => s.supportedBy.includes(p.index)).map(p => p.text).join(PASSAGE_BREAK)
          blocked = `you removed "${r.fact}", but a passage supports it (${s.best.verdict === 'DROPPED_QUALIFIER' ? 'the fact is there, only a qualifier was missing' : 'it is stated there'}). Keep it. Passage: ${at.slice(0, 1500)}`
          break
        }
        if (!s.searchedAll) { blocked = `"${r.fact}" could not be searched in every passage (${s.searched} of ${rr.length} searched), so it cannot be proved unsupported`; break }
        removed.push({ ...r, searchedPassages: s.searched })
      }
      if (!blocked && out.removed.length > MAX_REMOVED_CHECKS) blocked = `more than ${MAX_REMOVED_CHECKS} facts removed from one sentence`
      if (blocked) { reject(blocked); continue }

      done = { after: out.action === 'rewrite' ? out.statement : '', status: out.action === 'rewrite' ? 'edited' : 'removed', changes: out.changes, removed }
    }

    if (!done) {
      ledger.push({ index: i, before: u.text, after: u.text, status: 'unresolved', verdict: found.best.verdict, offending: found.best.offending, reasoning: found.best.reasoning, supportedBy: [], passagesSearched: found.searched, changes: lastWhy, removed: [], group: null })
      return fail('failed', `sentence ${i + 1} of ${units.length} could not be repaired in ${MAX_REWRITES} tries without losing or inventing something (${lastWhy.slice(0, 160)}); left hidden for review`, attempts, ledger, passages.length)
    }
    ledger.push({ index: i, before: u.text, after: done.after, status: done.status, verdict: found.best.verdict, offending: found.best.offending, reasoning: found.best.reasoning, supportedBy: [], passagesSearched: found.searched, changes: done.changes, removed: done.removed, group: null })
    if (done.after) finals.push({ text: done.after, unit: i })
  }

  // 4. Group the surviving facts into claims, give every member insight to one of them, and check the whole.
  const edited = ledger.filter(l => l.status === 'edited').length
  const removedUnits = ledger.filter(l => l.status === 'removed').length
  const kept = ledger.filter(l => l.status === 'kept').length
  const removedFacts = ledger.reduce((n, l) => n + l.removed.length, 0)
  const charsBefore = input.claim.trim().length
  const charsRemoved = ledger.reduce((n, l) => n + l.removed.reduce((m, r) => m + r.fact.length, 0), 0)
  if (finals.length === 0) {
    return fail('cannot_repair', 'no part of the claim is supported by any member passage', attempts, ledger, passages.length)
  }

  let groups: number[][] = [finals.map((_, i) => i)]
  if (finals.length > 1 && deps.group) {
    try {
      const g = await deps.group(finals.map(f => f.text))
      attempts.push({ kind: 'group', unit: -1, statement: g ? g.map(x => `[${x.join(',')}]`).join(' ') : '(kept as one claim)' })
      if (g && g.length > 0) groups = g
    } catch (err) {
      if (!isModelRefusal(err)) throw err
    }
  }
  const groupTexts = groups.map(g => g.map(i => finals[i].text).join(' '))
  const assigned = assignMembers(groupTexts, input.members)
  // The claim that keeps the original id is the one with the most member insights; the rest keep claim order.
  const sizeOf = (mg: number) => assigned.owner.filter(o => o === mg).length
  const order = assigned.merged.map((_, i) => i).sort((a, b) => sizeOf(b) - sizeOf(a) || a - b)
  const claims: SplitClaim[] = order.map(mg => {
    const idx = assigned.merged[mg].flatMap(g => groups[g]).sort((a, b) => a - b)
    return {
      statement: idx.map(i => finals[i].text).join(' '),
      units: idx.map(i => finals[i].unit),
      memberRawInsightIds: input.members.filter((_, mi) => assigned.owner[mi] === mg).map(m => m.rawInsightId),
    }
  })
  claims.forEach((c, ci) => c.units.forEach(u => { ledger[u].group = ci }))
  const alsoBacks: AlsoBacks[] = input.members
    .map((m, mi) => ({ rawInsightId: m.rawInsightId, groups: assigned.also[mi].map(mg => order.indexOf(mg)) }))
    .filter(a => a.groups.length > 0)

  const unchanged = claims.length === 1 && edited === 0 && removedUnits === 0 && removedFacts === 0
  const common = { attempts, ledger, passageCount: passages.length, claims, alsoBacks, cutAt: cut.cutAt, charsBefore, charsRemoved }
  if (unchanged) {
    return { ...fail('canonical_ok', `all ${units.length} part${units.length === 1 ? '' : 's'} of the claim are supported by its members' passages; the flag was about the seed insight's own wording`, attempts, ledger, passages.length), ...common, claims: [], alsoBacks: [], charsAfter: charsBefore, source: 'unchanged' }
  }
  const newStatement = claims[0].statement
  const charsAfter = claims.reduce((n, c) => n + c.statement.length, 0)
  const droppedNumbers = lostNumbers(input.claim, allText, claims.map(c => c.statement).join(' '))
  if (droppedNumbers.length) {
    return { ...fail('failed', `the repair would lose ${droppedNumbers.join(', ')}, which a passage and the old claim both state; left hidden for review`, attempts, ledger, passages.length), droppedNumbers }
  }
  return {
    outcome: 'repaired', source: 'rewrite', newStatement, memberRawInsightId: null, droppedNumbers, ...common, charsAfter,
    note: `${claims.length === 1 ? 'stays one claim' : `becomes ${claims.length} claims`}; ${kept} of ${units.length} facts kept as judged, ${edited} edited, ${removedFacts} unsupported fact${removedFacts === 1 ? '' : 's'} removed (${charsRemoved} characters); ${charsBefore} characters before, ${charsAfter} after`,
  }
}

/** Stage 0: the units the rest of the repair works on. */
async function cutIntoUnits(input: RepairInput, deps: RepairDeps, attempts: Attempt[]): Promise<{ units: Unit[]; cutAt: 'facts' | 'sentences'; refused: string | null }> {
  const sentences = () => ({ units: splitUnits(input.claim), cutAt: 'sentences' as const, refused: null })
  if (!deps.decompose) return sentences()
  let gap: string | null = null
  for (let n = 1; n <= 2; n++) {
    let facts: string[]
    try {
      facts = await deps.decompose(input.claim, input.claimContextNote, gap)
    } catch (err) {
      if (isModelRefusal(err)) return { units: [], cutAt: 'sentences', refused: err instanceof Error ? err.message : 'refused' }
      throw err
    }
    gap = coverageGap(input.claim, facts)
    attempts.push({ kind: 'decompose', unit: -1, statement: `${facts.length} facts`, guard: gap ?? undefined })
    if (!gap) return { units: facts.map(f => ({ text: f, sep: ' ' })), cutAt: 'facts', refused: null }
  }
  return sentences()
}

/** Build the model call for repairClaim from the llm layer; kept here so the script and tests share one parse. */
export function makeRewrite(
  call: (system: string, user: string) => Promise<{ action?: unknown; statement?: unknown; removed?: unknown; changes?: unknown; reason?: unknown }>,
  system: string,
  buildUser: (req: UnitRewriteRequest) => string,
  parse: (raw: { action?: unknown; statement?: unknown; removed?: unknown; changes?: unknown; reason?: unknown }) => UnitRewriteOutput
): RepairDeps['rewrite'] {
  return async req => parse(await call(system, buildUser(req)))
}
