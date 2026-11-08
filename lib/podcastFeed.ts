import { createHash } from 'node:crypto'

import { ASSUMED_BITRATE_BPS, estimateHours } from './deepgramBudget'
import { isCredentialOnly, splitName } from './personName'
import { showByPrefix } from './shows'

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
  /** Show episode number when the title carries one AND the show numbers its episodes (lib/shows.ts). */
  episode_number: number | null
  /** Guests parsed from the title, never the host; empty for AMAs and solo episodes. */
  guests: string[]
  /** ISO date, or null when the feed omits/garbles pubDate. */
  published_at: string | null
  duration_seconds: number | null
  /** Verbatim <description> — usually the timestamped topic outline. */
  description: string | null
  /** Episode page URL (the item's <link>, else a URL-shaped guid), key stripped. Safe to store. */
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
 * Lowercase connective words. A guest's name never contains one, a topic phrase
 * almost always does — which is how `Metformin for Longevity & the Power of
 * Belief Effects` (the topic half of a `Journal Club With … | topic` title) is
 * told apart from `Linus Abrams`. Lowercase only, so a capitalised name part is
 * never mistaken for one, and `from` is not listed because `Derek from MPMD` is
 * a real guest credit on FoundMyFitness.
 */
const NOT_A_NAME_WORD = /(?:^|\s)(?:for|the|of|to|in|on|with|how|why|what|your|you|is|are|a|an|about|or)(?=\s|$)/

/** `U.S. Surgeon General Dr. Vivek Murthy` → `Dr. Vivek Murthy`. */
function dropLeadingRole(g: string): string {
  return g.replace(/^.*?\s(?=(?:Dr|Prof|Professor)\.?\s+[A-Z])/, '')
}

function looksLikeName(g: string): boolean {
  return g.length <= 60 && g.split(/\s+/).length <= 6 && !/\d/.test(g) && !NOT_A_NAME_WORD.test(g)
}

/**
 * Guests from the title. The Drive titles interviews as
 * `#404 ‒ Topic… | Linus Abrams, M.D.`, so the segment after the final pipe is
 * the guest list — 137 of 425 episodes. AMAs (100 of them) have no guest and
 * must return empty rather than a guessed name: a wrong attribution is worse
 * than none, because corroboration counts DISTINCT SPEAKERS and a phantom guest
 * would invent agreement that never happened.
 *
 * CREDENTIALS STAY ON THE NAME (Paul, 2026-11-08). A guest is returned as the title
 * writes them: `… | Sally Greenwald, M.D., M.P.H.` gives ONE guest,
 * `Sally Greenwald, M.D., M.P.H.`, not three (`Sally Greenwald`, `M.D.`, `M.P.H.`: the
 * comma split used to make the credentials guests of their own, or drop them). The
 * same goes for `Max Diehn, M.D. Ph.D.`, `Arthur Brooks Ph.D.` and `Dr. Matt Walker`.
 * A credential is never a guest and never a list item; a speaker LABEL is the bare
 * name (lib/personName.ts `bareName`), the credentialed form is what `sources.authors`
 * and the episode page carry. This is the first authors an episode gets, before any
 * Claude pass (scripts/refreshGuests.ts), so a new episode loses nothing in between.
 *
 * `strict` (FoundMyFitness, Huberman Lab — `Show.strictGuests`) adds two forms
 * the Drive never used, and both produced phantom guests before they were
 * handled. It is OFF for the Drive on purpose: its 435 feed items must parse
 * exactly as they always have, and the 25 whose titles carry `(#183
 * rebroadcast)` or `Pt. 2` keep the junk guest they have always had.
 *   `GUEST SERIES | Dr. Matt Walker: The Science of Dreams, Nightmares & …`
 *     the NAME leads the tail and a colon ends it, so the topic's commas were
 *     being read as three more guests. Only a leading honorific (`Dr.`,
 *     `Prof.`) is trusted to start a name before a colon.
 *   `Journal Club With Dr. Peter Attia | Metformin for Longevity & …`
 *     the tail is a TOPIC; a segment that reads as a phrase, not a name, is
 *     dropped, so the episode lists no guest rather than a made-up one.
 */
