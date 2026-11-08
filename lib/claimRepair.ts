/**
 * Repair a quarantined claim in place (Paul, 2026-11-08) instead of re-extracting it.
 *
 * The extraction-fidelity judge hides a claim (claims.status = 'flagged', see
 * lib/claimGate.ts) when its seed insight says more or less than the transcript
 * passage did. This module decides what the claim should say instead. It is pure
 * apart from the two model calls, which arrive as `deps`, so every decision is
 * testable without a database or a model. The DB reads and writes live in
 * scripts/repairFlaggedClaims.ts.
 *
 * Order of attempts, cheapest and safest first:
 *   0. Multi-member claim whose CURRENT wording differs from the seed insight: judge the
 *      current wording against the seed passage. The flag was raised on the seed insight, so
 *      enrichment may already have fixed it. FAITHFUL -> nothing to rewrite (`canonical_ok`).
 *   1. Another member insight supports the claim: the judge only ever read the SEED passage
 *      (Paul's point). Judge each other member's own statement against its own passage; the
 *      first FAITHFUL one is adopted verbatim (`member`). No model wrote it, so nothing in it
 *      can be invented. A member much shorter than the claim (under MIN_ADOPT_LENGTH_RATIO of
 *      its length) is not adopted, so a rich claim is not silently narrowed (option B, 2026-11-08).
 *   2. Opus rewrites the claim from the failing passage under lib/repairRules.ts, a numeric
 *      guard rejects an invented number before the judge sees it, and the SAME judge
 *      (lib/extractionFidelity.ts) re-reads the result. Two failed rewrites stop the claim
 *      (`failed`), which stays hidden for Paul.
 * A claim that depends on the screen (`needs_video`), has no supportable version
 * (`cannot_repair`) or hit the safety filter (`refused`) also stays hidden, with a note.
 */

import { fidelityCheck, numericSpecifics, droppedSpecifics } from './enrichMerge'
import type { FidelityResult } from './extractionFidelity'
import { isRealFidelity } from './extractionFidelity'
import { parseRewrite, rejectionFeedback, type RewriteOutput, type RewriteRequest } from './repairRules'

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
  rewrite: (req: RewriteRequest) => Promise<RewriteOutput>
}

export type RepairOutcome =
  | 'repaired'      // a faithful new wording was found; becomes active
  | 'canonical_ok'  // the current wording already passes against the seed passage
  | 'failed'        // two rewrites did not pass the judge; stays hidden
  | 'needs_video'   // depends on the screen; stays hidden
  | 'cannot_repair' // nothing supportable, or no passage to check against; stays hidden
  | 'refused'       // the model's safety filter declined; stays hidden
  | 'error'         // a transport failure, no verdict: nothing recorded, tried again next run

export type RepairSource = 'member' | 'rewrite' | 'unchanged'

export type Attempt = {
  kind: 'canonical_check' | 'member' | 'member_skipped' | 'rewrite'
  statement: string
  rawInsightId?: string
  judge?: FidelityResult
  /** A deterministic rejection before the judge ran (invented number, empty, unchanged). */
  guard?: string
  changes?: string
}

export type RepairResult = {
  outcome: RepairOutcome
  source: RepairSource | null
  /** The wording the claim should carry; set for `repaired` only. */
  newStatement: string | null
  memberRawInsightId: string | null
  /** Numbers the passage and the old wording both had that the new wording lost. Informational. */
  droppedNumbers: string[]
  note: string
  attempts: Attempt[]
}

/** Judging every other member would turn one repair into dozens of calls; the closest few are enough. */
export const MAX_MEMBER_TRIES = 3
/** Option B (Paul, 2026-11-08): another member's wording is adopted only when it is at least this
 *  fraction as long as the claim's current statement. A much shorter one would silently narrow a
 *  rich several-insight claim to one insight's sentence, so those go to the Opus rewrite instead. */
export const MIN_ADOPT_LENGTH_RATIO = 0.5
/** "A claim that fails twice stays hidden for Paul's review." */
export const MAX_REWRITES = 2
/** A repaired claim is one or two sentences. */
const MAX_STATEMENT_CHARS = 700

// ── Small pure helpers ──────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()

const tokens = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 2))

/** Word overlap, 0-1. Used only to order candidates, never to decide a verdict. */
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / (A.size + B.size - hit)
}

