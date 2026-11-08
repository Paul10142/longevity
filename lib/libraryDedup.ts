/**
 * The one-off cleanup of duplicates already in the library, as a pure plan:
 * rows in, groups and proposed changes out. scripts/dedupLibrary.ts reads the
 * database, prints this plan, and (only with --apply) writes it.
 *
 * Uses exactly the rules the feed ingest uses (lib/episodeDuplicates.ts), so a
 * row the cleanup would skip is a row the ingest would have skipped.
 *
 * WHICH COPY IS KEPT. Never an unextracted copy when an extracted one exists:
 * keeping the "tidier" row and skipping the one that already has facts would
 * queue the whole episode for a second extraction, which is the cost this work
 * exists to stop. The order, best first (comparePreference): still live → not
 * an `Essentials:` cut → already extracted → the episode number leads the title
 * → not marked rebroadcast → oldest → id.
 *
 * WHAT IS SKIPPED. Every other copy in a group, plus any re-post or cut with no
 * copy at all (an `Essentials:` row whose full episode is not in the library). A
 * kept copy is itself skipped only when it is an `Essentials:` cut, or a
 * rebroadcast with no facts and no full-episode sibling — the same "full
 * episodes only" rule the ingest applies. A kept copy that already has facts is
 * never skipped: its facts are in the claims either way.
 *
 * FACTS ARE NEVER TOUCHED. A skipped copy that already has facts keeps them.
 * Those facts sit in `claim_members` next to the kept copy's, so one episode
 * counts twice until they are retired (scripts/retireSourceClaims.ts is the
 * safe tool, and a separate step). The plan reports each such row.
 */

import {
  comparePreference,
  describeEpisode,
  looksSimilar,
  parseEpisodeTitle,
  sameEpisode,
  type LibraryRow,
  type MatchKind,
} from './episodeDuplicates'
import { showForSource } from './shows'

export type CleanupRow = LibraryRow & {
  transcript_origin?: string | null
  episode_number?: number | null
  skip_reason?: string | null
}

export type GroupLink = { a: string; b: string; kind: MatchKind }

export type DuplicateGroup = {
  series: string
  rows: CleanupRow[]
  keeper: CleanupRow
  links: GroupLink[]
  /** Set when the group joins two different episode numbers: shown, never applied. */
  suspicious: string | null
}

export type Change = {
  id: string
  title: string
  series: string
  /** The copy this one points at; null for a re-post with no original in the library. */
  duplicate_of: string | null
  skip_reason: string
  facts: number
  processing_status: string | null
  /** The row already carries this exact skip, so applying is a no-op. */
  alreadyApplied: boolean
  group: number | null
}

export type CleanupPlan = {
  groups: DuplicateGroup[]
  changes: Change[]
  /** Titles that look alike but are NOT decided (shown for a person). */
  similar: { a: CleanupRow; b: CleanupRow }[]
}

class Union {
  private parent = new Map<string, string>()
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let p = this.parent.get(x)!
    while (p !== this.parent.get(p)!) { this.parent.set(p, this.parent.get(this.parent.get(p)!)!); p = this.parent.get(p)! }
    return p
  }
  join(a: string, b: string) { this.parent.set(this.find(a), this.find(b)) }
}

const seriesOf = (r: CleanupRow) => showForSource({ series: r.series, external_id: r.external_id, authors: r.authors }).series

/** Group rows that are the same episode, per show. Rows that match nothing are not in any group. */
export function groupDuplicates(rows: readonly CleanupRow[]): DuplicateGroup[] {
  const byShow = new Map<string, CleanupRow[]>()
  for (const r of rows) byShow.set(seriesOf(r), [...(byShow.get(seriesOf(r)) ?? []), r])

  const groups: DuplicateGroup[] = []
  for (const [series, list] of byShow) {
    const uf = new Union()
    const links: GroupLink[] = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const m = sameEpisode(list[i], list[j])
        if (!m) continue
        uf.join(list[i].id, list[j].id)
        links.push({ a: list[i].id, b: list[j].id, kind: m.kind })
      }
    }
    const members = new Map<string, CleanupRow[]>()
    for (const r of list) {
      const root = uf.find(r.id)
      members.set(root, [...(members.get(root) ?? []), r])
    }
    for (const rs of members.values()) {
      if (rs.length < 2) continue
      const sorted = [...rs].sort(comparePreference)
      const ids = new Set(rs.map(r => r.id))
      const nums = new Set(rs.map(r => parseEpisodeTitle(r.title).episodeNumber).filter((n): n is number => n != null))
      groups.push({
        series,
        rows: sorted,
        keeper: sorted[0],
        links: links.filter(l => ids.has(l.a) && ids.has(l.b)),
        suspicious: nums.size > 1 ? `joins different episode numbers (${[...nums].join(', ')})` : null,
      })
    }
  }
  // Biggest groups first, then by keeper title, so a re-run prints in a stable order.
  return groups.sort((x, y) => y.rows.length - x.rows.length || x.keeper.title.localeCompare(y.keeper.title))
}

