/**
 * Utility functions for working with YouTube URLs and video IDs
 */

/**
 * Extracts YouTube video ID from various YouTube URL formats
 * Supports:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - https://www.youtube.com/v/VIDEO_ID
 * - https://m.youtube.com/watch?v=VIDEO_ID
 * - https://youtube.com/watch?v=VIDEO_ID
 */
export function extractYouTubeVideoId(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null
  }

  // Remove any whitespace
  url = url.trim()

  // Pattern 1: youtube.com/watch?v=VIDEO_ID or youtube.com/embed/VIDEO_ID
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/v\/|youtu\.be\/|m\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    // Also handle URLs with additional parameters
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ]

  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match && match[1]) {
      return match[1]
    }
  }

  // If the URL is just a video ID (11 characters, alphanumeric + _ and -)
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url
  }

  return null
}

/**
 * Validates if a string is a valid YouTube URL or video ID
 */
export function isValidYouTubeUrl(url: string): boolean {
  return extractYouTubeVideoId(url) !== null
}

/**
 * Build a "jump to the moment" YouTube deep-link from a source URL and a
 * millisecond offset. Returns null unless BOTH the URL is a YouTube URL and a
 * numeric `start_ms` is present — the two conditions the Evidence deep-link
 * requires. Seconds are floored from `start_ms`; the `t` param is appended with
 * `&` when the URL already has a query (e.g. `?v=...`) and `?` otherwise.
 */
export function youtubeTimestampUrl(
  url: string | null | undefined,
  start_ms: number | null | undefined
): string | null {
  if (!url || typeof url !== 'string') return null
  if (start_ms == null || !Number.isFinite(start_ms)) return null
  if (!isValidYouTubeUrl(url)) return null
  const seconds = Math.max(0, Math.floor(start_ms / 1000))
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}t=${seconds}`
}