export function parseGuests(title: string, strict = false): string[] {
  if (!title.includes('|')) return []
  const tail = title.split('|').pop()?.trim() ?? ''
  if (!tail || /^AMA\b/i.test(tail)) return []
  const led = strict ? tail.match(/^((?:Dr|Prof|Professor)\.?\s+[^:]{2,60}):\s+\S/) : null
  // Split on `,`, `&` and `and` as always, keeping each separator: a comma followed by
  // nothing but credentials (`, M.D.`, `, M.D. Ph.D.`) is not a new guest, it goes back
  // on the name before it.
  const pieces = (led ? led[1] : tail).split(/(\s*(?:,|&|\band\b)\s*)(?=[A-Z])/)
  const names: string[] = []
  for (let i = 0; i < pieces.length; i += 2) {
    const piece = strict ? dropLeadingRole(pieces[i].trim()) : pieces[i].trim()
    if (names.length > 0 && i > 0 && pieces[i - 1].includes(',') && isCredentialOnly(piece)) {
      names[names.length - 1] += `, ${piece}`
    } else {
      names.push(piece)
    }
  }
  const kept = names.filter(g => g.length > 1 && /[A-Za-z]/.test(g) && !isCredentialOnly(g))
  // The name-shape test judges the name alone: five credentials are not "too many words".
  return strict ? kept.filter(g => looksLikeName(splitName(g).bare)) : kept
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

function buildKey(prefix: string, num: number | null, guid: string, seen: Set<string>): string {
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
  // Show-specific rules come from the registry (lib/shows.ts), keyed on the
  // prefix. An unregistered prefix behaves as the Drive always did: numbered
  // titles, no host to strip.
  const show = showByPrefix(prefix)
  const numbered = show?.numbered ?? true
  const strict = show?.strictGuests ?? false
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
    // A show that does not number its episodes gets NO number: `AMA #19: …` is
    // the 19th AMA, not episode 19, and the join key then comes from the guid.
    const episodeNumber = numbered ? parseEpisodeNumber(title) : null
    const key = buildKey(prefix, episodeNumber, guid, seen)
    const redactedGuid = redact(guid)
    // The item's own <link> is the public episode page for the public shows
    // (libsyn, megaphone). Supercast's feed has none, so its guid — which IS the
    // episode URL — stays the fallback. Same key stripping either way.
    const link = tag(block, 'link')
    const pageSource = link && /^https?:/i.test(link) ? redact(link) : redactedGuid

    out.push({
      key,
      title,
      episode_number: episodeNumber,
      // Strict shows never list the host as a guest: `#092 … | Dr. Rhonda
      // Patrick` is a solo episode, and naming the host as the guest would label
      // the second diarized speaker (usually noise) as her.
      guests: parseGuests(title, strict).filter(g => !strict || !show || !show.hostMention.test(g)),
      published_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      duration_seconds: parseDuration(tag(block, 'itunes:duration')),
      description: tag(block, 'description'),
      page_url: /^https?:/i.test(pageSource) ? pageSource.split('?')[0] : null,
      guid: redactedGuid,
      audio_url,
      // `length="0"` is "unknown", not an empty file: Megaphone (Huberman Lab)
      // writes it on all 456 items, and keeping the 0 made the downloader treat
      // every finished file as the wrong size and fetch it again.
      audio_bytes: Number.isFinite(lengthAttr) && lengthAttr > 0 ? lengthAttr : null,
      file: `${key}.mp3`,
    })
  }
  return out
}

/**
 * Total audio across a feed. Must NOT come from <itunes:duration> alone — see
 * parseDuration. Falls back to enclosure bytes at the observed constant bitrate,
 * which every item has, and reports how much was estimated so a caller can say
 * which figure is measured and which inferred. The per-episode rule itself is
 * `estimateHours` in deepgramBudget.ts, so the downloader's credit plan and
 * this total can never disagree about an episode's length.
 */
export function totalHours(eps: Episode[], bitrateBps = ASSUMED_BITRATE_BPS): { hours: number; estimated: number } {
  let hours = 0
  let estimated = 0
  for (const e of eps) {
    const est = estimateHours(e, bitrateBps)
    if (!est) continue
    hours += est.hours
    if (est.estimated) estimated++
  }
  return { hours, estimated }
}

/**
 * A `--keys` file: one join key per line (`attia-0239`), blank lines and
 * `#` comments ignored, duplicates dropped (first occurrence wins). Order is
 * kept because it is the download priority — the credit fit is greedy in it.
 */
