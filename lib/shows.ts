/**
 * The show registry: the ONE place that knows which podcasts the library
 * ingests and who hosts each.
 *
 * Until 2026-11 the pipeline assumed Peter Attia in a dozen places (the
 * transcript speaker label, the extraction prompt's "Host:" line, the guest
 * filter, the feed ingest's author list, the episode search link). That was
 * invisible while The Drive was the only show, and it would have labelled
 * Andrew Huberman's speech "Peter Attia" the first time a Huberman episode ran.
 * Everything show-specific now lives in an entry below; nothing else in the
 * code base may name a host.
 *
 * ADDING A SHOW: add an entry, set `env` in .env.local to the public feed URL,
 * and follow "Adding a show" in docs/EXTRACTION_RUNBOOK.md. Nothing else.
 *
 * Pure: no imports, no I/O, so scripts, the extraction worker and the Next.js
 * pages can all use it. Tested in tests/shows.test.ts.
 */

export type Show = {
  /** Display name, and the value written to `sources.series`. */
  series: string
  /** env var holding the feed URL; the feed URL of a paid show is a credential. */
  env: string
  /** `external_id` prefix, which is also the audio / transcript filename prefix. */
  prefix: string

  /** The host as written in `sources.authors` (authors[0] on every feed row). */
  host: string
  /** The host as written in transcripts (`Peter Attia: …`) and in extracted facts. */
  hostLabel: string
  /**
   * Recognises the WHOLE name in its usual variants (`Dr. Peter Attia`,
   * `peter attia, M.D.`). Anchored: used to collapse a speaker attribution to
   * the one canonical spelling.
   */
  hostPattern: RegExp
  /**
   * Recognises the host's name anywhere in a string. Unanchored: used to keep
   * the host out of a guest list (`authors` is `[host, ...guests]`) and to
   * drop an "inferred guest" that is really the host.
   */
  hostMention: RegExp
  /** Extra Deepgram keyterms: the host's own name is the first thing a model mishears. */
  keyterms: string[]

  /**
   * Whether the show's own titles carry an episode number (`#114 …`). Huberman
   * Lab does not number episodes, but a bonus item can still contain a `#`
   * (`AMA #19: …`), and reading that as "episode 19" would put a wrong number
   * on the page and could link the item to a different show's episode 19. When
   * false the number is always null and the join key comes from the guid.
   */
  numbered: boolean

  /**
   * Strict title-to-guest parsing: a name must look like a name, the host is
   * never a guest, and `GUEST SERIES | Dr. X: topic` reads as guest X. OFF for
   * The Drive, whose existing guest lists must not change (see parseGuests).
   */
  strictGuests: boolean

  /** Public site search, ending where the query goes. */
  searchBase: string
  /** Display host for the "Find on …" link label. */
  siteHost: string
  /**
   * Search the site by `#<number>` when the episode has a number. False where
   * the number is a poor query: FoundMyFitness's search matches "#114" against
   * its Aliquot series and returns 102 unrelated hits, so it searches by title.
   */
  searchByNumber: boolean
}

export const SHOWS: readonly Show[] = [
  {
    series: 'The Drive',
    env: 'ATTIA_FEED_URL',
    prefix: 'attia',
    host: 'Dr. Peter Attia',
    hostLabel: 'Peter Attia',
    hostPattern: /^(?:dr\.?\s+)?peter\s+attia(?:,?\s+m\.?d\.?)?$/i,
    hostMention: /peter\s+attia/i,
    keyterms: ['Peter Attia', 'Attia'],
    numbered: true,
    strictGuests: false,
    searchBase: 'https://peterattiamd.com/?s=',
    siteHost: 'peterattiamd.com',
    searchByNumber: true,
  },
  {
    series: 'FoundMyFitness',
    env: 'FMF_FEED_URL',
    prefix: 'fmf',
    host: 'Dr. Rhonda Patrick',
    hostLabel: 'Rhonda Patrick',
    hostPattern: /^(?:dr\.?\s+)?rhonda\s+(?:r\.?\s+)?patrick(?:,?\s+ph\.?d\.?)?$/i,
    hostMention: /rhonda\s+(?:r\.?\s+)?patrick/i,
    keyterms: ['Rhonda Patrick', 'FoundMyFitness'],
    numbered: true,
    strictGuests: true,
    searchBase: 'https://www.foundmyfitness.com/search?q=',
    siteHost: 'foundmyfitness.com',
    searchByNumber: false,
  },
  {
    series: 'Huberman Lab',
    env: 'HUBERMAN_FEED_URL',
    prefix: 'huberman',
    host: 'Dr. Andrew Huberman',
    hostLabel: 'Andrew Huberman',
    hostPattern: /^(?:dr\.?\s+)?andrew\s+(?:d\.?\s+)?huberman(?:,?\s+ph\.?d\.?)?$/i,
    hostMention: /andrew\s+(?:d\.?\s+)?huberman/i,
    keyterms: ['Andrew Huberman', 'Huberman'],
    numbered: false,
    strictGuests: true,
    searchBase: 'https://www.hubermanlab.com/search-results?q=',
    siteHost: 'hubermanlab.com',
    searchByNumber: false,
  },
]

