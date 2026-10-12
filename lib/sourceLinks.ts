/**
 * Public links for a source (episode), in one place.
 *
 * `sources.url` is NOT a public link. For the podcast-feed rows it is the
 * Supercast URL from Paul's private, keyed member feed — a members-only
 * address that is treated as a credential: never rendered, linked, or shipped
 * to the browser. (The stored URLs carry no key parameter today; the rule is
 * about the feed, not the string.) Every page that used to link `source.url`
 * now goes through `episodeLinks()` instead, which only ever returns:
 *
 *   1. `article_url`  → "Episode page"  (the public show-notes page)
 *   2. `youtube_url`  → "YouTube"       (the public video; a public YouTube
 *                                        `url` counts too — the 240-odd rows
 *                                        ingested from YouTube before the feed
 *                                        existed carry the video there)
 *   3. otherwise a search on peterattiamd.com for the episode number
 *      (`#405`) or, failing that, the title → "Find on peterattiamd.com"
 *
 * Pure: no imports, no I/O. Tested in tests/sourceLinks.test.ts.
 */

export type SourceLinkInput = {
  url?: string | null
  youtube_url?: string | null
  article_url?: string | null
  episode_number?: number | string | null
  title?: string | null
}

export type EpisodeLinkKind = 'article' | 'video' | 'search'

export type EpisodeLink = {
  kind: EpisodeLinkKind
  label: string
  href: string
}

export const EPISODE_SEARCH_BASE = 'https://peterattiamd.com/?s='

/** A Supercast feed URL: the private member feed, never to be shown. */
export function isPrivateFeedUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /supercast/i.test(url)
}

/** A non-empty, non-private http(s) URL — the only kind we will ever render. */
export function isPublicUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  return !isPrivateFeedUrl(trimmed)
}

export function isYouTubeUrl(url: string | null | undefined): boolean {
  return isPublicUrl(url) && /(^|\/\/)(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url.trim())
}

/**
 * The public video for a source, if we know one: `youtube_url` first, else a
 * `url` that is itself a public YouTube link. Null otherwise — and always null
 * for a private feed URL, whatever column it sits in.
 */
export function publicVideoUrl(input: SourceLinkInput): string | null {
  if (isPublicUrl(input.youtube_url)) return input.youtube_url.trim()
  if (isYouTubeUrl(input.url)) return (input.url as string).trim()
  return null
}

/** The public episode page (show notes). Only ever `article_url`. */
export function publicArticleUrl(input: SourceLinkInput): string | null {
  return isPublicUrl(input.article_url) ? input.article_url.trim() : null
}

/**
 * Search on peterattiamd.com: by episode number (`#405`) when there is one,
 * otherwise by title. Null when there is nothing to search for.
 */
export function episodeSearchUrl(input: SourceLinkInput): string | null {
  const n = input.episode_number
  const hasNumber = n !== null && n !== undefined && String(n).trim() !== '' && Number.isFinite(Number(n))
  const query = hasNumber ? `#${Number(n)}` : (input.title ?? '').trim()
  if (!query) return null
  return `${EPISODE_SEARCH_BASE}${encodeURIComponent(query)}`
}

/**
 * The links to show for a source, in display order. Both "Episode page" and
 * "YouTube" appear when both exist; the search link appears only when neither
 * does. Never contains a private feed URL.
 */
export function episodeLinks(input: SourceLinkInput): EpisodeLink[] {
  const links: EpisodeLink[] = []
  const article = publicArticleUrl(input)
  if (article) links.push({ kind: 'article', label: 'Episode page', href: article })
  const video = publicVideoUrl(input)
  if (video) links.push({ kind: 'video', label: 'YouTube', href: video })
  if (links.length > 0) return links
  const search = episodeSearchUrl(input)
  return search ? [{ kind: 'search', label: 'Find on peterattiamd.com', href: search }] : []
}

/** The first (best) public link, for places that can only show one. */
export function primaryEpisodeLink(input: SourceLinkInput): EpisodeLink | null {
  return episodeLinks(input)[0] ?? null
}
