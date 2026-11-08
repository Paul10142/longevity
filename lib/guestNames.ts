/**
 * Guest names for podcast episodes, read the way a person reads them.
 *
 * WHY. `parseGuests(title)` in lib/podcastFeed.ts is a hand-written rule, and every
 * rule loses real guests the moment a title strays from the pattern it was written
 * for: `James Clear (#183 rebroadcast)` lists no guest under the strict rule and
 * `Ph.D. (#287 rebroadcast)` as a guest under the legacy one; 60 of FoundMyFitness's
 * 115 titles read `Dr. David Sinclair on …` and the rule finds nobody. A reader looks
 * at the title and the show notes and simply knows who is being interviewed, and that
 * is what this module asks Claude to do.
 *
 * SHAPE. Pure functions here, with the model call INJECTED (`GuestLlm`), so the tests
 * never reach a model and the script decides which one runs. Claude proposes; a
 * deterministic check disposes. A proposed name is accepted only when it
 *   - reads as a person's name (no brackets, digits, `Pt. 2`, `rebroadcast`),
 *   - appears in the title or the show notes the model was shown (case- and
 *     diacritic-insensitive), so a name from the model's memory is never accepted,
 *   - is not the show's host (silently dropped: the host is always `authors[0]`),
 *   - and the list is a sensible length.
 * An episode that fails any check, or whose batch the model could not answer, falls
 * back to the title rule the ingest used (`parseGuests(title, show.strictGuests)`),
 * and the plan says so per episode.
 *
 * Nothing here touches the database or the network; scripts/refreshGuests.ts does.
 */
import { parseGuests } from './podcastFeed'
import { isHostName, type Show } from './shows'
import { PipelineHaltError, UsageLimitError } from './usageLimit'

/** Episodes per model call. Small enough that one bad reply costs little. */
export const BATCH_SIZE = 20
/** Characters of the (tag-stripped) show notes the model is shown, and the text a name is checked against. */
export const DESCRIPTION_CHARS = 600
/** More guests than this on one episode is a sign the model listed topics or a panel of mentions. */
export const MAX_GUESTS = 6

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
}

/**
 * Show notes as plain text: tags stripped, entities decoded, whitespace collapsed,
 * cut to `max` characters. FoundMyFitness opens every description with paragraphs
 * that are nothing but sponsor links (`<p><a …>Discover my premium podcast</a></p>`),
 * which would eat the whole window before the episode is described, so a paragraph
 * whose text is entirely inside links is dropped first. A link inside a sentence
 * (`my guest is <a>Dr. X</a>`) keeps its text.
 */
export function cleanDescription(html: string | null | undefined, max = DESCRIPTION_CHARS): string {
  if (!html) return ''
  const paragraphs = html.split(/<\/p\s*>|<br\s*\/?>/i)
  const kept = paragraphs.filter(p => {
    const outsideLinks = p.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')
    const hadLink = /<a\b/i.test(p)
    return !hadLink || /[\p{L}\p{N}]/u.test(decodeEntities(outsideLinks))
  })
  const text = decodeEntities(kept.join(' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

// Letters that do not decompose into base + accent, so NFD alone would leave `Søberg` and `Soberg` different.
const LETTER_FOLDS: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ł: 'l', ı: 'i' }

/** Lower-case, accents removed, every run of non-letters/digits one space: the form names are compared in. */
export function foldForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øæœßđłı]/g, c => LETTER_FOLDS[c])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export type GuestEpisode = {
  /** The feed join key (`attia-0183-ab9f39`): stable, unique per show. */
  id: string
  title: string
  /** Raw feed description (HTML allowed); cleaned and cut before use. */
  description: string | null
}

/** The text a model is shown for an episode, and the only text a proposed name is checked against. */
export function shownText(ep: GuestEpisode): string {
  return `${ep.title}\n${cleanDescription(ep.description)}`
}

