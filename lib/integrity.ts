/**
 * Corpus integrity — the signatures an interrupted caption replacement leaves
 * behind (docs/caption-retirement-plan.md, docs/EXTRACTION_RUNBOOK.md §4).
 * Pure set arithmetic over id lists, so it is testable without a database;
 * scripts/checkIntegrity.ts reads the ids (read-only) and calls this.
 */
export type IntegrityInput = {
  activeClaimIds: string[]
  retiredClaimIds: string[]
  /** claim_members rows */
  members: { claim_id: string; raw_insight_id: string }[]
  /** raw_insights rows */
  insights: { id: string; source_id: string }[]
  sourceIds: string[]
  /** claim ids that have a row in claim_embeddings */
  vectorClaimIds: string[]
}

export type IntegrityReport = {
  /** Active claims with no claim_members row (an emptied claim that was never retired). */
  activeNoMembers: string[]
  /** claim_members rows whose fact no longer exists. */
  membersMissingFact: { claim_id: string; raw_insight_id: string }[]
  /** Retired claims that still hold a vector. */
  retiredWithVector: string[]
  /** Retired claims that still have members. */
  retiredWithMembers: string[]
  /** Facts whose source row is gone. */
  factsMissingSource: string[]
}

export function checkIntegrity(input: IntegrityInput): IntegrityReport {
  const memberClaims = new Set(input.members.map(m => m.claim_id))
  const insightIds = new Set(input.insights.map(i => i.id))
  const sources = new Set(input.sourceIds)
  const vectors = new Set(input.vectorClaimIds)
  return {
    activeNoMembers: input.activeClaimIds.filter(id => !memberClaims.has(id)),
    membersMissingFact: input.members.filter(m => !insightIds.has(m.raw_insight_id)),
    retiredWithVector: input.retiredClaimIds.filter(id => vectors.has(id)),
    retiredWithMembers: input.retiredClaimIds.filter(id => memberClaims.has(id)),
    factsMissingSource: input.insights.filter(i => !sources.has(i.source_id)).map(i => i.id),
  }
}

export function integrityCounts(r: IntegrityReport): Record<keyof IntegrityReport, number> {
  return {
    activeNoMembers: r.activeNoMembers.length,
    membersMissingFact: r.membersMissingFact.length,
    retiredWithVector: r.retiredWithVector.length,
    retiredWithMembers: r.retiredWithMembers.length,
    factsMissingSource: r.factsMissingSource.length,
  }
}

export const INTEGRITY_LABELS: Record<keyof IntegrityReport, string> = {
  activeNoMembers: 'active claims with no members',
  membersMissingFact: 'members pointing at a missing fact',
  retiredWithVector: 'retired claims that still have a vector',
  retiredWithMembers: 'retired claims that still have members',
  factsMissingSource: 'facts whose source row is gone',
}
