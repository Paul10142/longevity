/**
 * "Is this the same episode we already hold?" — the duplicate rules shared by the
 * feed ingest (scripts/ingestFeedSources.ts) and the one-off library cleanup
 * (scripts/dedupLibrary.ts), so the two can never disagree about what a duplicate is.
 *
 * Why this exists (Paul, 2026-11-08): shows re-post old episodes under new titles
 * and the pipeline treated every re-post as a new episode — transcribed again
 * (Deepgram bills per minute) and extracted again (duplicate facts). Examples
 * already in the library: `Building & Changing Habits | James Clear (#183
 * rebroadcast)` four times; `#349 - AMA #71: Building strength…` and the same
 * recording as `Building strength… (AMA #71 rebroadcast)`; 104 Huberman
 * `Essentials: …` 30-minute re-cuts of full episodes.
 *
 * WHAT COUNTS AS THE SAME EPISODE (same show only, tried in this order):
 *   a. the same show episode number in the title (`#183`, `#183 rebroadcast`,
 *      `Ep. #183`);
 *   a2. the same AMA number (`AMA #71`) — an AMA keeps its number when the show
 *      re-files it under a new episode number;
 *   b. the same title once case, diacritics, punctuation, a leading number, the
 *      `Essentials:` prefix, a rebroadcast marker and credentials are removed —
 *      in any word order, so `Topic | Guest` equals `Guest: Topic`;
 *   c. the same guests AND a media length within 2 percent (both known).
 * Titles carrying DIFFERENT episode numbers (or different AMA numbers) are
 * different episodes, always: `#259 Women's sexual health` / `#260 Men's Sexual
 * Health` must never merge, whatever else matches.
 *
 * TWO TRAPS THE NUMBERS SET:
 *   - an AMA number is not an episode number. `Blood pressure… (AMA #48
 *     rebroadcast)` is not episode #48 (that is Matt Walker, part 2), and `…(AMA
 *     #71 rebroadcast)` is not episode #71 (Katherine Eban). The feed ingest
 *     stored 48 and 71 as their episode numbers; this module reads the TITLE and
 *     ignores `sources.episode_number` for that reason.
 *   - the same number with recordings more than a third apart in length is not
 *     decided automatically (a reused number, or a part 1 / part 2 pair).
 *
 * INDEPENDENTLY of any match, a title starting `Essentials:` (a Huberman re-cut)
 * or carrying `rebroadcast` / `re-release` is a re-post or cut, and Paul wants
 * full episodes only, so it is skipped even when the original is not in the
 * library.
 *
 * Likewise on Huberman Lab (Paul, 2026-11-08, "AMA / live Q&A rows that break the
 * same full-episodes-only rule"): a title starting `AMA #N:`, or containing `Q&A`
 * or `Ask Me Anything`, is a question-and-answer item, not a full episode, and is
 * skipped with no original (see nonEpisodeFormat). The Drive's own `AMA #N`
 * episodes are full numbered episodes and are NOT touched.
 *
 * A re-cut never stands in for the full episode: a row that is itself skipped
 * with no original (an `Essentials:` cut) is never the "original" of a full
 * episode arriving later, so a full episode is never skipped because its own
 * highlights reel came first.
 *
 * Pure: no I/O and no clock, so it is tested against fixtures (tests/episodeDuplicates.test.ts).
 */

import { parseGuests } from './podcastFeed'
import { showForSource } from './shows'

// ── Title parsing ─────────────────────────────────────────────────────────────

export type RepostKind = 'rebroadcast' | 're-release'

export type ParsedTitle = {
  /** The show's own episode number, from a leading `#N` / `Ep. N` or a `(#N rebroadcast)` marker. Never an AMA number. */
  episodeNumber: number | null
  /** `AMA #71` → 71, from a leading `AMA #N:` or a `(AMA #N rebroadcast)` marker. */
  amaNumber: number | null
  /** The episode number was written at the START of the title (`#349 - …`), not only inside a rebroadcast marker. */
  numberLeads: boolean
  /** A 30-minute Huberman re-cut: the title starts `Essentials:`. */
  essentials: boolean
  /** `rebroadcast` / `re-release` was written somewhere in the title. */
  repost: RepostKind | null
  /** The title with the number, prefixes, markers and credentials removed, for display. */
  core: string
  /** Normalised comparison key: folded, no punctuation, single spaces. */
  key: string
  /** The key's words sorted — equal for `Topic | Guest` and `Guest: Topic`. */
  bag: string
}

