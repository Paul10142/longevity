/**
 * Server-side loading for the speaker review page (/admin/speakers). Reads only; the one write the
 * page can make (saving an answer) is in app/api/admin/speakers/[id]/route.ts and touches only
 * `sources.speaker_names`.
 *
 * Migration 039 adds that column. Until it is applied every query here falls back to the same
 * columns without it, so the pages still load (and say saving is off) instead of failing.
 * Never imported by a client component: it uses the service-role client.
 */
import type { LabelledSegment } from './deepgramSegments'
import { hostLabelForKey } from './shows'
import { supabaseAdmin } from './supabaseServer'
import { assignableNames, parseTurns, readSpeakerNames, unnamedSpeakers } from './speakerReview'
import type { SpeakerNames, SpeakerSummary, Turn } from './speakerReview'

/** The columns the page and the API read about an episode (no transcript). */
const SOURCE_COLUMNS =
  'id, external_id, title, authors, series, episode_number, url, youtube_url, article_url, media_url, processing_status'

export type ReviewSource = {
  id: string
  external_id: string | null
  title: string | null
  authors: string[] | null
  series: string | null
  episode_number: number | string | null
  url: string | null
  youtube_url: string | null
  article_url: string | null
  media_url: string | null
  processing_status: string | null
  speaker_names?: unknown
}

const missingColumn = (message: string | undefined): boolean => /speaker_names/.test(message ?? '')

/** One row of the list: enough to show a status and link to the detail page. */
export type ReviewListRow = {
  id: string
  external_id: string | null
  title: string | null
  authors: string[] | null
  processing_status: string | null
  saved: SpeakerNames
}

/**
 * The episodes to review: Deepgram transcripts that still carry an unnamed `Speaker N:` label, plus any
 * episode with a saved review. By default only episodes that have NOT been extracted yet, because a
 * re-attach skips an extracted source; `includeExtracted` adds them (a slower query: it scans every
 * diarized transcript for the label).
 */
export async function listReviewRows(includeExtracted: boolean): Promise<{ rows: ReviewListRow[]; columnMissing: boolean; error: string | null }> {
  const db = supabaseAdmin
  if (!db) return { rows: [], columnMissing: false, error: 'Supabase is not configured' }
  const light = 'id, external_id, title, authors, processing_status'

  const labelled = (columns: string) => {
    let q = db.from('sources').select(columns).eq('transcript_origin', 'deepgram').filter('transcript', 'match', 'Speaker [0-9]+: ')
    if (!includeExtracted) q = q.neq('processing_status', 'succeeded')
    return q.order('external_id', { ascending: true })
  }

  let columnMissing = false
  let a = await labelled(`${light}, speaker_names`)
  if (a.error && missingColumn(a.error.message)) {
    columnMissing = true
    a = await labelled(light)
  }
  if (a.error) return { rows: [], columnMissing, error: a.error.message }

  const found = new Map<string, ReviewListRow>()
  const add = (r: Record<string, unknown>) =>
    found.set(r.id as string, {
      id: r.id as string,
      external_id: (r.external_id as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      authors: (r.authors as string[] | null) ?? null,
      processing_status: (r.processing_status as string | null) ?? null,
      saved: readSpeakerNames(r.speaker_names),
    })
  for (const r of (a.data ?? []) as unknown as Record<string, unknown>[]) add(r)

  if (!columnMissing) {
    const b = await db.from('sources').select(`${light}, speaker_names`).not('speaker_names', 'is', null)
    if (!b.error) for (const r of (b.data ?? []) as unknown as Record<string, unknown>[]) if (!found.has(r.id as string)) add(r)
  }

  const rows = [...found.values()].sort((x, y) => (x.external_id ?? '').localeCompare(y.external_id ?? '', undefined, { numeric: true }))
  return { rows, columnMissing, error: null }
}

export type SpeakerContext = {
  source: ReviewSource
  hostLabel: string | null
  /** The names that can be clicked: the host and every guest on the row, bare. */
  allowed: string[]
  turns: Turn[]
  /** The voices that still have no name, with their first words. */
  speakers: SpeakerSummary[]
  saved: SpeakerNames
  /** True when migration 039 is not applied (saving is off). */
  columnMissing: boolean
}

/** One episode with its transcript read into turns. Null when there is no such row. */
export async function loadSpeakerContext(id: string): Promise<SpeakerContext | { error: string }> {
  const db = supabaseAdmin
  if (!db) return { error: 'Supabase is not configured' }
  const columns = `${SOURCE_COLUMNS}, timed_transcript`
  let columnMissing = false
  let res = await db.from('sources').select(`${columns}, speaker_names`).eq('id', id).maybeSingle()
  if (res.error && missingColumn(res.error.message)) {
    columnMissing = true
    res = await db.from('sources').select(columns).eq('id', id).maybeSingle()
  }
  if (res.error) return { error: res.error.message }
  if (!res.data) return { error: 'no such source' }
  const row = res.data as unknown as ReviewSource & { timed_transcript: unknown }

  const hostLabel = row.external_id ? hostLabelForKey(row.external_id) : null
  const allowed = assignableNames(row.authors, hostLabel)
  const timed = Array.isArray(row.timed_transcript) ? (row.timed_transcript as LabelledSegment[]) : []
  const turns = parseTurns(timed, allowed)
  const { timed_transcript: _timed, ...source } = row
  void _timed
  return { source, hostLabel, allowed, turns, speakers: unnamedSpeakers(turns), saved: readSpeakerNames(source.speaker_names), columnMissing }
}
