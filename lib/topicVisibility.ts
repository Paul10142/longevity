/**
 * Visibility gate — "existence vs. visibility" (see ARCHITECTURE.md, BACKLOG §2a).
 *
 * Thin topics (few claims) still EXIST in the taxonomy — the pipeline keeps
 * tagging into them and they show up in every admin surface — but they stay
 * HIDDEN from public readers until they mature. This avoids showing a reader a
 * one-sentence "article", and avoids fold/unfold churn as counts wobble around
 * the line: a topic is either published or it isn't, decided by a single stable
 * threshold on its accumulated evidence.
 *
 * A topic is PUBLIC when the number of active claims in its own subtree reaches
 * VISIBILITY_MIN_CLAIMS. Visibility is monotonic up the tree — a child's subtree
 * is a subset of its parent's, so a visible topic always has visible ancestors,
 * and there are never orphaned public links pointing through a hidden parent.
 *
 * This is a READ-SIDE gate: it needs no migration to work and is computed in JS
 * from the flat `topics` rows the public pages already fetch. The optional
 * `is_hidden` manual override (migration 018) is wired below but is only honored
 * once callers actually SELECT that column — do NOT add it to a query until the
 * migration has been applied, or the read will error on the missing column.
 */

/** Below this many subtree claims, a topic is hidden from public readers. */
export const VISIBILITY_MIN_CLAIMS = 10

/** Minimal shape needed to roll up subtree claim counts. */
export type VisibilityRow = {
  id: string
  parent_id: string | null
  claim_count: number | null
  /**
   * Manual curator override (topics.is_hidden, migration 018). Undefined until
   * a caller selects the column post-migration; treated as `false` when absent
   * so the read-side never depends on the column existing.
   */
  is_hidden?: boolean | null
}

/**
 * Sum each topic's own `claim_count` plus every descendant's, returning a
 * Map<topicId, subtreeCount>. Mirrors the rollup the topic pages already do,
 * but computed once for the whole tree so we can gate a listing without firing
 * one `topic_claim_count` RPC per topic.
 *
 * Note: this sums the denormalized per-topic `claim_count`, so a claim tagged to
 * two topics in the same subtree is counted twice. That is an over-count in the
 * generous direction (a topic is never hidden that the exact RPC would show), and
 * matches the existing page rollups. Individual topic pages can still use the
 * exact `topic_claim_count` RPC when they need a precise number.
 */
export function subtreeClaimCounts<T extends VisibilityRow>(rows: T[]): Map<string, number> {
  const byId = new Map<string, T>()
  const childrenOf = new Map<string, string[]>()
  for (const r of rows) byId.set(r.id, r)
  for (const r of rows) {
    if (!r.parent_id || !byId.has(r.parent_id)) continue
    const list = childrenOf.get(r.parent_id) ?? []
    list.push(r.id)
    childrenOf.set(r.parent_id, list)
  }

  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    // Guard against a malformed cycle in live data — count the back-edge as own only.
    if (visiting.has(id)) return byId.get(id)?.claim_count ?? 0
    visiting.add(id)
    let total = byId.get(id)?.claim_count ?? 0
    for (const childId of childrenOf.get(id) ?? []) total += visit(childId)
    visiting.delete(id)
    memo.set(id, total)
    return total
  }
  for (const r of rows) visit(r.id)
  return memo
}

/**
 * Is a topic visible to public readers? Hidden if its subtree is below the
 * threshold, or if a curator has explicitly hidden it (once `is_hidden` is
 * selected post-migration).
 */
export function isVisibleCount(subtreeCount: number, isHidden: boolean | null | undefined = false): boolean {
  if (isHidden) return false
  return subtreeCount >= VISIBILITY_MIN_CLAIMS
}

/**
 * Given the flat set of topic rows, return the ids that are public. Admins should
 * bypass this entirely and see every topic.
 */
export function visibleTopicIds<T extends VisibilityRow>(rows: T[]): Set<string> {
  const counts = subtreeClaimCounts(rows)
  const visible = new Set<string>()
  for (const r of rows) {
    if (isVisibleCount(counts.get(r.id) ?? 0, r.is_hidden)) visible.add(r.id)
  }
  return visible
}
