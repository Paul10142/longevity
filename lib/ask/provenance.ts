/**
 * Stage 3 — provenance (design §5). No model calls.
 *
 * Two jobs, both cheap and both reading only:
 *
 *  - BEFORE composing: which candidates contradict each other (`claim_links`
 *    kind 'contradicts'), so the composer is told which pairs to put under
 *    "Where experts differ" instead of rediscovering them.
 *  - AFTER composing: for the claims the brief actually cites, one
 *    representative member each (quote, speaker, episode, date, timestamp), the
 *    episodes ranked by how many citations they carry ("Go deeper"), and the
 *    nearest public topic pages ("Related pages").
 *
 * Only public links ever leave this module (`lib/sourceLinks`); `sources.url` is
 * the private member feed.
 */

import { supabaseAdmin } from '../supabaseServer'
import { selectAllPaged } from '../pagination'
import { episodeLinks, publicVideoUrl, type EpisodeLink } from '../sourceLinks'
import { isVisibleCount, subtreeClaimCounts } from '../topicVisibility'
import type { RelatedTopic } from './types'

/** PostgREST puts `in (...)` into the URL; 40 uuids stays well under any proxy limit. */
const IN_CHUNK = 40

export function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// --- contradictions ---------------------------------------------------------

export type ContradictionPair = [string, string]

