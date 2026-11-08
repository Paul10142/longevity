/**
 * Small pure helpers for the flag side of the repair tool (scripts/repairFlaggedClaims.ts):
 * what a flag's verdict, offending phrase and reasoning are, and the note a claim that could
 * not be repaired carries on its flag. No database, no model.
 */

import type { RepairOutcome } from './claimRepair'
import type { FlagFacts } from './claimRepair'

type FlagLike = { detail: string | null; evidence: Record<string, unknown> | null }

/** The note prefixes, so a re-run can recognise a flag it already annotated. */
export const NOTE_LABEL: Partial<Record<RepairOutcome, string>> = {
  needs_video: 'NEEDS VIDEO CHECK',
  cannot_repair: 'CANNOT REPAIR',
  failed: 'REPAIR FAILED TWICE',
  refused: 'REPAIR DECLINED BY MODEL',
}

/** The detail the extraction_fidelity flag had when it was raised, even after the repair tool
 *  prefixed it with a note (the original is kept in evidence.repair.original_detail). */
export function originalDetail(flag: FlagLike): string {
  const repair = flag.evidence?.repair as { original_detail?: unknown } | undefined
  if (repair && typeof repair.original_detail === 'string') return repair.original_detail
  return flag.detail ?? ''
}

/** The judge's verdict, offending phrase and reasoning, read from a flag raised by
 *  `scripts/flagClaims.ts fidelity` (detail = "VERDICT: reasoning", evidence.verdict/offending). */
export function flagFacts(flag: FlagLike): FlagFacts {
  const detail = originalDetail(flag)
  const ev = flag.evidence ?? {}
  const m = detail.match(/^([A-Z_]+):\s*([\s\S]*)$/)
  const verdict = typeof ev.verdict === 'string' && ev.verdict ? ev.verdict : (m?.[1] ?? 'UNKNOWN')
  const offending = typeof ev.offending === 'string' ? ev.offending : ''
  const reasoning = m && m[1] === verdict ? m[2] : detail
  return { verdict, offending, reasoning }
}

/** The note to put on a flag that stays open, or null when this outcome adds none. */
export function flagNote(outcome: RepairOutcome, note: string, flag: FlagLike): { detail: string; label: string } | null {
  const label = NOTE_LABEL[outcome]
  if (!label) return null
  const was = originalDetail(flag)
  return { label, detail: `${label}: ${note}${was ? ` (flagged as ${was})` : ''}` }
}

/** What the resolved flag records for each outcome that puts the claim back. */
export function resolutionFor(outcome: RepairOutcome): 'reworded' | 'false_positive' | null {
  if (outcome === 'repaired') return 'reworded'
  if (outcome === 'canonical_ok') return 'false_positive'
  return null
}