export function guestSystemPrompt(show: Show): string {
  return [
    `You read podcast episode listings and say who the GUEST of each episode is, the way a careful person would.`,
    `The show is "${show.series}", hosted by ${show.host}. You get a batch of episodes: an id, the title, and the start of the show notes.`,
    ``,
    `For each episode, list the guest(s): the people interviewed, or who join the host as a guest.`,
    ``,
    `Rules:`,
    `1. Write each name exactly as it appears in the text you were given, first and last name. The TITLE decides the spelling: when the title names the guest, copy that spelling character for character, even if the notes spell it longer ("Dr. Sam Doe" in the title and "Samuel A. Doe" in the notes is "Sam Doe"). Use the notes' spelling only for a guest the title does not name. Never invent, complete or correct a name, and never use a name that is not in the text.`,
    `2. Leave out honorifics, credentials and roles: "Dr.", "Prof.", "M.D.", "Ph.D.", "M.P.H.", "U.S. Senator". "U.S. Senator Dr. Jane Roe, M.P.H." is "Jane Roe". A credential is never a guest of its own.`,
    `3. Never list the host, ${show.host}, as a guest of his or her own show. (Another show's host can be a guest.)`,
    `4. Use [] when there is no guest: the host alone (solo episodes), AMAs, listener Q&A, live event Q&A, "Essentials" or recap episodes of the host alone, quarterly or podcast summaries and clip compilations (people named there are discussed, not interviewed), and talks the host gave.`,
    `5. A rebroadcast or tribute of an earlier interview ("In remembrance of Jane Roe", "a rebroadcast of the conversation with Jane Roe") has the person interviewed as its guest, even when the host is the one speaking in the notes.`,
    `6. Brackets, episode numbers and series notes are notes about the episode, never part of a name: "Jane Roe (#12 rebroadcast)" is the guest Jane Roe; "Jane Roe (Pt. 2)" is Jane Roe. A business, brand or channel next to a person is not a second guest: "Sam, Acme Fitness Pt.2" and "Sam from AF" are the ONE guest Sam.`,
    `7. A series label before a separator ("GUEST SERIES |", "Essentials:", "Journal Club with") is not a name. Read the notes to see who the guest is: when the notes say "my guest is Dr. X" and X is not this show's host, X is the guest, whatever the title says.`,
    `8. People who are only discussed or cited (an author whose book comes up, a scientist whose paper is read) are not guests.`,
    `9. Several guests: list each one, in the order the title names them.`,
    ``,
    `Reply with JSON only, no prose, no code fence:`,
    `{"episodes":[{"id":"<id exactly as given>","guests":["Full Name","Full Name"]}]}`,
    `One entry for every episode in the batch, with the same ids.`,
  ].join('\n')
}

export function guestUserPrompt(episodes: readonly GuestEpisode[]): string {
  return episodes
    .map(ep => `ID: ${ep.id}\nTITLE: ${ep.title}\nNOTES: ${cleanDescription(ep.description) || '(none)'}`)
    .join('\n\n---\n\n')
}

export function buildGuestPrompt(show: Show, episodes: readonly GuestEpisode[]): { system: string; user: string } {
  return { system: guestSystemPrompt(show), user: guestUserPrompt(episodes) }
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

/** The model's answer could not be read as the requested JSON. */
export class GuestReplyError extends Error {
  constructor(detail: string) {
    super(`unreadable guest reply: ${detail}`)
    this.name = 'GuestReplyError'
  }
}

function jsonFromText(text: string): unknown {
  const t = text.trim()
  if (!t) throw new GuestReplyError('empty reply')
  const candidates: string[] = [t]
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = t.indexOf(open)
    const end = t.lastIndexOf(close)
    if (start >= 0 && end > start) candidates.push(t.slice(start, end + 1))
  }
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* try the next reading */ }
  }
  throw new GuestReplyError('not JSON')
}

/**
 * The reply as id -> proposed names. Accepts what `claudeJson` returns (an object
 * `{episodes:[…]}`), a bare array, or raw text around either (fences, a sentence of
 * prose), because a stub or a different backend may hand back text.
 *
 * An entry that is malformed (no string id, `guests` not an array of strings) is
 * left out, and so is an id that appears twice, so that episode falls back instead
 * of being decided by a reply that contradicts itself. Throws `GuestReplyError`
 * when nothing usable is there at all.
 */
