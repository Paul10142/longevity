/**
 * Match a source (episode) to its YouTube video by TITLE, conservatively.
 *
 * Only 123 of 556 extracted episodes carried a YouTube link when the flag review
 * screen was built (it needs one to open the video before a claim). The channel's
 * own catalogue (every upload's id, title, length) is the evidence; a source is
 * matched only when exactly one upload fits, and left blank otherwise. A wrong
 * link sends a physician to the wrong minute of the wrong video, which is worse
 * than no link, so every doubtful case returns null with a reason.
 *
 * Pure: no I/O. scripts/backfillYoutubeIds.ts does the fetching and the writing.
 * Tested in tests/youtubeMatch.test.ts, including against episodes whose video is
 * already known (the hold-out check `--validate` runs on real data).
 */

export type CatalogVideo = { id: string; title: string; durationSec: number | null }

export type MatchInput = {
  title: string | null
  episodeNumber: number | null
  durationSec: number | null
}

export type MatchResult =
  | { videoId: string; how: 'exact-title' | 'similar-title' | 'episode-number'; score: number }
  | { videoId: null; reason: 'no-title' | 'no-candidate' | 'ambiguous' | 'duration-mismatch' }

/** Leading "#253 ‒ " / "253 - " / "Ep. 253:" episode marker, which the channel and the show notes format differently. */
const NUMBER_PREFIX = /^\s*(?:#|ep(?:isode)?\.?\s*)?(\d{1,4})\s*[‒–—:.-]\s*/i

export function titleEpisodeNumber(title: string | null | undefined): number | null {
  const m = NUMBER_PREFIX.exec(title ?? '')
  return m ? Number(m[1]) : null
}

/** Lowercase words only: no marker, punctuation, accents or case. */
export function titleTokens(title: string): string[] {
  return title
    .replace(NUMBER_PREFIX, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'for', 'with', 'is', 'how'])

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a.filter(w => !STOP.has(w)))
  const B = new Set(b.filter(w => !STOP.has(w)))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

/** A title with the "| Guest, M.D." tail removed, for comparing the topic part alone. */
function withoutGuest(title: string): string {
  return title.split('|')[0]
}

/** Full episodes are long; a duration known on both sides must agree within this fraction. */
export const DURATION_TOLERANCE = 0.15

function durationOk(a: number | null, b: number | null, tolerance: number = DURATION_TOLERANCE): boolean {
  if (!a || !b) return true
  return Math.abs(a - b) / Math.max(a, b) <= tolerance
}

/** Episode-number matches: the audio and the video differ in length more than titles do (intros, ad reads). */
export const NUMBER_DURATION_TOLERANCE = 0.3
export const NUMBER_MIN_SIM = 0.35

/** Minimum similarity for a non-identical title, and the lead the best must hold over the runner-up. */
export const SIMILAR_MIN = 0.9
export const SIMILAR_MARGIN = 0.1

export function matchVideo(input: MatchInput, catalog: readonly CatalogVideo[]): MatchResult {
  if (!input.title || titleTokens(input.title).length === 0) return { videoId: null, reason: 'no-title' }
  const full = titleTokens(input.title)
  const topic = titleTokens(withoutGuest(input.title))

  const scored = catalog.map(v => {
    const vFull = titleTokens(v.title)
    const vTopic = titleTokens(withoutGuest(v.title))
    const exact = full.join(' ') === vFull.join(' ')
    const sim = Math.max(jaccard(full, vFull), jaccard(topic, vTopic) * 0.98)
    // Two different episodes can share a topic line; when both sides carry an
    // episode number they must agree.
    const vNum = titleEpisodeNumber(v.title)
    const numberClash = input.episodeNumber !== null && vNum !== null && vNum !== input.episodeNumber
    return { v, exact, sim, numberClash }
  })

  const exacts = scored.filter(s => s.exact && !s.numberClash)
  if (exacts.length > 1) {
    // Same title uploaded twice (a clip and the episode, or a re-upload): the length decides.
    const sameLength = exacts.filter(s => durationOk(input.durationSec, s.v.durationSec) && input.durationSec !== null && s.v.durationSec !== null)
    if (sameLength.length === 1) return { videoId: sameLength[0].v.id, how: 'exact-title', score: 1 }
    return { videoId: null, reason: 'ambiguous' }
  }
  if (exacts.length === 1) {
    return durationOk(input.durationSec, exacts[0].v.durationSec)
      ? { videoId: exacts[0].v.id, how: 'exact-title', score: 1 }
      : { videoId: null, reason: 'duration-mismatch' }
  }

  // The channel numbers its full episodes ("253 ‒ …") and shortens the title, so
  // the number is the strongest key when it is present on both sides: it must
  // pick out ONE upload of a plausible length, and the topic words must still
  // overlap. A clip or "sneak peek" of the episode is far shorter, so the length
  // check is what keeps those out.
  if (input.episodeNumber !== null) {
    const same = scored.filter(s => titleEpisodeNumber(s.v.title) === input.episodeNumber)
    const fits = same.filter(s => s.sim >= NUMBER_MIN_SIM && durationOk(input.durationSec, s.v.durationSec, NUMBER_DURATION_TOLERANCE))
    if (fits.length === 1) return { videoId: fits[0].v.id, how: 'episode-number', score: Number(fits[0].sim.toFixed(3)) }
    if (fits.length > 1) return { videoId: null, reason: 'ambiguous' }
  }

  const ranked = scored.filter(s => !s.numberClash).sort((a, b) => b.sim - a.sim)
  const best = ranked[0]
  if (!best || best.sim < SIMILAR_MIN) return { videoId: null, reason: 'no-candidate' }
  if (ranked[1] && best.sim - ranked[1].sim < SIMILAR_MARGIN) return { videoId: null, reason: 'ambiguous' }
  if (!durationOk(input.durationSec, best.v.durationSec)) return { videoId: null, reason: 'duration-mismatch' }
  return { videoId: best.v.id, how: 'similar-title', score: Number(best.sim.toFixed(3)) }
}

/** Parse yt-dlp `--print "%(id)s\t%(title)s\t%(duration)s"` output. */
export function parseCatalogTsv(tsv: string): CatalogVideo[] {
  const out: CatalogVideo[] = []
  for (const line of tsv.split('\n')) {
    const [id, title, dur] = line.split('\t')
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || !title) continue
    const d = Number(dur)
    out.push({ id, title: title.trim(), durationSec: Number.isFinite(d) && d > 0 ? d : null })
  }
  return out
}