export const sameText = (a: string, b: string) => norm(a) === norm(b)

/** The seed member (the insight that created the claim), else the first member with a passage. */
export function pickSeed(members: MemberPassage[]): MemberPassage | null {
  const withChunk = members.filter(m => m.chunk)
  return withChunk.find(m => m.matchedBy === 'seed') ?? withChunk[0] ?? null
}

/** Other members worth judging for adoption, closest to the claim's current wording first. */
export function memberCandidates(input: RepairInput, seed: MemberPassage): MemberPassage[] {
  return memberPool(input, seed).filter(m => !tooNarrowToAdopt(m.statement, input.claim)).slice(0, MAX_MEMBER_TRIES)
}

/** Other members that would have been judged but for being much shorter than the claim (option B). */
export function narrowMembersSkipped(input: RepairInput, seed: MemberPassage): MemberPassage[] {
  return memberPool(input, seed).filter(m => tooNarrowToAdopt(m.statement, input.claim))
}

/** True when a member's wording is much shorter than the claim's current statement (option B). */
export function tooNarrowToAdopt(memberStatement: string, claim: string): boolean {
  return memberStatement.trim().length < MIN_ADOPT_LENGTH_RATIO * claim.trim().length
}

function memberPool(input: RepairInput, seed: MemberPassage): MemberPassage[] {
  return input.members
    .filter(m => m.rawInsightId !== seed.rawInsightId && m.chunk && m.statement.trim())
    // A member whose wording is the seed's or the claim's own was already judged unfaithful.
    .filter(m => !sameText(m.statement, seed.statement) && !sameText(m.statement, input.claim))
    .filter((m, i, all) => all.findIndex(o => sameText(o.statement, m.statement)) === i)
    .map(m => ({ m, s: similarity(m.statement, input.claim) }))
    .sort((a, b) => b.s - a.s || b.m.statement.length - a.m.statement.length || a.m.rawInsightId.localeCompare(b.m.rawInsightId))
    .map(x => x.m)
}

/** Deterministic checks on a model-written statement, before spending a judge call on it.
 *  Returns the reason it is rejected, or null. */
export function guardRewrite(candidate: string, current: string, grounding: string[]): string | null {
  const text = candidate.trim()
  if (!text) return 'the rewrite was empty'
  if (sameText(text, current)) return 'the rewrite is the same wording as the claim that was flagged'
  if (text.length > MAX_STATEMENT_CHARS) return `the rewrite is ${text.length} characters, over the ${MAX_STATEMENT_CHARS} limit`
  const { ok, invented } = fidelityCheck(text, grounding)
  if (!ok) return `the rewrite states ${invented.join(', ')}, which the passage never says`
  return null
}