export function parseGuestReply(raw: unknown): Map<string, string[]> {
  const value = typeof raw === 'string' ? jsonFromText(raw) : raw
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { episodes?: unknown }).episodes)
      ? (value as { episodes: unknown[] }).episodes
      : null
  if (!list) throw new GuestReplyError('no episodes array')

  const out = new Map<string, string[]>()
  const duplicated = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const { id, guests } = entry as { id?: unknown; guests?: unknown }
    if (typeof id !== 'string' || !id) continue
    if (!Array.isArray(guests) || !guests.every(g => typeof g === 'string')) continue
    if (out.has(id)) duplicated.add(id)
    out.set(id, guests as string[])
  }
  for (const id of duplicated) out.delete(id)
  if (out.size === 0 && list.length > 0) throw new GuestReplyError('no usable entries')
  return out
}

// ---------------------------------------------------------------------------
// Validation (deterministic; no model)
// ---------------------------------------------------------------------------

const LEADING_HONORIFIC = /^(?:dr|prof|professor|mr|mrs|ms|mx|sir|rev|reverend)\.?\s+/i
// Credentials after a name: `, M.D.`, ` PhD`, `, Ph.D., M.D.`. Not Jr./Sr./II/III: those are part of the name.
// The short ones that are also surnames (`Tran Do`, `Ms`, `Rd`) only count after a comma.
const TRAILING_CREDENTIAL =
  /(?:(?:,\s*|\s+)(?:m\.?d\.?|ph\.?\s?d\.?|d\.?v\.?m\.?|d\.?d\.?s\.?|m\.?p\.?h\.?|sc\.?d\.?|m\.?b\.?a\.?|f\.?a\.?c\.?[cp]\.?)|,\s*(?:d\.?o\.?|m\.?s\.?c?\.?|r\.?d\.?n?\.?|j\.?d\.?))$/i

/** A name with honorifics and credentials removed (`Dr. Vivek Murthy, M.D.` -> `Vivek Murthy`). */
export function stripHonorifics(name: string): string {
  let n = name.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 4; i++) {
    const next = n.replace(LEADING_HONORIFIC, '').replace(TRAILING_CREDENTIAL, '').trim()
    if (next === n) break
    n = next
  }
  return n.replace(/[,;]+$/, '').trim()
}

// Text that is a note about the episode, not part of a person's name.
const EPISODE_NOTE = /\b(?:pt|part|rebroadcast|episode|series|podcast|summary|q&a)\b/i
// Lower-case connectives never occur inside a person's name; they do inside `Derek from MPMD` and `Erica and Justin Sonnenburg`.
const CONNECTIVE = /(?:^|\s)(?:from|with|on|for|the|and|about|how|why|what|is|are)(?=\s|$)/

/** Why `name` cannot be a person's name, or null when it can. */
export function notANameReason(name: string): string | null {
  if (!/[\p{L}]/u.test(name)) return 'no letters'
  // `M.P.H.`, `C.S.C.S.`: a run of credentials is initials, not a person.
  if (foldForMatch(name).split(' ').every(t => t.length === 1)) return 'initials only'
  if (/[()[\]{}<>|:#@/\\]/.test(name)) return 'contains brackets or separators'
  if (/\d/.test(name)) return 'contains a number'
  if (EPISODE_NOTE.test(name)) return 'contains episode-note words'
  if (CONNECTIVE.test(name) || name.includes('&')) return 'joins words or names that are not one name'
  if (name.length > 60 || name.split(/\s+/).length > 6) return 'too long for a name'
  return null
}

/** True when the folded `name` occurs in the folded `text` as whole words. */
export function appearsIn(name: string, text: string): boolean {
  const n = foldForMatch(name)
  return n.length > 1 && ` ${foldForMatch(text)} `.includes(` ${n} `)
}

/**
 * `Mark and Chris Bell` names two people, Mark Bell and Chris Bell, though `Mark Bell`
 * is not written anywhere. True when `name` is a first name and surname and the text
 * holds `<first> and <someone> <surname>` (or `&`): the surname is shared.
 */
export function sharedSurname(name: string, text: string): boolean {
  const parts = foldForMatch(name).split(' ')
  if (parts.length !== 2) return false
  const [first, last] = parts
  const tokens = foldForMatch(text.replace(/&/g, ' and ')).split(' ')
  for (let i = 3; i < tokens.length; i++) {
    if (tokens[i] === last && tokens[i - 2] === 'and' && tokens[i - 3] === first) return true
  }
  return false
}

/**
 * Punctuation around a name in the text (`Brooks:`, `(Pogačar,`) removed from its ends only. A final
 * period stays when it belongs to the name: an initial or `Jr.` (`George A. Brooks`, `D.A.`).
 */
function trimSpan(s: string): string {
  let t = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.]+$/u, '')
  if (t.endsWith('.')) {
    const last = t.slice(0, -1).split(/\s+/).pop() ?? ''
    // `A.`, `D.A.`, `Jr.`, `Sr.`: keep. `Brooks.` (end of a sentence): drop.
    if (!/^(?:\p{L}\.)*\p{L}$/u.test(last) && !/^(?:jr|sr)$/i.test(last)) t = t.slice(0, -1)
  }
  return t.replace(/[^\p{L}\p{N}.]+$/u, '')
}

