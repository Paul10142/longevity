/**
 * The plan for marking Drive items that are not full episodes as skipped (the
 * same mark migration 038 gives the duplicates: processing_status = 'skipped'
 * plus a written skip_reason). Pure: scripts/markNonFullSkipped.ts reads the
 * rows, asks this module what to do, and only writes with --apply.
 *
 * Safety rules, all enforced here so they are tested:
 *   - a title that matches no row, or more than one row, refuses the whole run;
 *   - a row already skipped is left exactly as it is (its reason is kept);
 *   - a row being processed right now is never touched;
 *   - the write is only the status and the reason, never facts or claims.
 */

export type NonFullTarget = {
  /** Short name for the report. */
  label: string
  /** The row's title must start with this (case-insensitive). */
  titlePrefix: string
  /** Written in skip_reason. */
  reason: string
}

export const NON_FULL_TARGETS: readonly NonFullTarget[] = [
  {
    label: 'Ayrton Senna re-release',
    titlePrefix: 'The Ayrton Senna Episode (re-release)',
    reason: 'not a full episode: re-release of an earlier episode',
  },
  {
    label: 'Olivia Attia anniversary episode',
    titlePrefix: 'The one-year anniversary episode with Olivia Attia',
    reason: 'not a full episode: one-year anniversary episode',
  },
  {
    label: 'Dax Shepard special',
    titlePrefix: 'Special episode with Dax Shepard',
    reason: 'not a full episode: special episode on F1 and the Senna anniversary',
  },
  {
    label: 'Introducing Early',
    titlePrefix: 'Introducing Early',
    reason: 'not a full episode: short show introduction',
  },
]

export type SourceRowLite = {
  id: string
  title: string | null
  processing_status: string | null
  skip_reason?: string | null
}

export type PlanVerdict = 'change' | 'already-skipped' | 'busy' | 'no-match' | 'multiple-matches'

export type PlanEntry = {
  target: NonFullTarget
  verdict: PlanVerdict
  /** Every row whose title matched (one row for change / already-skipped / busy). */
  matches: SourceRowLite[]
}

export const titleMatches = (title: string | null, prefix: string): boolean =>
  (title ?? '').trim().toLowerCase().startsWith(prefix.trim().toLowerCase())

/** Decide, per target, what would happen. Never writes. */
export function planNonFullSkips(targets: readonly NonFullTarget[], rows: readonly SourceRowLite[]): PlanEntry[] {
  return targets.map(target => {
    const matches = rows.filter(r => titleMatches(r.title, target.titlePrefix))
    if (matches.length === 0) return { target, verdict: 'no-match' as const, matches }
    if (matches.length > 1) return { target, verdict: 'multiple-matches' as const, matches }
    const row = matches[0]
    if (row.processing_status === 'skipped') return { target, verdict: 'already-skipped' as const, matches }
    if (row.processing_status === 'processing') return { target, verdict: 'busy' as const, matches }
    return { target, verdict: 'change' as const, matches }
  })
}

/** The run is refused when any title matched zero rows or more than one row. */
export function refusalReasons(plan: readonly PlanEntry[]): string[] {
  const out: string[] = []
  for (const p of plan) {
    if (p.verdict === 'no-match') out.push(`"${p.target.titlePrefix}" matched no row`)
    if (p.verdict === 'multiple-matches') out.push(`"${p.target.titlePrefix}" matched ${p.matches.length} rows`)
  }
  return out
}

/** The exact rows an --apply would write. */
export function rowsToWrite(plan: readonly PlanEntry[]): { id: string; skip_reason: string }[] {
  return plan.filter(p => p.verdict === 'change').map(p => ({ id: p.matches[0].id, skip_reason: p.target.reason }))
}