/**
 * The show used when a source says nothing about its show. It is the show the
 * library started with, and the one every row without a `series` and without an
 * `external_id` prefix belongs to (the pre-feed YouTube rows are backfilled to
 * 'The Drive' by migration 026, so this is a last resort rather than a guess).
 */
export const DEFAULT_SHOW: Show = SHOWS[0]

const norm = (s: string) => s.trim().toLowerCase()

export function showBySeries(series: string | null | undefined): Show | null {
  if (!series || !series.trim()) return null
  return SHOWS.find(s => norm(s.series) === norm(series)) ?? null
}

export function showByPrefix(prefix: string | null | undefined): Show | null {
  if (!prefix || !prefix.trim()) return null
  return SHOWS.find(s => s.prefix === norm(prefix)) ?? null
}

/** `attia-0405` → `attia`, `fmf-arthur-brooks` → `fmf`. Null when there is no dash. */
export function externalIdPrefix(externalId: string | null | undefined): string | null {
  if (!externalId) return null
  const i = externalId.indexOf('-')
  return i > 0 ? externalId.slice(0, i) : null
}

/** The show a join key / `external_id` belongs to, by the prefix before its first `-`. */
export function showByExternalId(externalId: string | null | undefined): Show | null {
  return showByPrefix(externalIdPrefix(externalId))
}

/** The show whose host is `authors[0]`, matched by name (so an old row with no series still resolves). */
export function showByHostName(name: string | null | undefined): Show | null {
  if (!name) return null
  return SHOWS.find(s => s.hostMention.test(name)) ?? null
}

export type ShowHints = {
  series?: string | null
  external_id?: string | null
  authors?: readonly string[] | null
}

/**
 * Which show a source row belongs to: its `series`, else the prefix of its
 * `external_id`, else the show whose host is `authors[0]`, else the default
 * show. Never null — callers want a host and a search link, not a branch.
 */
export function showForSource(src: ShowHints): Show {
  return (
    showBySeries(src.series) ??
    showByExternalId(src.external_id) ??
    showByHostName(src.authors?.[0]) ??
    DEFAULT_SHOW
  )
}

/** True when `name` mentions this show's host, in any usual spelling. */
export function isHostName(show: Show, name: string): boolean {
  return show.hostMention.test(name)
}

/**
 * Collapse a host's name variants to the one canonical label, across EVERY
 * registered show: Attia guesting on Huberman should roll up with Attia on The
 * Drive, not fragment as "Dr. Peter Attia". Any other name comes back as-is.
 */
export function canonicalHostLabel(name: string): string {
  const s = name.trim()
  for (const show of SHOWS) if (show.hostPattern.test(s)) return show.hostLabel
  return s
}

/**
 * The host label for a join key (`huberman-g1a2b3` → `Andrew Huberman`), or
 * null for an unregistered prefix. Callers must NOT guess a host on null:
 * labelling a stranger's speech with the wrong person's name is the failure
 * this registry exists to prevent.
 */
export function hostLabelForKey(key: string): string | null {
  return showByExternalId(key)?.hostLabel ?? null
}