/** Numbers the old wording and the passage both carried that the new wording no longer has. */
export function lostNumbers(oldWording: string, passage: string, newWording: string): string[] {
  const inPassage = new Set(numericSpecifics(passage))
  return droppedSpecifics(newWording, [oldWording]).filter(n => inPassage.has(n))
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

const empty = (outcome: RepairOutcome, note: string, attempts: Attempt[] = []): RepairResult => ({
  outcome, source: null, newStatement: null, memberRawInsightId: null, droppedNumbers: [], note, attempts,
})

const isModelRefusal = (err: unknown) => err instanceof Error && err.name === 'ModelRefusalError'

/** Run the steps in the file header for one claim. Throws only what must stop the whole run (a usage
 *  limit, a halted CLI); a refusal or a bad reply becomes an outcome on this claim. */
export async function repairClaim(input: RepairInput, deps: RepairDeps): Promise<RepairResult> {
  const seed = pickSeed(input.members)
  if (!seed) return empty('cannot_repair', 'no member has a transcript passage to check against')
  const attempts: Attempt[] = []

  // 0. Maybe the current wording already passes (multi-member claims whose canonical drifted off the seed).
  if (!sameText(input.claim, seed.statement)) {
    const j = await deps.judge(input.claim, seed.chunk, { contextNote: seed.contextNote, directQuote: seed.directQuote })
    attempts.push({ kind: 'canonical_check', statement: input.claim, judge: j })
    if (!isRealFidelity(j)) return empty('error', `judge failed: ${j.reasoning}`, attempts)
    if (j.verdict === 'FAITHFUL') {
      return { ...empty('canonical_ok', "the claim's current wording passes against the seed passage; the flag was about the seed insight's own wording", attempts), source: 'unchanged' }
    }
  }

  // 1. Another member's own wording, judged against its own passage. Members much shorter than the
  //    claim are left out (option B) and recorded, so the audit shows why the rewrite ran.
  for (const m of narrowMembersSkipped(input, seed)) {
    attempts.push({
      kind: 'member_skipped', statement: m.statement, rawInsightId: m.rawInsightId,
      guard: `not adopted: ${m.statement.trim().length} characters against the claim's ${input.claim.trim().length} (under ${Math.round(MIN_ADOPT_LENGTH_RATIO * 100)}%), so it would narrow the claim`,
    })
  }
  for (const m of memberCandidates(input, seed)) {
    const j = await deps.judge(m.statement, m.chunk, { contextNote: m.contextNote, directQuote: m.directQuote })
    attempts.push({ kind: 'member', statement: m.statement, rawInsightId: m.rawInsightId, judge: j })
    if (!isRealFidelity(j)) return empty('error', `judge failed: ${j.reasoning}`, attempts)
    if (j.verdict === 'FAITHFUL') {
      return {
        outcome: 'repaired', source: 'member', newStatement: m.statement.trim(), memberRawInsightId: m.rawInsightId,
        droppedNumbers: lostNumbers(input.claim, m.chunk, m.statement),
        note: 'adopted the wording of another member insight that is faithful to its own passage', attempts,
      }
    }
  }

  // 2. A rewrite from the failing passage, judged by the same judge. At most MAX_REWRITES.
  let prior: { statement: string; why: string } | null = null
  // Grounded in the passage alone: the seed insight and its cited quote are what the judge faulted, so a
  // number only they carry is exactly the kind of invention this guard exists to catch.
  const grounding = [seed.chunk]
  for (let n = 1; n <= MAX_REWRITES; n++) {
    let out: RewriteOutput
    try {
      out = await deps.rewrite({
        passage: seed.chunk, claim: input.claim, claimContextNote: input.claimContextNote,
        insight: { statement: seed.statement, contextNote: seed.contextNote, directQuote: seed.directQuote },
        verdict: input.flag, priorRejection: prior,
      })
    } catch (err) {
      if (isModelRefusal(err)) return empty('refused', err instanceof Error ? err.message : 'refused', attempts)
      throw err
    }
    if (out.action === 'needs_video') return empty('needs_video', out.reason || 'depends on something shown on screen', attempts)
    if (out.action === 'cannot_repair') return empty('cannot_repair', out.reason || 'the passage supports no version of this claim', attempts)

    const guard = guardRewrite(out.statement, input.claim, grounding)
    if (guard) {
      attempts.push({ kind: 'rewrite', statement: out.statement, guard, changes: out.changes })
      prior = { statement: out.statement, why: guard }
      continue
    }
    const j = await deps.judge(out.statement, seed.chunk, { contextNote: seed.contextNote, directQuote: seed.directQuote })
    attempts.push({ kind: 'rewrite', statement: out.statement, judge: j, changes: out.changes })
    if (!isRealFidelity(j)) return empty('error', `judge failed: ${j.reasoning}`, attempts)
    if (j.verdict === 'FAITHFUL') {
      return {
        outcome: 'repaired', source: 'rewrite', newStatement: out.statement.trim(), memberRawInsightId: seed.rawInsightId,
        droppedNumbers: lostNumbers(input.claim, seed.chunk, out.statement),
        note: out.changes || 'rewritten from the failing passage', attempts,
      }
    }
    prior = { statement: out.statement, why: rejectionFeedback(j) }
  }
  return empty('failed', `${MAX_REWRITES} rewrites did not pass the judge; left hidden for review`, attempts)
}

/** Build the model call for repairClaim from the llm layer; kept here so the script and tests share one parse. */
export function makeRewrite(
  call: (system: string, user: string) => Promise<{ action?: unknown; statement?: unknown; changes?: unknown; reason?: unknown }>,
  system: string,
  buildUser: (req: RewriteRequest) => string
): RepairDeps['rewrite'] {
  return async req => parseRewrite(await call(system, buildUser(req)))
}