/** `contradicts` links whose two ends are both in `ids`. */
export async function loadContradictions(ids: string[]): Promise<ContradictionPair[]> {
  if (ids.length < 2) return []
  const inSet = new Set(ids)
  const seen = new Set<string>()
  const out: ContradictionPair[] = []
  for (const part of chunk(ids)) {
    const rows = await selectAllPaged<{ claim_id: string; related_claim_id: string }>((from, to) =>
      supabaseAdmin
        .from('claim_links')
        .select('claim_id, related_claim_id')
        .eq('kind', 'contradicts')
        .in('claim_id', part)
        .order('claim_id', { ascending: true })
        .order('related_claim_id', { ascending: true })
        .range(from, to)
    )
    for (const r of rows) {
      if (!inSet.has(r.related_claim_id)) continue
      const key = `${r.claim_id}|${r.related_claim_id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([r.claim_id, r.related_claim_id])
    }
  }
  return out
}

// --- evidence for the cited claims -----------------------------------------

export type EpisodeRef = {
  source_id: string
  title: string
  type: string
  episode_number: number | null
  /** YYYY-MM-DD */
  date: string | null
  links: EpisodeLink[]
  video_url: string | null
}

export type ClaimEvidence = {
  claim_id: string
  statement: string
  context: string | null
  evidence_type: string | null
  source_count: number
  /** The representative supporting quote, or null when no member carries one. */
  quote: string | null
  speaker: string | null
  start_ms: number | null
  episode: EpisodeRef | null
}

export type GoDeeperEpisode = EpisodeRef & {
  /** How many of the brief's citations this episode supports. */
  cited_count: number
  /** Printed citation numbers it supports. */
  cited_numbers: number[]
}

type MemberRow = {
  claim_id: string
  raw_insights: {
    direct_quote: string | null
    speaker: string | null
    start_ms: number | null
    confidence: string | null
    sources: {
      id: string
      title: string
      type: string
      url: string | null
      youtube_url: string | null
      article_url: string | null
      episode_number: number | null
      date: string | null
    } | null
  } | null
}

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

/** Prefer a member with a quote and a timestamp, then higher confidence, then the newest episode. */
export function pickRepresentative<T extends MemberRow>(members: T[]): T | null {
  const scored = members.filter(m => m.raw_insights)
  if (scored.length === 0) return null
  const key = (m: T) => {
    const ri = m.raw_insights!
    return [
      ri.direct_quote ? 0 : 1,
      ri.start_ms != null ? 0 : 1,
      CONFIDENCE_RANK[ri.confidence ?? ''] ?? 3,
      // newest first: invert by sorting on the negated ISO string below
    ] as const
  }
  return scored.sort((a, b) => {
    const ka = key(a), kb = key(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    const da = a.raw_insights!.sources?.date ?? ''
    const db = b.raw_insights!.sources?.date ?? ''
    return da < db ? 1 : da > db ? -1 : 0
  })[0]
}

function episodeOf(s: NonNullable<NonNullable<MemberRow['raw_insights']>['sources']>): EpisodeRef {
  return {
    source_id: s.id,
    title: s.title,
    type: s.type,
    episode_number: s.episode_number,
    date: s.date ? String(s.date).slice(0, 10) : null,
    links: episodeLinks(s),
    video_url: publicVideoUrl(s),
  }
}

/** One representative member per claim, plus the claim's own columns. */
export async function loadClaimEvidence(claimIds: string[]): Promise<Map<string, ClaimEvidence>> {
  const out = new Map<string, ClaimEvidence>()
  if (claimIds.length === 0) return out

  type ClaimRow = {
    id: string
    canonical_statement: string
    context_note: string | null
    best_evidence_type: string | null
    source_count: number | null
  }
  const claims: ClaimRow[] = []
  const members: MemberRow[] = []
  for (const part of chunk(claimIds, 25)) {
    const { data, error } = await supabaseAdmin
      .from('claims')
      .select('id, canonical_statement, context_note, best_evidence_type, source_count')
      .in('id', part)
    if (error) throw new Error(`claims read failed: ${error.message}`)
    claims.push(...((data ?? []) as ClaimRow[]))
    members.push(
      ...(await selectAllPaged<MemberRow>((from, to) =>
        supabaseAdmin
          .from('claim_members')
          .select(
            `claim_id, raw_insight_id,
             raw_insights ( direct_quote, speaker, start_ms, confidence,
               sources ( id, title, type, url, youtube_url, article_url, episode_number, date ) )`
          )
          .in('claim_id', part)
          .order('claim_id', { ascending: true })
          .order('raw_insight_id', { ascending: true })
          .range(from, to)
      ))
    )
  }

  const byClaim = new Map<string, MemberRow[]>()
  for (const m of members) {
    const list = byClaim.get(m.claim_id) ?? []
    list.push(m)
    byClaim.set(m.claim_id, list)
  }
  for (const c of claims) {
    const rep = pickRepresentative(byClaim.get(c.id) ?? [])
    const ri = rep?.raw_insights ?? null
    out.set(c.id, {
      claim_id: c.id,
      statement: c.canonical_statement,
      context: c.context_note,
      evidence_type: c.best_evidence_type,
      source_count: c.source_count ?? 0,
      quote: ri?.direct_quote ?? null,
      speaker: ri?.speaker ?? null,
      start_ms: ri?.start_ms ?? null,
      episode: ri?.sources ? episodeOf(ri.sources) : null,
    })
  }
  return out
}

/** "Go deeper": the episodes behind the brief, most-cited first. `order` is the printed numbering. */
export function rankEpisodes(order: string[], evidence: Map<string, ClaimEvidence>): GoDeeperEpisode[] {
  const bySource = new Map<string, GoDeeperEpisode>()
  order.forEach((claimId, i) => {
    const ep = evidence.get(claimId)?.episode
    if (!ep) return
    const hit = bySource.get(ep.source_id) ?? { ...ep, cited_count: 0, cited_numbers: [] }
    hit.cited_count++
    hit.cited_numbers.push(i + 1)
    bySource.set(ep.source_id, hit)
  })
  return [...bySource.values()].sort(
    (a, b) => b.cited_count - a.cited_count || (b.date ?? '').localeCompare(a.date ?? '')
  )
}

// --- related topic pages ----------------------------------------------------

type TopicRow = { id: string; name: string; slug: string; parent_id: string | null; claim_count: number | null; is_hidden: boolean | null }

/** Nearest topics the public site actually shows (subtree past the visibility threshold). */
export async function loadRelatedTopics(questionEmbedding: number[], limit = 3): Promise<RelatedTopic[]> {
  const { data: near, error } = await supabaseAdmin.rpc('match_topics', {
    query_embedding: questionEmbedding,
    match_threshold: 0.3,
    match_count: 15,
  })
  if (error) throw new Error(`match_topics failed: ${error.message}`)
  const hits = (near ?? []) as { id: string; name: string; slug: string; similarity: number }[]
  if (hits.length === 0) return []

  // Visibility needs subtree counts, so it needs the whole (small) tree.
  const rows = await selectAllPaged<TopicRow>((from, to) =>
    supabaseAdmin
      .from('topics')
      .select('id, name, slug, parent_id, claim_count, is_hidden')
      .eq('status', 'active')
      .order('id', { ascending: true })
      .range(from, to)
  )
  const counts = subtreeClaimCounts(rows)
  const hidden = new Map(rows.map(r => [r.id, r.is_hidden]))
  return hits
    .filter(h => isVisibleCount(counts.get(h.id) ?? 0, hidden.get(h.id)))
    .slice(0, limit)
    .map(h => ({ id: h.id, name: h.name, slug: h.slug, similarity: h.similarity }))
}