/**
 * The text's own spelling of a name that matches it only up to punctuation, accents
 * or case: the model writes `D'Agostino` for the title's `D’Agostino`, or `Pogacar`
 * for `Pogačar`. The shown spelling wins, so a row is not rewritten for a quote mark.
 */
export function literalSpelling(name: string, text: string): string {
  const want = foldForMatch(name)
  // `D'Agostino` folds to two tokens but is one word of text, so try every span up to the folded length.
  const most = want.split(' ').length
  const words = text.split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= most && i + len <= words.length; len++) {
      const span = trimSpan(words.slice(i, i + len).join(' '))
      // A title in capitals does not turn `Matt Walker` into `MATT WALKER`.
      if (foldForMatch(span) === want && (span !== span.toUpperCase() || name === name.toUpperCase())) return span
    }
  }
  return name
}

/**
 * The title's spelling of a name the model wrote longer or shorter. A title says
 * `Dr. Matt Walker` and the notes say `Dr. Matthew Walker`; the model may copy
 * either, and one person must not carry two spellings across a show's episodes
 * (`authors` is how a guest's claims are pooled). So when the model's name is not
 * in the title, but the title holds the same surname right after a first name that
 * is a prefix of it or begins with it (Matt/Matthew, David/David A.), the title's
 * form wins. Anything less certain is left as the model wrote it.
 */
export function titleSpelling(name: string, title: string): string {
  if (appearsIn(name, title)) return name
  const parts = foldForMatch(name).split(' ')
  if (parts.length < 2) return name
  const first = parts[0]
  const last = parts[parts.length - 1]
  const words = title.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  for (let i = 1; i < words.length; i++) {
    if (foldForMatch(words[i]) !== last) continue
    const f = foldForMatch(words[i - 1])
    if (f.length > 0 && (f.startsWith(first) || first.startsWith(f))) return `${words[i - 1]} ${words[i]}`
  }
  return name
}

export type Validation =
  | { ok: true; guests: string[]; droppedHost: string[] }
  | { ok: false; reason: string }

/**
 * Check what the model proposed for one episode against the text it was shown.
 * The host is dropped without complaint (the model was told not to list the host,
 * and `authors[0]` is the host anyway); every other failure rejects the whole
 * episode, so a list that is partly invented is never half-trusted.
 */
export function validateGuests(show: Show, ep: GuestEpisode, proposed: readonly string[]): Validation {
  const text = shownText(ep)
  const guests: string[] = []
  const seen = new Set<string>()
  const droppedHost: string[] = []
  for (const raw of proposed) {
    if (isHostName(show, raw)) { droppedHost.push(raw); continue }
    const name = stripHonorifics(raw)
    if (!name) return { ok: false, reason: `empty name "${raw}"` }
    const bad = notANameReason(name)
    if (bad) return { ok: false, reason: `"${raw}" is not a name (${bad})` }
    if (isHostName(show, name)) { droppedHost.push(raw); continue }
    if (!appearsIn(name, text) && !sharedSurname(name, text)) return { ok: false, reason: `"${name}" is not in the title or description` }
    const fromTitle = titleSpelling(name, ep.title)
    const spelled = fromTitle !== name ? fromTitle : literalSpelling(name, text)
    const key = foldForMatch(spelled)
    if (seen.has(key)) continue
    seen.add(key)
    guests.push(spelled)
  }
  if (guests.length > MAX_GUESTS) return { ok: false, reason: `${guests.length} guests is more than ${MAX_GUESTS}` }
  return { ok: true, guests, droppedHost }
}

