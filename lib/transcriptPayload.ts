/**
 * What the readable-transcript pop-up and the full transcript page both need
 * about a source, built once from the `sources` row. The private feed URL
 * (`sources.url`, the members-only Supercast link) is consumed here on the
 * server and never leaves: only the public links come out.
 *
 * Pure apart from its imports of the two pure helpers.
 */

import { episodeLinks, publicVideoUrl, type EpisodeLink } from './sourceLinks'
import { buildTranscriptView, type TranscriptView } from './transcriptView'

/** The columns the transcript views read — no `select('*')`, the row is big enough. */
export const TRANSCRIPT_SOURCE_COLUMNS =
  'id, title, episode_number, url, youtube_url, article_url, transcript, timed_transcript, transcript_origin'

export type TranscriptSourceRow = {
  id: string
  title: string | null
  episode_number: number | null
  url: string | null
  youtube_url: string | null
  article_url: string | null
  transcript: string | null
  timed_transcript: unknown
  transcript_origin: string | null
}

export type TranscriptPayload = {
  id: string
  title: string | null
  episode_number: number | null
  transcript_origin: string | null
  /** Public links only — see lib/sourceLinks.ts. */
  links: EpisodeLink[]
  /** The public video, for timestamp deep-links. Null when unknown. */
  videoUrl: string | null
  view: TranscriptView
}

export function buildTranscriptPayload(row: TranscriptSourceRow): TranscriptPayload {
  return {
    id: row.id,
    title: row.title,
    episode_number: row.episode_number,
    transcript_origin: row.transcript_origin,
    links: episodeLinks(row),
    videoUrl: publicVideoUrl(row),
    view: buildTranscriptView(row),
  }
}

/** `#405 · Title` when there is a number, else the title (or a placeholder). */
export function transcriptHeading(payload: Pick<TranscriptPayload, 'title' | 'episode_number'>): string {
  const title = (payload.title ?? '').trim() || 'Untitled source'
  if (payload.episode_number === null || payload.episode_number === undefined) return title
  const prefix = `#${payload.episode_number}`
  return title.startsWith(prefix) ? title : `${prefix} · ${title}`
}