const CREDENTIALS = /,?\s*\b(?:M\.D\.?|Ph\.D\.?|PhD|D\.O\.|M\.S\.|M\.B\.A\.|MBA|M\.P\.H\.|MPH|MD)(?=[\s,;:)|\]]|$)/g
const HONORIFICS = /\b(?:dr|prof|professor)\b\.?(?=\s)/gi
const REPOST_GROUP = /[([][^)\]]*?\bre-?(broadcast|release)\b[^)\]]*?[)\]]/gi
const REPOST_WORD = /\bre-?(broadcast|release)\b/i

/** Lowercase, drop diacritics and apostrophes, `&` → and, every other symbol → a space. */
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function kindOf(word: string): RepostKind {
  return /release/i.test(word) ? 're-release' : 'rebroadcast'
}

const parsedCache = new Map<string, ParsedTitle>()

/** Parsed once per distinct title: the cleanup compares every pair in a show. */
export function parseEpisodeTitle(rawTitle: string): ParsedTitle {
  const hit = parsedCache.get(rawTitle)
  if (hit) return hit
  const parsed = parseEpisodeTitleUncached(rawTitle)
  parsedCache.set(rawTitle, parsed)
  return parsed
}

function parseEpisodeTitleUncached(rawTitle: string): ParsedTitle {
  let t = rawTitle.replace(/\s+/g, ' ').trim()
  const st: { repost: RepostKind | null; markerEp: number | null; ama: number | null } = {
    repost: null,
    markerEp: null,
    ama: null,
  }

  // 1. A bracketed re-post marker: `(#183 rebroadcast)`, `(Ep. #85 Rebroadcast)`,
  //    `(AMA #71 rebroadcast)`, `[Rebroadcast]`, `(re-release)`. Its number is read
  //    first: an `AMA` number is NOT an episode number.
  t = t.replace(REPOST_GROUP, (group, word: string) => {
    st.repost = kindOf(word)
    const ama = group.match(/\bama\s*#?\s*(\d{1,4})/i)
    if (ama) st.ama = Number(ama[1])
    else {
      const ep = group.match(/#\s*(\d{1,4})/) ?? group.match(/\bep(?:isode)?\.?\s*(\d{1,4})/i)
      if (ep) st.markerEp = Number(ep[1])
    }
    return ' '
  })
  // `Rebroadcast: …` at the front, `… - Rebroadcast` at the end.
  t = t.replace(/^\s*re-?(broadcast|release)\s*[:\-–—]\s*/i, (_m, word: string) => { st.repost = kindOf(word); return '' })
  t = t.replace(/\s*[:\-–—|]\s*re-?(broadcast|release)\s*$/i, (_m, word: string) => { st.repost = kindOf(word); return '' })
  if (!st.repost) {
    const w = t.match(REPOST_WORD)
    if (w) st.repost = kindOf(w[0])
  }

  // 2. The Huberman 30-minute re-cut prefix.
  let essentials = false
  t = t.replace(/^\s*essentials\s*[:\-–—]\s*/i, () => { essentials = true; return '' })

  // 3. A leading episode number: `#349 - `, `#48–`, `Ep. 183 – `, `12 - `.
  let leading: number | null = null
  const lead =
    t.match(/^\s*(?:ep(?:isode)?\.?\s*)?#\s*(\d{1,4})\b\s*[‒–—:.-]*\s*/i) ??
    t.match(/^\s*ep(?:isode)?\.?\s*(\d{1,4})\b\s*[‒–—:.-]*\s*/i) ??
    t.match(/^\s*(\d{1,4})\s*[‒–—-]\s+/)
  if (lead) {
    leading = Number(lead[1])
    t = t.slice(lead[0].length)
  }

  // 4. A leading AMA number, which may follow the episode number: `#349 - AMA #71: …`.
  const ama = t.match(/^\s*ama\s*#?\s*(\d{1,4})\s*[:\-–—]\s*/i)
  if (ama) {
    st.ama = Number(ama[1])
    t = t.slice(ama[0].length)
  }

  const core = t.replace(CREDENTIALS, '').replace(HONORIFICS, '').replace(REPOST_WORD, ' ').replace(/\s+/g, ' ').trim()
  const key = foldText(core)
  return {
    episodeNumber: leading ?? st.markerEp,
    amaNumber: st.ama,
    numberLeads: leading != null,
    essentials,
    repost: st.repost,
    core,
    key,
    bag: key.split(' ').filter(Boolean).sort().join(' '),
  }
}

/** True for a title that is a re-post or a cut: skipped even with no original in the library. */
export function isRepostTitle(title: string): boolean {
  const p = parseEpisodeTitle(title)
  return p.essentials || p.repost != null
}

/** Shows whose Q&A / AMA items are not full episodes (Paul, 2026-11-08). The Drive's AMAs are numbered full episodes: not listed. */
const QA_NOT_AN_EPISODE = new Set(['Huberman Lab'])

export type NonEpisodeFormat = 'AMA' | 'live Q&A'

const LEADING_AMA = /^\s*(?:ama\s*#?\s*\d|ask me anything\b)/i
const QA_WORD = /\bq\s*(?:&|and)\s*a\b/i

/**
 * `'AMA'` / `'live Q&A'` for a question-and-answer item on a show whose Q&A items
 * are not full episodes (Huberman Lab today), else null. Skipped on its own title,
 * with no original: there is no "full episode" it copies.
 */
export function nonEpisodeFormat(r: EpisodeRef): NonEpisodeFormat | null {
  if (!QA_NOT_AN_EPISODE.has(showOf(r).series)) return null
  if (LEADING_AMA.test(r.title)) return 'AMA'
  if (QA_WORD.test(r.title) || /\blive event\b/i.test(r.title)) return 'live Q&A'
  return null
}

/** The skip reason for a Q&A item, as the admin page shows it. */
export function nonEpisodeReason(format: NonEpisodeFormat): string {
  return `${format}: full episodes only; Q&A items are not transcribed or extracted`
}

// ── Pairwise match ────────────────────────────────────────────────────────────

/** What a row needs for the rules. `series` decides the show; durations and authors are optional. */
export type EpisodeRef = {
  title: string
  series?: string | null
  external_id?: string | null
  authors?: readonly string[] | null
  media_duration_sec?: number | null
}

export type MatchKind = 'episode-number' | 'ama-number' | 'same-title' | 'same-guests-and-length'

export type PairMatch = { kind: MatchKind; detail: string }

/** Lengths this close are the same recording (rule c). */
export const SAME_LENGTH_TOLERANCE = 0.02
/** The same number on recordings this far apart is left for a person (rule a). */
export const NUMBER_LENGTH_VETO = 0.35

const showOf = (r: EpisodeRef) => showForSource({ series: r.series, external_id: r.external_id, authors: r.authors })

function lengthGap(a: EpisodeRef, b: EpisodeRef): number | null {
  const x = a.media_duration_sec
  const y = b.media_duration_sec
  if (!x || !y || x <= 0 || y <= 0) return null
  return Math.abs(x - y) / Math.max(x, y)
}

/** The guests of a row, folded, with the host and any re-post marker left out. */
export function guestSet(r: EpisodeRef): Set<string> {
  const show = showOf(r)
  const clean = (g: string) => foldText(g.replace(REPOST_GROUP, ' ').replace(CREDENTIALS, '').replace(HONORIFICS, ''))
  const fromAuthors = (r.authors ?? []).filter(a => a && !show.hostMention.test(a)).map(clean)
  const names = fromAuthors.length > 0 ? fromAuthors : parseGuests(r.title, show.strictGuests).map(clean)
  return new Set(names.filter(Boolean))
}

/** Words that say nothing about the topic of an episode. */
const FILLER = new Set(
  ('a an and the of for to in on with by from at as is are how why what when your you our their its it this that or vs ' +
    'about into than then more most best guest series ama episode live event essentials part pt').split(' ')
)

/** The topic words of a title: no filler, and none of the guest's own name. */
function topicWords(r: EpisodeRef): Set<string> {
  const guests = new Set([...guestSet(r)].flatMap(g => g.split(' ')))
  return new Set(
    parseEpisodeTitle(r.title).key.split(' ').filter(w => w.length > 1 && !FILLER.has(w) && !guests.has(w))
  )
}

/** 0..1: how much of two titles' topic words they share. */
export function topicOverlap(a: EpisodeRef, b: EpisodeRef): number {
  const x = topicWords(a)
  const y = topicWords(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / (x.size + y.size - shared)
}

/** Rule (c) also needs titles that share a topic: a six-part guest series has one guest and near-equal lengths. */
export const MIN_TOPIC_OVERLAP = 0.25

const sameSet = (a: Set<string>, b: Set<string>) => a.size > 0 && a.size === b.size && [...a].every(x => b.has(x))

/**
 * Do these two rows describe the same episode? `null` when they do not, or when
 * the answer is a judgement call. Order matters only for the label returned.
 */
export function sameEpisode(a: EpisodeRef, b: EpisodeRef): PairMatch | null {
  const sa = showOf(a)
  if (sa.series !== showOf(b).series) return null
  const pa = parseEpisodeTitle(a.title)
  const pb = parseEpisodeTitle(b.title)
  const numbered = sa.numbered

  // Different numbers are different episodes — the one rule nothing overrides.
  if (numbered && pa.episodeNumber != null && pb.episodeNumber != null && pa.episodeNumber !== pb.episodeNumber) return null
  if (pa.amaNumber != null && pb.amaNumber != null && pa.amaNumber !== pb.amaNumber) return null

  const gap = lengthGap(a, b)

  // (a) the show's own episode number.
  if (numbered && pa.episodeNumber != null && pa.episodeNumber === pb.episodeNumber) {
    if (gap != null && gap > NUMBER_LENGTH_VETO) return null
    return { kind: 'episode-number', detail: `same episode number #${pa.episodeNumber}` }
  }
  // (a2) the same AMA.
  if (pa.amaNumber != null && pa.amaNumber === pb.amaNumber) {
    return { kind: 'ama-number', detail: `same AMA #${pa.amaNumber}` }
  }
  // (b) the same title, in any word order.
  const longEnough = pa.key.length >= 8 && pb.key.length >= 8
  if (longEnough && (pa.key === pb.key || pa.bag === pb.bag)) {
    return { kind: 'same-title', detail: 'same title once numbers, markers and punctuation are ignored' }
  }
  // (c) the same guests, the same length, and a shared topic. Without the topic
  // test this joined three DIFFERENT Andy Galpin episodes of one six-part Huberman
  // series, whose lengths happen to fall within 2% of each other.
  if (gap != null && gap <= SAME_LENGTH_TOLERANCE && sameSet(guestSet(a), guestSet(b)) && topicOverlap(a, b) >= MIN_TOPIC_OVERLAP) {
    return { kind: 'same-guests-and-length', detail: `same guest(s), length within ${SAME_LENGTH_TOLERANCE * 100}% and a shared topic` }
  }
  return null
}

/**
 * Looks alike but is NOT decided: every word of the shorter title (at least 3
 * words) appears in the longer one, and the lengths are not far apart. Listed by
 * the cleanup for a person to judge, never acted on: the Huberman pair `How to
 * Improve Skin Health & Appearance` / `How to Improve & Protect Your Skin Health
 * & Appearance | Dr. Teo Soleymani` is exactly this, with a different guest.
 */
export function looksSimilar(a: EpisodeRef, b: EpisodeRef): boolean {
  if (showOf(a).series !== showOf(b).series) return false
  // Same guests and a length within 2% but no shared topic: probably two episodes of one guest series.
  const gapAB = lengthGap(a, b)
  if (gapAB != null && gapAB <= SAME_LENGTH_TOLERANCE && sameSet(guestSet(a), guestSet(b))) return true
  const ta = parseEpisodeTitle(a.title).key.split(' ').filter(Boolean)
  const tb = parseEpisodeTitle(b.title).key.split(' ').filter(Boolean)
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (short.length < 3) return false
  const pool = new Set(long)
  if (!short.every(w => pool.has(w))) return false
  const gap = lengthGap(a, b)
  return gap == null || gap <= 0.2
}

// ── Choosing the original, and the decision for a new row ─────────────────────

/** A row of the library as the rules see it. */
export type LibraryRow = EpisodeRef & {
  id: string
  created_at?: string | null
  processing_status?: string | null
  duplicate_of?: string | null
  /** raw_insights rows already extracted from this source. */
  facts?: number
  published_at?: string | null
}

const RANK: Record<MatchKind, number> = { 'episode-number': 0, 'ama-number': 1, 'same-title': 2, 'same-guests-and-length': 3 }

/**
 * Which of two copies of an episode to prefer, best first: still live (not
 * skipped) → not an `Essentials:` cut → already extracted (so nothing is
 * extracted twice) → MORE facts (Paul, 2026-11-08: where both copies are
 * extracted, the copy with more facts is kept) → the episode number leads the
 * title → not marked rebroadcast → oldest → id (so the answer never depends on
 * row order). A rebroadcast that is extracted beats an original that is not:
 * "we should use a rebroadcast" (Paul, on #288).
 */
function preference(r: LibraryRow): (number | string)[] {
  const p = parseEpisodeTitle(r.title)
  const facts = r.facts ?? 0
  const extracted = facts > 0 || r.processing_status === 'succeeded'
  return [
    r.processing_status === 'skipped' ? 1 : 0,
    p.essentials ? 1 : 0,
    extracted ? 0 : 1,
    -facts,
    p.numberLeads ? 0 : 1,
    p.repost ? 1 : 0,
    r.created_at ?? '',
    r.id,
  ]
}

/** Negative when `a` is the better copy to keep. */
export function comparePreference(a: LibraryRow, b: LibraryRow): number {
  const x = preference(a)
  const y = preference(b)
  for (let i = 0; i < x.length; i++) {
    if (x[i] < y[i]) return -1
    if (x[i] > y[i]) return 1
  }
  return 0
}

export type Original = { row: LibraryRow; kind: MatchKind; detail: string }

/**
 * The library row a candidate duplicates, or null. A row that is skipped and
 * has no original of its own (an `Essentials:` cut) is only a candidate when the
 * candidate is a re-post or cut itself. A skipped duplicate points at its own
 * original instead, so the answer is always the root copy.
 */
export function findOriginal(candidate: EpisodeRef & { id?: string }, library: readonly LibraryRow[]): Original | null {
  const candidateIsRepost = isRepostTitle(candidate.title)
  const eligible = library.filter(r => {
    if (candidate.id && r.id === candidate.id) return false
    const standsAlone = r.processing_status === 'skipped' && !r.duplicate_of
    return !(standsAlone && !candidateIsRepost)
  })
  let best: { row: LibraryRow; match: PairMatch } | null = null
  for (const row of eligible) {
    const match = sameEpisode(candidate, row)
    if (!match) continue
    if (!best) { best = { row, match }; continue }
    const byRank = RANK[match.kind] - RANK[best.match.kind]
    if (byRank < 0 || (byRank === 0 && comparePreference(row, best.row) < 0)) best = { row, match }
  }
  if (!best) return null

  // Follow a skipped duplicate to the copy it points at.
  const byId = new Map(library.map(r => [r.id, r]))
  let root = best.row
  const seen = new Set<string>([root.id])
  while (root.duplicate_of && byId.has(root.duplicate_of) && !seen.has(root.duplicate_of)) {
    root = byId.get(root.duplicate_of)!
    seen.add(root.id)
  }
  return { row: root, kind: best.match.kind, detail: best.match.detail }
}

/** `#183` for a numbered row, else its title cut to a readable length. */
export function describeEpisode(r: Pick<LibraryRow, 'title'>): string {
  const p = parseEpisodeTitle(r.title)
  if (p.episodeNumber != null) return `#${p.episodeNumber}`
  const t = p.core || r.title
  return t.length > 70 ? `${t.slice(0, 67)}…` : t
}

export type SkipDecision = {
  skip: true
  /** Why, in words an admin page can show. */
  reason: string
  /**
   * `duplicate` = a copy of an episode we hold; `re-post` = a rebroadcast/re-release/cut, with or
   * without an original; `not-a-full-episode` = a Huberman AMA or live Q&A item.
   */
  category: 'duplicate' | 're-post' | 'not-a-full-episode'
  original: Original | null
}
export type KeepDecision = { skip: false }
export type Decision = SkipDecision | KeepDecision

/**
 * What to do with a row about to be created (or already in the library):
 * skip it as a duplicate, skip it as a re-post/cut, or keep it.
 */
export function decide(candidate: EpisodeRef & { id?: string }, library: readonly LibraryRow[]): Decision {
  // A question-and-answer item is not a full episode: no library lookup, no original.
  const format = nonEpisodeFormat(candidate)
  if (format) return { skip: true, category: 'not-a-full-episode', original: null, reason: nonEpisodeReason(format) }
  const p = parseEpisodeTitle(candidate.title)
  const original = findOriginal(candidate, library)
  if (p.essentials) {
    return {
      skip: true,
      category: 're-post',
      original,
      reason: original
        ? `re-cut (Essentials) of ${describeEpisode(original.row)}`
        : 're-cut (Essentials): full episodes only; the full episode is not in the library',
    }
  }
  if (p.repost) {
    const word = p.repost
    return {
      skip: true,
      category: 're-post',
      original,
      reason: original
        ? `${word} of ${describeEpisode(original.row)}`
        : `${word}: full episodes only; the original is not in the library`,
    }
  }
  if (original) {
    return {
      skip: true,
      category: 'duplicate',
      original,
      reason: `same episode as ${original.row.id} (${original.detail})`,
    }
  }
  return { skip: false }
}

// ── Planning a whole batch of new rows ────────────────────────────────────────

export type NewEpisode = EpisodeRef & { key: string; published_at?: string | null }

export type PlannedEpisode = {
  episode: NewEpisode
  decision: Decision
  /** When the original is another episode of THIS batch, its feed key (it has no id until it is inserted). */
  originalKey: string | null
}

/**
 * Decide every new episode in a batch, in an order that makes the right copy the
 * original: full episodes before re-posts, and within each the oldest first (a
 * feed lists newest first, so its rebroadcast would otherwise win). Each decided
 * episode joins the working library, so two new copies of one episode inside the
 * same batch are caught too. Returns plans in the order they should be inserted:
 * originals before the copies that point at them.
 */
export function planNewEpisodes(episodes: readonly NewEpisode[], library: readonly LibraryRow[]): PlannedEpisode[] {
  const order = [...episodes].sort((a, b) => {
    const ra = isRepostTitle(a.title) ? 1 : 0
    const rb = isRepostTitle(b.title) ? 1 : 0
    if (ra !== rb) return ra - rb
    return (a.published_at ?? '').localeCompare(b.published_at ?? '') || a.key.localeCompare(b.key)
  })
  const working: LibraryRow[] = [...library]
  const byTempId = new Map<string, NewEpisode>()
  const out: PlannedEpisode[] = []
  for (const ep of order) {
    const tempId = `new:${ep.key}`
    const decision = decide(ep, working)
    let originalKey: string | null = null
    if (decision.skip && decision.original?.row.id.startsWith('new:')) originalKey = byTempId.get(decision.original.row.id)?.key ?? null
    byTempId.set(tempId, ep)
    working.push({
      ...ep,
      id: tempId,
      processing_status: decision.skip ? 'skipped' : 'pending',
      duplicate_of: decision.skip && decision.original ? decision.original.row.id : null,
      created_at: ep.published_at ?? null,
    })
    out.push({ episode: ep, decision, originalKey })
  }
  return out
}
