import { createHash } from 'node:crypto'

/**
 * Podcast RSS reading, shared by the audio downloader and the source ingest.
 *
 * A dependency-free reader is deliberate: podcast RSS is a flat, predictable
 * shape and adding an XML parser to the app's bundle for two offline scripts is
 * not worth it. Only the fields below are read; anything else is ignored.
 *
 * SECRETS: a paid feed's URL is a credential, and for Supercast the same key is
 * repeated inside every guid and enclosure URL. `redact()` exists so nothing
 * derived from a feed can carry the key into a database row, a log line, or an
 * error message. `Episode.audio_url` is the ONE field that keeps it — it has to,
 * to download — so it must never be persisted.
 */

/** Strip a membership key from anything persisted, logged, or thrown. */
export function redact(s: string): string {
  return s.replace(/([?&](?:key|token|auth)=)[^&\s"']+/gi, '$1<redacted>')
}

export type Episode = {
  /** Stable base filename, no extension: the join key across audio, transcript, and DB row. */
  key: string
  title: string
  /** Show episode number when the title carries one. */
  episode_number: number | null
  /** Guests parsed from the title; empty for AMAs and solo episodes. */
  guests: string[]
  /** ISO date, or null when the feed omits/garbles pubDate. */
  published_at: string | null
  duration_seconds: number | null
  /** Verbatim <description> — usually the timestamped topic outline. */
  description: string | null
  /** Episode page URL, key stripped. Safe to store. */
  page_url: string | null
  /** Feed guid, key stripped. Stable across re-runs. Safe to store. */
  guid: string
  /** CARRIES THE MEMBERSHIP KEY. Use to download; never persist or print. */
  audio_url: string
  audio_bytes: number | null
  file: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? decodeEntities(m[1]) : null
}

/** "01:13:59" | "44:10" | "2650" → seconds. Empty/zero reads as MISSING, not 0:
 *  only 174 of the Attia feed's 425 items carry the tag, and treating the rest
 *  as zero once under-reported the catalogue by half. */
export function parseDuration(raw: string | null): number | null {
  if (!raw || !raw.trim()) return null
  const parts = raw.split(':').map(p => Number(p.trim()))
  if (parts.some(n => !Number.isFinite(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2] || null
  if (parts.length === 2) return parts[0] * 60 + parts[1] || null
  if (parts.length === 1) return parts[0] || null
  return null
}

/**
 * Guests from the title. This show titles interviews as
 * `#404 ‒ Topic… | Linus Abrams, M.D.`, so the segment after the final pipe is
 * the guest list — 137 of 425 episodes. AMAs (100 of them) have no guest and
 * must return empty rather than a guessed name: a wrong attribution is worse
 * than none, because corroboration counts DISTINCT SPEAKERS and a phantom guest
 * would invent agreement that never happened.
 */
export function parseGuests(title: string): string[] {
  if (!title.includes('|')) return []
  const tail = title.split('|').pop()?.trim() ?? ''
  if (!tail || /^AMA\b/i.test(tail)) return []
  return tail
    .split(/\s*(?:,|&|\band\b)\s*(?=[A-Z])/)
    .map(g => g.trim())
    .filter(g => g.length > 1 && /[A-Za-z]/.test(g) && !/^(m\.?d\.?|ph\.?d\.?|r\.?d\.?)$/i.test(g))
}

export function parseEpisodeNumber(title: string): number | null {
  const m = title.match(/#\s*(\d{1,4})/)
  return m ? Number(m[1]) : null
}

/**
 * Build the join key. Episode numbers are preferred — they are what a human
 * recognises and what the show notes are filed under — but are not guaranteed
 * unique or present, so a guid-derived suffix disambiguates. Never derive the
 * key from the title alone: feed titles get edited, which would silently orphan
 * an already-transcribed file.
 */
function guidFingerprint(guid: string): string {
  // MUST hash the WHOLE guid. The first version sliced the guid's TAIL, but a
  // Supercast guid ends with `?key=<membership key>` — the SAME key on every
  // episode — so the "unique" suffix was identical for all 425 items and
  // disambiguated nothing: five distinct episodes all collapsed onto
  // `attia-g784d4b`, then onto `attia-g784d4b-784d4b`, and the database's unique
  // index (correctly) rejected them.
  return createHash('sha1').update(guid).digest('hex').slice(0, 6)
}

function buildKey(prefix: string, title: string, guid: string, seen: Set<string>): string {
  const num = parseEpisodeNumber(title)
  const fp = guidFingerprint(guid)
  let key = num ? `${prefix}-${String(num).padStart(4, '0')}` : `${prefix}-g${fp}`
  // Rebroadcasts legitimately repeat an episode number, so a collision is
  // expected rather than exceptional. The fingerprint is per-guid, so appending
  // it always separates them; the counter is a belt-and-braces guard so this
  // function can never return a duplicate no matter what the feed does.
  if (seen.has(key)) {
    key = `${key}-${fp}`
    for (let n = 2; seen.has(key); n++) key = `${prefix}-${String(num ?? 0).padStart(4, '0')}-${fp}-${n}`
  }
  seen.add(key)
  return key
}

export function parseFeed(xml: string, prefix: string): Episode[] {
  const out: Episode[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]
    const enclosure = block.match(/<enclosure\b[^>]*>/i)?.[0] ?? ''
    const audio_url = enclosure.match(/url\s*=\s*"([^"]+)"/i)?.[1] ?? ''
    if (!audio_url) continue // no audio → nothing to transcribe

    const lengthAttr = Number(enclosure.match(/length\s*=\s*"(\d+)"/i)?.[1])
    const title = tag(block, 'title') ?? '(untitled)'
    const guid = tag(block, 'guid') ?? audio_url
    const pub = tag(block, 'pubDate')
    const parsedDate = pub ? new Date(pub) : null
    const key = buildKey(prefix, title, guid, seen)
    const redactedGuid = redact(guid)

    out.push({
      key,
      title,
      episode_number: parseEpisodeNumber(title),
      guests: parseGuests(title),
      published_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      duration_seconds: parseDuration(tag(block, 'itunes:duration')),
      description: tag(block, 'description'),
      page_url: /^https?:/i.test(redactedGuid) ? redactedGuid.split('?')[0] : null,
      guid: redactedGuid,
      audio_url,
      audio_bytes: Number.isFinite(lengthAttr) ? lengthAttr : null,
      file: `${key}.mp3`,
    })
  }
  return out
}

/**
 * Total audio across a feed. Must NOT come from <itunes:duration> alone — see
 * parseDuration. Falls back to enclosure bytes at the observed constant bitrate,
 * which every item has, and reports how much was estimated so a caller can say
 * which figure is measured and which inferred.
 */
export function totalHours(eps: Episode[], bitrateBps = 128_000): { hours: number; estimated: number } {
  let secs = 0
  let estimated = 0
  for (const e of eps) {
    if (e.duration_seconds) secs += e.duration_seconds
    else if (e.audio_bytes) { secs += (e.audio_bytes * 8) / bitrateBps; estimated++ }
  }
  return { hours: secs / 3600, estimated }
}
