/**
 * Which fidelity rulings still need Paul's second look.
 *
 * Labelling all 40 pairs is only half the worksheet. Scoring his rulings
 * against the AI judge (`evalExtraction.ts score`, 2026-08-15) gave κ ≈ -0.1 on
 * 9 disagreements, and the judge can't be certified until he re-reads those 9
 * with the judge's reasoning in view — keeping his ruling or changing it. Once
 * every pair had a label the dashboard tile read "All labeled" and folded away,
 * so the re-checks it was waiting on went unseen for seven weeks.
 *
 * A disagreement counts as re-checked when its label was saved after the
 * comparison: changing the ruling and re-confirming it both re-save the row.
 */

/** When Paul's labels were scored against the judge — commit 65931a0. */
export const JUDGE_COMPARED_AT = '2026-08-15T02:36:59Z'

export type FidelityLabel = { pair_id: string; label: string; updated_at: string | null }

/** Pair ids where Paul and the judge disagree and he has not re-read it since. */
export function pendingRechecks(
  labels: FidelityLabel[],
  judgeVerdicts: Map<string, string>,
  comparedAt: string = JUDGE_COMPARED_AT
): Set<string> {
  const cutoff = Date.parse(comparedAt)
  const pending = new Set<string>()
  for (const l of labels) {
    const judge = judgeVerdicts.get(l.pair_id)
    if (!judge || judge === l.label) continue
    // A missing timestamp is treated as old: it can only hide work, never invent it.
    const saved = l.updated_at ? Date.parse(l.updated_at) : 0
    if (saved <= cutoff) pending.add(l.pair_id)
  }
  return pending
}