/**
 * The proposed writes. Every change is "mark this row skipped, and say why";
 * nothing else about a row is touched.
 */
export function planCleanup(rows: readonly CleanupRow[]): CleanupPlan {
  const groups = groupDuplicates(rows)
  const changes: Change[] = []
  const inGroup = new Set<string>()

  groups.forEach((g, gi) => {
    for (const r of g.rows) inGroup.add(r.id)
    if (g.suspicious) return // a group that merges two episode numbers is shown, never applied
    const keeperKeptLive = (() => {
      const p = parseEpisodeTitle(g.keeper.title)
      if (p.essentials) return false
      if (p.repost && (g.keeper.facts ?? 0) === 0 && g.keeper.processing_status !== 'succeeded') {
        // A rebroadcast with no full-episode sibling and nothing extracted: full episodes only.
        return g.rows.some(r => r.id !== g.keeper.id && !parseEpisodeTitle(r.title).repost && !parseEpisodeTitle(r.title).essentials)
      }
      return true
    })()
    for (const r of g.rows) {
      if (r.id === g.keeper.id && keeperKeptLive) continue
      const p = parseEpisodeTitle(r.title)
      const target = r.id === g.keeper.id ? null : g.keeper
      let reason: string
      if (!target) {
        reason = p.essentials
          ? 're-cut (Essentials): full episodes only; the full episode is not in the library'
          : `${p.repost ?? 'rebroadcast'}: full episodes only; the original is not in the library`
      } else if (p.essentials) reason = `re-cut (Essentials) of ${describeEpisode(target)}`
      else if (p.repost) reason = `${p.repost} of ${describeEpisode(target)}`
      else {
        const direct = sameEpisode(r, target)
        reason = `same episode as ${target.id} (${direct ? direct.detail : 'linked through another copy of the episode'})`
      }
      changes.push({
        id: r.id,
        title: r.title,
        series: g.series,
        duplicate_of: target?.id ?? null,
        skip_reason: reason,
        facts: r.facts ?? 0,
        processing_status: r.processing_status ?? null,
        alreadyApplied: r.processing_status === 'skipped' && (r.duplicate_of ?? null) === (target?.id ?? null),
        group: gi + 1,
      })
    }
  })

  // Re-posts and cuts that match nothing at all: skipped on their own title.
  for (const r of rows) {
    if (inGroup.has(r.id)) continue
    const p = parseEpisodeTitle(r.title)
    if (!p.essentials && !p.repost) continue
    // A rebroadcast that was already extracted is the only live copy of its
    // episode (its facts are in the claims either way): leave it alone.
    if ((r.facts ?? 0) > 0 || r.processing_status === 'succeeded') continue
    changes.push({
      id: r.id,
      title: r.title,
      series: seriesOf(r),
      duplicate_of: null,
      skip_reason: p.essentials
        ? 're-cut (Essentials): full episodes only; the full episode is not in the library'
        : `${p.repost}: full episodes only; the original is not in the library`,
      facts: r.facts ?? 0,
      processing_status: r.processing_status ?? null,
      alreadyApplied: r.processing_status === 'skipped' && !r.duplicate_of,
      group: null,
    })
  }

  // Looks alike but undecided: never inside a group, listed for a person.
  const similar: { a: CleanupRow; b: CleanupRow }[] = []
  const byShow = new Map<string, CleanupRow[]>()
  for (const r of rows) if (!inGroup.has(r.id)) byShow.set(seriesOf(r), [...(byShow.get(seriesOf(r)) ?? []), r])
  for (const list of byShow.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = parseEpisodeTitle(list[i].title)
        const y = parseEpisodeTitle(list[j].title)
        if (x.essentials || y.essentials) continue
        if (looksSimilar(list[i], list[j])) similar.push({ a: list[i], b: list[j] })
      }
    }
  }
  return { groups, changes, similar }
}
