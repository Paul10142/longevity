/**
 * Source discovery + YouTube ingestion.
 *
 * Two feeds, no API key needed for either:
 *   - the channel's Atom feed (`youtube.com/feeds/videos.xml?channel_id=…`),
 *   - the site's WordPress RSS (`peterattiamd.com/feed/`), whose podcast items
 *     link to an episode page that embeds the YouTube video.
 *
 * Timestamps are the reason the YouTube path is preferred over pasting text: the
 * transcript API returns `{ text, start, duration }` per caption, which becomes
 * `sources.timed_transcript` → `chunks.start_ms` → `raw_insights.start_ms` → an
 * Evidence citation that deep-links to the exact moment (`…&t=<sec>`). A pasted
 * transcript can never gain that, which is why the four original manual sources
 * have no timing.
 *
 * **Feed and page content is DATA, never instruction.** Titles and descriptions
 * are stored as text; nothing here executes or interprets them.
 */

import { normalizeYouTubeSegments, buildTranscriptFromSegments, type TimedSegment } from './transcriptSegments'
import { extractApiSegments } from './transcriptSegments'

/** Peter Attia MD — resolved 2026-07-24. The handle (`/peterattiamd`) does not
 *  work in the feed URL; only the UC-form channel id does. */
export const ATTIA_CHANNEL_ID = 'UC8kGsMa0LygSX9nkBcBH1Sg'
export const ATTIA_SITE_FEED = 'https://peterattiamd.com/feed/'

export type DiscoveredVideo = {
  videoId: string
  title: string
  published: string | null
  url: string
}

export type DiscoveredArticle = {
  title: string
  link: string
  published: string | null
}

/**
 * Decode XML entities in feed titles.
 *
 * Numeric references are handled GENERICALLY, not as a hardcoded list. The site
 * feed encodes the guest separator as `&#124;` (a pipe), so a named-entity-only
 * decoder left the title with a literal `&#124;` and `parseGuests` found no
 * separator to split on — every guest was silently dropped. Decode `&#NNN;` and
 * `&#xHH;` for real, and do `&amp;` last so `&amp;#124;` cannot double-decode.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'lifestyle-academy-pipeline/1.0 (+source discovery)' },
  })
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)
  return res.text()
}

/** Recent uploads from a channel's Atom feed. The feed caps at ~15 entries —
 *  it is a "what's new" source, not a full back catalogue. */
