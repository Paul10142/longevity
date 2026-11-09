/**
 * Hiding skipped and non-full episodes on the admin review screens.
 *
 * "Skipped" is the mark from migration 038: `sources.processing_status = 'skipped'`
 * plus a written `skip_reason`. Re-posts, copies and items that are not a full
 * episode (a re-release, an anniversary special, a trailer) all carry it. Every
 * admin review screen asks this one module which sources are skipped, keeps them
 * out of its main list, and hands them to <SkippedList> (components/SkippedList),
 * a single collapsed list, so nothing is lost and little space is used.
 *
 * Nothing here writes. Facts already extracted from a skipped item are untouched;
 * a claim is hidden from a review list only when EVERY source behind it is skipped.
 *
 * Server-side only (it takes the service-role client). The pure functions below
 * the loaders are the unit-tested part.
 */
import { selectAllPaged } from './pagination'

export type SkippedSource = { id: string; title: string; reason: string | null }

/** The one definition of "skipped" for the admin screens. */
export const isSkippedStatus = (status: string | null | undefined): boolean => status === 'skipped'

/** The written reason, or plain words when none was written. */
export function skipReasonText(reason: string | null | undefined): string {
  const t = (reason ?? '').trim()
  return t || 'No reason written'
}

/** Split `items` into the ones to show and the skipped ones, keeping order. */
export function splitBySkipped<T>(
  items: readonly T[],
  sourceIdOf: (item: T) => string | null | undefined,
  skipped: ReadonlyMap<string, SkippedSource>
): { shown: T[]; hidden: T[] } {
  const shown: T[] = []
  const hidden: T[] = []
  for (const item of items) {
    const id = sourceIdOf(item)
    ;(id && skipped.has(id) ? hidden : shown).push(item)
  }
  return { shown, hidden }
}

/**
 * A claim is "skipped only" when it has at least one source and every one of
 * them is skipped. A claim also backed by a full episode stays in the main list.
 */
export function isSkippedOnly(sourceIds: readonly string[] | undefined, skipped: ReadonlyMap<string, SkippedSource>): boolean {
  if (!sourceIds || sourceIds.length === 0) return false
  return sourceIds.every(id => skipped.has(id))
}

/** The skipped sources behind a claim, de-duplicated, in the order given. */
export function skippedSourcesOf(sourceIds: readonly string[] | undefined, skipped: ReadonlyMap<string, SkippedSource>): SkippedSource[] {
  const seen = new Set<string>()
  const out: SkippedSource[] = []
  for (const id of sourceIds ?? []) {
    const s = skipped.get(id)
    if (s && !seen.has(id)) {
      seen.add(id)
      out.push(s)
    }
  }
  return out
}

/** One "title" and one "reason" line for a claim backed only by skipped sources. */
export function describeSkippedSources(list: readonly SkippedSource[]): { title: string; reason: string } {
  if (list.length === 0) return { title: 'Unknown Episode', reason: skipReasonText(null) }
  const title = list.length === 1 ? list[0].title : `${list[0].title} (+${list.length - 1} more)`
  return { title, reason: skipReasonText(list[0].reason) }
}

/** What the loaders need from a Supabase client. */
type Db = { from: (table: string) => any }

/**
 * Every skipped source, keyed by id. Before migration 038 there is no
 * `skip_reason` column and nothing can be skipped, so the answer is empty.
 * On any other database error it logs and returns an empty map: the screen
 * then shows everything (nothing hidden) rather than failing to load.
 */
export async function loadSkippedSources(db: Db): Promise<Map<string, SkippedSource>> {
  const out = new Map<string, SkippedSource>()
  try {
    const read = (cols: string) =>
      selectAllPaged<{ id: string; title: string | null; skip_reason?: string | null }>((from, to) =>
        db.from('sources').select(cols).eq('processing_status', 'skipped').order('id', { ascending: true }).range(from, to)
      )
    let rows: { id: string; title: string | null; skip_reason?: string | null }[]
    try {
      rows = await read('id, title, skip_reason')
    } catch (err) {
      if (!/skip_reason|column/i.test(err instanceof Error ? err.message : '')) throw err
      rows = await read('id, title')
    }
    for (const r of rows) out.set(r.id, { id: r.id, title: r.title ?? 'Untitled', reason: r.skip_reason ?? null })
  } catch (err) {
    console.error('loadSkippedSources failed; showing every item:', err)
  }
  return out
}

/**
 * claim id -> ids of the sources behind it (through claim_members and
 * raw_insights). Chunked and paged: a chunk of claims can have more than the
 * 1000-row response cap in members. Throws on a database error; callers that
 * only hide things catch it and hide nothing.
 */
export async function loadClaimSourceIds(db: Db, claimIds: readonly string[], chunk = 50): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const unique = [...new Set(claimIds)]
  for (let i = 0; i < unique.length; i += chunk) {
    const ids = unique.slice(i, i + chunk)
    const rows = await selectAllPaged<{ claim_id: string; raw_insight_id: string; raw_insights: { source_id: string } | null }>((from, to) =>
      db
        .from('claim_members')
        .select('claim_id, raw_insight_id, raw_insights(source_id)')
        .in('claim_id', ids)
        .order('claim_id', { ascending: true })
        .order('raw_insight_id', { ascending: true })
        .range(from, to)
    )
    for (const r of rows) {
      const sid = r.raw_insights?.source_id
      if (!sid) continue
      const list = out.get(r.claim_id) ?? []
      if (!list.includes(sid)) list.push(sid)
      out.set(r.claim_id, list)
    }
  }
  return out
}

/**
 * For a set of claims: which are backed only by skipped sources. Returns the
 * source ids per claim too, so a caller can name them. Fails open: on a
 * database error nothing is hidden.
 */
export async function skippedOnlyClaims(
  db: Db,
  claimIds: readonly string[],
  skipped: ReadonlyMap<string, SkippedSource>
): Promise<{ hidden: Set<string>; sourcesByClaim: Map<string, string[]> }> {
  const hidden = new Set<string>()
  if (skipped.size === 0 || claimIds.length === 0) return { hidden, sourcesByClaim: new Map() }
  try {
    const sourcesByClaim = await loadClaimSourceIds(db, claimIds)
    for (const [claimId, sids] of sourcesByClaim) if (isSkippedOnly(sids, skipped)) hidden.add(claimId)
    return { hidden, sourcesByClaim }
  } catch (err) {
    console.error('skippedOnlyClaims failed; showing every item:', err)
    return { hidden, sourcesByClaim: new Map() }
  }
}