// ---------------------------------------------------------------------------
// Deciding an episode
// ---------------------------------------------------------------------------

export type Decision = {
  guests: string[]
  decided_by: 'claude' | 'fallback'
  reason: string
}

/** The title rule the ingest used, with the host removed (the host is `authors[0]`). */
export function fallbackGuests(show: Show, title: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const g of parseGuests(title, show.strictGuests)) {
    const key = foldForMatch(g)
    if (!key || seen.has(key) || isHostName(show, g)) continue
    seen.add(key)
    out.push(g)
  }
  return out
}

export function fallbackDecision(show: Show, ep: GuestEpisode, why: string): Decision {
  return {
    guests: fallbackGuests(show, ep.title),
    decided_by: 'fallback',
    reason: `${why}; used the ${show.strictGuests ? 'strict' : 'legacy'} title rule`,
  }
}

/** Claude's proposal for one episode (undefined = the reply had no entry for it) -> a decision. */
export function decideEpisode(show: Show, ep: GuestEpisode, proposed: readonly string[] | undefined): Decision {
  if (!proposed) return fallbackDecision(show, ep, 'Claude gave no usable answer for this episode')
  const v = validateGuests(show, ep, proposed)
  if (!v.ok) return fallbackDecision(show, ep, `Claude's answer was rejected: ${v.reason}`)
  const host = v.droppedHost.length > 0 ? ' (host removed)' : ''
  return {
    guests: v.guests,
    decided_by: 'claude',
    reason: (v.guests.length > 0 ? `${v.guests.length} guest${v.guests.length === 1 ? '' : 's'} read from the title and notes` : 'no guest') + host,
  }
}

// ---------------------------------------------------------------------------
// Running the batches
// ---------------------------------------------------------------------------

/** One model call: prompt in, parsed JSON (or text) out. The script supplies `claudeJson`. */
export type GuestLlm = (system: string, user: string) => Promise<unknown>

export type StopKind = 'usage-limit' | 'halt' | 'cli-unavailable'
export type Stopped = { kind: StopKind; message: string }

export type ResolveResult = {
  decisions: Map<string, Decision>
  /** Set when the run had to stop early; the episodes not yet asked are decided by the fallback. */
  stopped: Stopped | null
  batches: { total: number; asked: number; failed: number }
}