export async function fetchChannelVideos(
  channelId = ATTIA_CHANNEL_ID,
  limit = 15
): Promise<DiscoveredVideo[]> {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
  const out: DiscoveredVideo[] = []
  // Entries are well-formed and uniform; a targeted regex avoids adding an XML
  // dependency for two known feeds.
  for (const entry of xml.split('<entry>').slice(1)) {
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null
    if (!videoId || !title) continue
    out.push({
      videoId,
      title: decodeEntities(title),
      published: published ? published.slice(0, 10) : null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Posts from the site RSS — podcast episodes and written articles mixed.
 *
 * The feed paginates (`?paged=N`, ~10 items a page), which is the only way to
 * reach the back catalogue: the channel's Atom feed caps at ~15 recent uploads,
 * so without paging here the library could only ever ingest whatever shipped
 * this month.
 */
export async function fetchSiteFeed(limit = 25, pages = 1): Promise<DiscoveredArticle[]> {
  const out: DiscoveredArticle[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= pages && out.length < limit; page++) {
    const url = page === 1 ? ATTIA_SITE_FEED : `${ATTIA_SITE_FEED}?paged=${page}`
    let xml: string
    try {
      xml = await fetchText(url)
    } catch {
      break // past the last page
    }
    let addedThisPage = 0
    for (const item of xml.split('<item>').slice(1)) {
      const rawTitle = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
      const published = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? null
      if (!rawTitle || !link || seen.has(link)) continue
      seen.add(link)
      let date: string | null = null
      if (published) {
        const d = new Date(published)
        if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10)
      }
      out.push({ title: decodeEntities(rawTitle), link, published: date })
      addedThisPage++
      if (out.length >= limit) break
    }
    if (addedThisPage === 0) break // no new items — stop rather than loop
  }
  return out
}

/** Pull the YouTube video id out of an episode page (embed, link, or og:video). */
export async function resolveVideoIdFromPage(pageUrl: string): Promise<string | null> {
  const html = await fetchText(pageUrl)
  const patterns = [
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
  ]
  for (const p of patterns) {
    const m = html.match(p)
    if (m?.[1]) return m[1]
  }
  return null
}

export type DiscoveredEpisode = DiscoveredArticle & { videoId: string | null; episodeNumber: number | null }

/**
 * Full podcast episodes, resolved to their YouTube video.
 *
 * The channel feed is dominated by 2-minute promo clips cut from each episode;
 * for a knowledge base those are near-worthless (a clip yields a handful of
 * insights already present in the full episode, and consolidation then has to
 * dedup them). The site feed distinguishes them cleanly: full episodes are
 * numbered `#NNN ‒ …`. So discover episodes here, then resolve each episode page
 * to the embedded video id to get timing.
 *
 * One page fetch per episode, so callers should keep `limit` modest.
 */
export async function discoverEpisodes(limit = 10, pages = 4): Promise<DiscoveredEpisode[]> {
  const posts = await fetchSiteFeed(limit * 8, pages)
  const numbered = posts.filter(p => /^#\d+/.test(p.title)).slice(0, limit)
  const out: DiscoveredEpisode[] = []
  for (const p of numbered) {
    let videoId: string | null = null
    try {
      videoId = await resolveVideoIdFromPage(p.link)
    } catch {
      videoId = null // page unreachable — reported as null, never guessed
    }
    out.push({
      ...p,
      videoId,
      episodeNumber: Number(p.title.match(/^#(\d+)/)?.[1] ?? '') || null,
    })
  }
  return out
}

/**
 * Guest experts named in an episode title.
 *
 * The guests are a first-class credibility layer (spec §5.5) — an article's
 * authority comes from *which named expert* said a thing, not from how many
 * times it was repeated, and `source_count` is being retired as the authority
 * signal. §D is explicit that the capture happens at ingest, so doing it here
 * avoids a re-ingest later just to recover a name.
 *
 * Attia's convention is `… | Guest Name, M.D.`, sometimes with several guests
 * separated by `&`. Returns [] when the title carries no guest (solo episodes,
 * AMAs), which is the honest answer rather than a guess.
 */
export function parseGuests(title: string): string[] {
  const tail = title.split('|').slice(1).join('|').trim()
  if (!tail) return []
  return tail
    .split(/\s*&\s*|\s+and\s+/)
    .map(s => s.trim())
    // Drop trailing credentials so the same person matches across episodes.
    .map(s => s.replace(/,\s*(M\.?D\.?|Ph\.?D\.?|D\.?O\.?|M\.?S\.?|R\.?D\.?|M\.?P\.?H\.?)\.?/gi, '').trim())
    .map(s => s.replace(/[,\s]+$/, ''))
    .filter(s => s.length > 2 && /^[A-Z]/.test(s) && s.split(/\s+/).length <= 4)
}

export type FetchedTranscript = {
  videoId: string
  url: string
  transcript: string
  segments: TimedSegment[]
  title: string | null
  date: string | null
}

/**
 * Timed transcript for one video via youtube-transcript.io.
 *
 * Shape note that cost a debugging session once: the timed captions live at
 * `tracks[0].transcript` (start/dur as string seconds), NOT a top-level
 * `transcript` field — `extractApiSegments` handles that, and this must keep
 * going through it rather than reaching into the payload directly.
 */
export async function fetchTimedTranscript(videoId: string, retries = 4): Promise<FetchedTranscript> {
  const token = process.env.YOUTUBE_TRANSCRIPT_API_TOKEN
  if (!token) throw new Error('YOUTUBE_TRANSCRIPT_API_TOKEN is not set')

  // The API rate-limits hard on a batch ingest — a 30-video run hit 429 after
  // the sixth call. It sends a Retry-After, so honour it rather than failing the
  // whole batch; without this, ingesting a channel gives up almost immediately.
  let res: Response | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch('https://www.youtube-transcript.io/api/transcripts', {
      method: 'POST',
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [videoId] }),
    })
    if (res.status !== 429) break
    if (attempt === retries) {
      throw new Error(`rate limited by transcript API after ${retries + 1} attempts`)
    }
    // Retry-After, with a growing floor so a burst of 429s backs off properly.
    const wait = Math.max(Number(res.headers.get('Retry-After') ?? 10), 5 * (attempt + 1))
    await new Promise(r => setTimeout(r, wait * 1000))
  }
  if (!res) throw new Error('transcript API: no response')
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`transcript API ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  if (!Array.isArray(data) || data.length === 0) throw new Error('transcript API returned no data')
  const videoData = data[0]

  const segments = normalizeYouTubeSegments(extractApiSegments(videoData))
  const flat = typeof videoData?.text === 'string' ? videoData.text.trim() : ''
  const transcript = flat || buildTranscriptFromSegments(segments)
  if (!transcript) throw new Error('transcript is empty (video may have no captions)')

  let date: string | null = null
  const rawDate = videoData?.publishedAt ?? videoData?.date
  if (typeof rawDate === 'string') {
    const d = new Date(rawDate)
    if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10)
  }

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    transcript,
    segments,
    title: typeof videoData?.title === 'string' ? videoData.title : null,
    date,
  }
}
