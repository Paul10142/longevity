/**
 * Option (c) for an episode that is in the library twice with facts from BOTH copies
 * (Paul's call, 2026-11-08; scripts/retireDuplicateMemberships.ts): remove the skipped
 * copy's DUPLICATE citations and keep everything else.
 *
 * Both copies of an episode were transcribed and extracted separately, so each copy's
 * facts were consolidated into claims. Two kinds of claim result:
 *
 *   SHARED  a claim fed by the skipped copy AND the kept copy. The same fact is cited
 *           twice, once per copy, so `source_count` says "two sources" for one
 *           episode. Its skipped-copy memberships are removed; the kept copy's stay.
 *           The claim loses no wording (the canonical statement is not touched: the
 *           skipped copy's facts are not wrong, only repeated) and no member it needs.
 *   SOLO    a claim fed by the skipped copy and NOT by the kept copy: a fact only that
 *           extraction pass found (each pass pulls a different ~75% of an episode).
 *           Untouched: its citation is the skipped source row, which stays.
 *
 * Pure: facts about members in, the exact memberships to remove out. No I/O. The
 * script reads the database and applies the plan; tests/duplicateMemberships.test.ts
 * covers the rules.
 *
 * What this never does: delete a claim, a raw insight or a source row; remove a
 * membership that would leave a claim with no member; touch a claim the kept copy
 * does not also feed; touch a claim that is not active.
 */

export type MemberEdge = {
  claim_id: string
  raw_insight_id: string
  source_id: string
  /** 'seed' = the insight that created the claim (its first wording). Optional: only used for the report. */
  matched_by?: string | null
}

export type SharedClaim = {
  claim_id: string
  /** raw_insight ids of the SKIPPED copy to detach from this claim. */
  remove: string[]
  keptMembers: number
  /** True when a removed member is the insight the claim was first written from (the wording stays). */
  seedRemoved: boolean
  /** Members from sources that are neither copy (another episode corroborating the fact). */
  otherMembers: number
  sourceCountBefore: number
  sourceCountAfter: number
}

export type SoloClaim = {
  claim_id: string
  skippedMembers: number
  /** Members from another episode as well: the claim stays corroborated. */
  otherMembers: number
}

export type MembershipPlan = {
  skippedId: string
  keptId: string
  /** raw_insights the skipped copy has. */
  insights: number
  /** …of which at least one claim cites. */
  attached: number
  shared: SharedClaim[]
  solo: SoloClaim[]
  /** Exactly the (claim, insight) pairs to delete. */
  remove: { claim_id: string; raw_insight_id: string }[]
  /** Claims touched by the skipped copy that are not active: left exactly as they are. */
  inactiveClaims: number
  /** Shared claims whose source_count drops (the fake corroboration this removes). */
  sourceCountDrops: number
  /** Shared claims whose first-wording insight is among those removed (wording unchanged). */
  seedsRemoved: number
}

export function planDuplicateMemberships(input: {
  skippedId: string
  keptId: string
  /** Every raw_insight id of the skipped copy. */
  skippedInsightIds: readonly string[]
  /** EVERY member of every claim the skipped copy touches, whichever source it comes from. */
  edges: readonly MemberEdge[]
  /** Ids of the claims that are active; a claim not in this set is never changed. */
  activeClaimIds: ReadonlySet<string>
}): MembershipPlan {
  const { skippedId, keptId } = input
  if (skippedId === keptId) throw new Error('the skipped copy and the kept copy are the same source')

  const byClaim = new Map<string, MemberEdge[]>()
  for (const e of input.edges) byClaim.set(e.claim_id, [...(byClaim.get(e.claim_id) ?? []), e])

  const shared: SharedClaim[] = []
  const solo: SoloClaim[] = []
  const remove: MembershipPlan['remove'] = []
  const attachedInsights = new Set<string>()
  let inactiveClaims = 0

  for (const [claim_id, members] of [...byClaim].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fromSkipped = members.filter(m => m.source_id === skippedId)
    if (fromSkipped.length === 0) continue
    for (const m of fromSkipped) attachedInsights.add(m.raw_insight_id)
    if (!input.activeClaimIds.has(claim_id)) { inactiveClaims++; continue }
    const keptMembers = members.filter(m => m.source_id === keptId).length
    const otherMembers = members.length - fromSkipped.length - keptMembers
    if (keptMembers === 0) {
      solo.push({ claim_id, skippedMembers: fromSkipped.length, otherMembers })
      continue
    }
    const sourcesBefore = new Set(members.map(m => m.source_id))
    const sourcesAfter = new Set(members.filter(m => m.source_id !== skippedId).map(m => m.source_id))
    const ids = fromSkipped.map(m => m.raw_insight_id).sort()
    shared.push({
      claim_id,
      remove: ids,
      keptMembers,
      seedRemoved: fromSkipped.some(m => m.matched_by === 'seed'),
      otherMembers,
      sourceCountBefore: sourcesBefore.size,
      sourceCountAfter: sourcesAfter.size,
    })
    for (const raw_insight_id of ids) remove.push({ claim_id, raw_insight_id })
  }

  return {
    skippedId,
    keptId,
    insights: new Set(input.skippedInsightIds).size,
    attached: attachedInsights.size,
    shared,
    solo,
    remove,
    inactiveClaims,
    sourceCountDrops: shared.filter(s => s.sourceCountAfter < s.sourceCountBefore).length,
    seedsRemoved: shared.filter(s => s.seedRemoved).length,
  }
}