export function parseKeyList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    // Accept a filename too: `attia-0239.mp3` and `attia-0239.deepgram.json`
    // are the same key, and a list pasted from `ls` should just work.
    const key = line.replace(/\.(mp3|m4a|wav)$/i, '').replace(/(\.[^.]+)?\.deepgram\.json$/i, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * True for a key this feed reader could have produced (`fmf-0114`,
 * `huberman-g1a2b3`, and the collision forms), false for anything else that
 * merely shares the prefix — notably the 17 FoundMyFitness rows an older
 * published-transcript path keyed `fmf-<slug>`. Those are the same episodes the
 * feed carries, under a different id, and are matched by title instead.
 */
export function isFeedKey(prefix: string, externalId: string | null | undefined): boolean {
  if (!externalId) return false
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}-(?:\\d{4,}|g[0-9a-f]{6})(?:-[0-9a-f]{6}(?:-\\d+)?)?$`).test(externalId)
}

/**
 * A title reduced to what identifies the episode: no episode number, case,
 * punctuation or spacing. Two titles with the same key are the same episode
 * published by the same show; used ONLY to avoid creating a second row for an
 * episode the library already holds under an older id.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*#\s*\d+\s*[‒–—:.-]*\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export type OlderRow = { id: string; external_id: string; title: string | null }

/**
 * Pair feed episodes with rows the library already holds for the SAME episode
 * under an older id (FoundMyFitness: `fmf-george-church` vs the feed's
 * `fmf-0077`). Two rules, tried in order, both strict:
 *   1. the titles are the same once numbers, case and punctuation are ignored;
 *   2. every word of the old id's slug (`george`, `church`; a trailing `-2` is
 *      ignored; at least two words) appears in the episode's title. Needed
 *      because the show reworded 6 of the 17 titles after the older path
 *      stored them.
 * A pair counts only when it is one-to-one: a row that fits two episodes, or an
 * episode that fits two rows, is left unmatched. Linking the wrong episode to a
 * transcript is worse than a duplicate row, so doubt means no match.
 * Returns episode key -> the older row.
 */
export function matchOlderRows<E extends { key: string; title: string }>(
  episodes: E[],
  older: OlderRow[],
  prefix: string
): Map<string, OlderRow> {
  const words = (t: string) => new Set(titleKey(t).split(' ').filter(Boolean))
  const slugWords = (id: string) =>
    id.slice(prefix.length + 1).replace(/-\d+$/, '').toLowerCase().split('-').filter(Boolean)
  const epWords = new Map(episodes.map(e => [e.key, words(e.title)]))

  const candidates = (row: OlderRow): E[] => {
    const exact = episodes.filter(e => row.title && titleKey(e.title) === titleKey(row.title))
    if (exact.length > 0) return exact
    const slug = slugWords(row.external_id)
    if (slug.length < 2) return []
    return episodes.filter(e => slug.every(w => epWords.get(e.key)!.has(w)))
  }

  const byRow = new Map<string, E[]>()
  const rowsPerEpisode = new Map<string, number>()
  for (const row of older) {
    const c = candidates(row)
    byRow.set(row.id, c)
    for (const e of c) rowsPerEpisode.set(e.key, (rowsPerEpisode.get(e.key) ?? 0) + 1)
  }
  const out = new Map<string, OlderRow>()
  for (const row of older) {
    const c = byRow.get(row.id) ?? []
    if (c.length === 1 && rowsPerEpisode.get(c[0].key) === 1) out.set(c[0].key, row)
  }
  return out
}

/**
 * The manifest a download writes next to the audio is the transcript side's map
 * from key back to guests. It used to be rewritten from scratch on every run,
 * which was fine for one show; with several shows sharing an audio folder, the
 * second show's run would wipe the first show's guests and its transcripts would
 * come back with numbered speakers instead of names. So a run replaces only ITS
 * show's entries (keys starting `<prefix>-`) and keeps everyone else's.
 */
export function mergeManifestEpisodes<T extends { key: string }>(existing: T[], prefix: string, fresh: T[]): T[] {
  return [...existing.filter(e => !e.key.startsWith(`${prefix}-`)), ...fresh]
}

/**
 * Pick exactly the episodes whose keys are listed, in LIST order. Every key
 * must exist — a typo that silently selected fewer episodes would look like a
 * finished download — and the feed's keys must be unique, which `buildKey`
 * guarantees and this re-asserts so a future feed change cannot alias two
 * episodes onto one filename without anyone noticing.
 */
export function selectByKeys<T extends { key: string }>(episodes: T[], keys: string[]): T[] {
  const byKey = new Map<string, T>()
  for (const e of episodes) {
    if (byKey.has(e.key)) throw new Error(`feed produced the key ${e.key} twice — refusing to select by key`)
    byKey.set(e.key, e)
  }
  const missing = keys.filter(k => !byKey.has(k))
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join(', ')
    throw new Error(`${missing.length} key(s) are not in the feed: ${shown}${missing.length > 10 ? ', …' : ''}`)
  }
  return keys.map(k => byKey.get(k)!)
}
