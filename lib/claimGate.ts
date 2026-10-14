/**
 * The claim gate's quarantine switch (v4 spec §7): which flags hide a claim from
 * synthesis, and what a reviewer's ruling does to a hidden claim.
 *
 * `claims.status = 'flagged'` is the quarantine state: every reader of the corpus
 * (topic_claims(), match_claims(), the tagger, synthesis) filters
 * `status = 'active'`, so a flagged claim is invisible to articles, and its open
 * flag puts it in Paul's review queue (/admin/flags).
 *
 * Only `extraction_fidelity` quarantines. Its judge was certified against Paul's
 * 40 gold labels on 2026-10-12 (κ 0.89, 0 missed inventions, 1 false positive of
 * 35) and Paul switched it from shadow mode to on the same day. The other rules
 * stay advisory: merge_fidelity and orphan_topic are cheap heuristics with no
 * human-validated precision, and quarantining on them would bury good claims.
 *
 * Undo: set FIDELITY_SHADOW_MODE=1 in the environment that runs
 * `scripts/flagClaims.ts fidelity`; flags are then recorded without hiding
 * anything, exactly as before the switch.
 */

export const QUARANTINING_RULES: ReadonlySet<string> = new Set(['extraction_fidelity'])

/** True when a newly raised flag of this rule should hide its claim. */
export function quarantinesOnRaise(rule: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!QUARANTINING_RULES.has(rule)) return false
  return env.FIDELITY_SHADOW_MODE !== '1'
}

/**
 * The claim status a resolution should leave behind, or null for "unchanged".
 *
 * On /admin/flags, "approved" means the FLAG is right (the fact misstates its
 * source), so the claim stays hidden. "false_positive" means the fact is fine,
 * so a claim the gate hid goes back to `active`. Nothing else touches status:
 * an edit/split/archive is its own deliberate action on the claim.
 */
export function statusAfterResolution(currentStatus: string, rule: string, resolution: string): 'active' | null {
  if (currentStatus !== 'flagged') return null
  if (!QUARANTINING_RULES.has(rule)) return null
  return resolution === 'false_positive' ? 'active' : null
}