/** A failure that every later call would repeat: stop the run instead of falling back batch after batch. */
export function stopKindOf(err: unknown): StopKind | null {
  if (err instanceof UsageLimitError) return 'usage-limit'
  if (err instanceof PipelineHaltError) return 'halt'
  if (err instanceof Error && err.name === 'CliUnavailableError') return 'cli-unavailable'
  return null
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Ask Claude about every episode, a batch at a time, and decide each one.
 *
 * A batch whose reply cannot be read is retried once. A safety refusal is not
 * retried (the same text meets the same filter). A usage limit, a halted CLI or a
 * missing `claude` command ends the run: the rest are decided by the fallback and
 * `stopped` says why, so the caller can report it instead of crashing. Anything
 * else that fails twice sends only that batch to the fallback.
 */
export async function resolveGuests(
  show: Show,
  episodes: readonly GuestEpisode[],
  llm: GuestLlm,
  opts: { batchSize?: number; onBatch?: (done: number, total: number) => void } = {}
): Promise<ResolveResult> {
  const decisions = new Map<string, Decision>()
  const batches = chunk(episodes, opts.batchSize ?? BATCH_SIZE)
  const stats = { total: batches.length, asked: 0, failed: 0 }
  let stopped: Stopped | null = null

  for (const [i, batch] of batches.entries()) {
    if (stopped) {
      for (const ep of batch) decisions.set(ep.id, fallbackDecision(show, ep, `Claude not asked (${stopped.message})`))
      continue
    }
    const { system, user } = buildGuestPrompt(show, batch)
    let replies: Map<string, string[]> | null = null
    let lastError = ''
    for (let attempt = 0; attempt < 2 && !replies && !stopped; attempt++) {
      try {
        replies = parseGuestReply(await llm(system, user))
      } catch (err) {
        const kind = stopKindOf(err)
        const message = err instanceof Error ? err.message : String(err)
        if (kind) { stopped = { kind, message: message.slice(0, 200) }; break }
        lastError = message.slice(0, 160)
        if (err instanceof Error && err.name === 'ModelRefusalError') break
      }
    }
    if (stopped) {
      for (const ep of batch) decisions.set(ep.id, fallbackDecision(show, ep, `Claude not asked (${stopped.message})`))
      continue
    }
    stats.asked++
    if (!replies) {
      stats.failed++
      for (const ep of batch) decisions.set(ep.id, fallbackDecision(show, ep, `Claude's call failed (${lastError})`))
    } else {
      for (const ep of batch) decisions.set(ep.id, decideEpisode(show, ep, replies.get(ep.id)))
    }
    opts.onBatch?.(i + 1, batches.length)
  }
  return { decisions, stopped, batches: stats }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type SourceRow = { id: string; external_id: string | null; authors: string[] | null }

export type PlanRow = {
  key: string
  title: string
  /** The `sources` row for this episode, or null when the library has none yet. */
  source_id: string | null
  current_authors: string[] | null
  proposed_authors: string[]
  decided_by: Decision['decided_by']
  reason: string
  /** True when a row exists and its authors would change. */
  changed: boolean
}

export type GuestPlan = {
  version: 1
  show: string
  host: string
  made_at: string
  model: string
  /** Null when every batch was asked; otherwise why the run stopped (such a plan is not applied). */
  stopped: Stopped | null
  counts: { episodes: number; claude: number; fallback: number; no_row: number; changed: number }
  rows: PlanRow[]
}

export function sameAuthors(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** Order-, case- and accent-insensitive: the same guests. (The gold-set comparison.) */
export function sameGuestSet(a: readonly string[], b: readonly string[]): boolean {
  const x = a.map(foldForMatch).sort()
  const y = b.map(foldForMatch).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

export function buildPlan(args: {
  show: Show
  episodes: readonly GuestEpisode[]
  decisions: ReadonlyMap<string, Decision>
  rowsByKey: ReadonlyMap<string, SourceRow>
  model: string
  madeAt: string
  stopped: Stopped | null
}): GuestPlan {
  const { show, episodes, decisions, rowsByKey } = args
  const rows: PlanRow[] = episodes.map(ep => {
    const d = decisions.get(ep.id) ?? fallbackDecision(show, ep, 'no decision recorded')
    const row = rowsByKey.get(ep.id) ?? null
    const proposed = [show.host, ...d.guests]
    return {
      key: ep.id,
      title: ep.title,
      source_id: row?.id ?? null,
      current_authors: row ? row.authors : null,
      proposed_authors: proposed,
      decided_by: d.decided_by,
      reason: d.reason,
      changed: row !== null && !sameAuthors(row.authors, proposed),
    }
  })
  return {
    version: 1,
    show: show.prefix,
    host: show.host,
    made_at: args.madeAt,
    model: args.model,
    stopped: args.stopped,
    counts: {
      episodes: rows.length,
      claude: rows.filter(r => r.decided_by === 'claude').length,
      fallback: rows.filter(r => r.decided_by === 'fallback').length,
      no_row: rows.filter(r => r.source_id === null).length,
      changed: rows.filter(r => r.changed).length,
    },
    rows,
  }
}

/** A plan file read back from disk: shape-checked, so `--apply` never trusts a malformed or hand-edited file blindly. */
export function parsePlan(raw: unknown): GuestPlan {
  const p = raw as Partial<GuestPlan> | null
  if (!p || typeof p !== 'object' || p.version !== 1 || typeof p.show !== 'string' || typeof p.host !== 'string' || !Array.isArray(p.rows)) {
    throw new Error('not a guest plan (wrong version or shape)')
  }
  for (const r of p.rows) {
    const ok =
      r && typeof r.key === 'string' && (r.source_id === null || typeof r.source_id === 'string') &&
      (r.current_authors === null || (Array.isArray(r.current_authors) && r.current_authors.every(a => typeof a === 'string'))) &&
      Array.isArray(r.proposed_authors) && r.proposed_authors.length >= 1 && r.proposed_authors.every(a => typeof a === 'string') &&
      typeof r.changed === 'boolean'
    if (!ok) throw new Error(`plan row is malformed: ${JSON.stringify(r)?.slice(0, 120)}`)
  }
  return p as GuestPlan
}

export type PlanCheck = {
  /** Rows to write: still exactly as they were when the plan was made. */
  toUpdate: PlanRow[]
  /** Rows already holding the proposed authors (a plan applied twice is a no-op, not an error). */
  alreadyApplied: PlanRow[]
  /** Rows that changed since the plan was made, or are gone. Any one of these means: do not apply. */
  stale: { row: PlanRow; reason: string }[]
  /** Set when the plan itself is not applicable (a stopped or foreign plan). */
  refusal: string | null
}

/**
 * Compare a plan with the rows as they are NOW. Only the rows the plan changes are
 * checked or written. A row whose authors differ from what the plan recorded as
 * current (someone corrected them by hand, a re-ingest rewrote them) is stale: the
 * plan was made against a state that no longer exists, so nothing is written.
 */
export function checkPlan(plan: GuestPlan, show: Show, nowById: ReadonlyMap<string, SourceRow>): PlanCheck {
  const out: PlanCheck = { toUpdate: [], alreadyApplied: [], stale: [], refusal: null }
  if (plan.show !== show.prefix) out.refusal = `plan is for "${plan.show}", not "${show.prefix}"`
  else if (plan.stopped) out.refusal = `plan is incomplete (the run stopped: ${plan.stopped.message}); make a new one`
  if (out.refusal) return out

  for (const row of plan.rows.filter(r => r.changed)) {
    if (!row.source_id) { out.stale.push({ row, reason: 'plan row has no source id' }); continue }
    if (row.proposed_authors[0] !== show.host) { out.stale.push({ row, reason: `first author is not the host ${show.host}` }); continue }
    if (!row.key.startsWith(`${show.prefix}-`)) { out.stale.push({ row, reason: `key ${row.key} is not this show's` }); continue }
    const now = nowById.get(row.source_id)
    if (!now) { out.stale.push({ row, reason: 'row no longer exists' }); continue }
    if (now.external_id !== row.key) { out.stale.push({ row, reason: `row now has external_id ${now.external_id ?? 'null'}` }); continue }
    if (sameAuthors(now.authors, row.proposed_authors)) { out.alreadyApplied.push(row); continue }
    if (!sameAuthors(now.authors, row.current_authors)) {
      out.stale.push({ row, reason: `authors changed since the plan: now ${JSON.stringify(now.authors)}, plan saw ${JSON.stringify(row.current_authors)}` })
      continue
    }
    out.toUpdate.push(row)
  }
  return out
}

// ---------------------------------------------------------------------------
// The default model call
// ---------------------------------------------------------------------------

/**
 * The model and call used by the scripts: the bulk tier through `claudeJson`, so
 * the `claude-code` backend bills the subscription like the rest of the pipeline.
 * `claudeJson` parses an OBJECT out of the reply (it slices from the first `{` to
 * the last `}`), which is why the requested shape is `{"episodes":[…]}` and not a
 * bare array. Imported lazily so the pure functions above load without the SDK.
 */
export async function defaultGuestModel(): Promise<string> {
  return (await import('./llm')).CLAUDE_BULK_MODEL
}

export function claudeGuestLlm(model: string, noThinking = true): GuestLlm {
  return async (system, user) => {
    const { claudeJson } = await import('./llm')
    return claudeJson<unknown>(system, user, 4000, model, undefined, { noThinking })
  }
}
