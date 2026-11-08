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
 *     diacritic-insensitive), so a name from the model's memory is never accepted.
 *     The check is on the BARE name: credentials are set aside for it and then put
 *     back from the text itself,
 *   - is not the show's host (silently dropped: the host is always `authors[0]`),
 *   - and the list is a sensible length.
 * An episode that fails any check, or whose batch the model could not answer, falls
 * back to the title rule the ingest used (`parseGuests(title, show.strictGuests)`),
 * and the plan says so per episode.
 *
 * CREDENTIALS. Each guest is written as the show writes them, credentials attached to
 * the name as ONE string: `Sally Greenwald, M.D., M.P.H.`, `Arthur Brooks Ph.D.`
 * (Paul, 2026-11-08: "we should keep their titles"). Claude finds WHO; the spelling,
 * the punctuation and which credentials follow come from the title (or, for a guest
 * only the notes name, the notes), so a model that drops one of several credentials, or
 * invents one, cannot change what the show wrote. `bareName` (lib/personName.ts) gives
 * the name without them, which is what a transcript label and a model prompt use.
 *
 * Nothing here touches the database or the network; scripts/refreshGuests.ts does.
 */
import { bareName, credentialRun, foldForMatch, honorificBefore, isCredentialOnly, splitName, stripHonorifics } from './personName'
import { CHANNEL_ALIASES, overridesByKey, type GuestOverride } from './guestOverrides'
import { parseGuests } from './podcastFeed'
import { isHostName, type Show } from './shows'
import { PipelineHaltError, UsageLimitError } from './usageLimit'

// Kept exported from here: callers that only need the bare name import it from this module.
export { bareName, foldForMatch, stripHonorifics }

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
    `1. Write each name exactly as it appears in the text you were given, first and last name. The TITLE decides the spelling: when the title names the guest, copy that spelling character for character, even if the notes spell it longer ("Dr. Sam Doe" in the title and "Samuel A. Doe" in the notes is "Dr. Sam Doe"; "Sam Doe, M.D." in the title and "Samuel A. Doe, M.D." in the notes is "Sam Doe, M.D."; a nickname in brackets or a longer first name from the notes never replaces the title's spelling). Use the notes' spelling only for a guest the title does not name. Never invent, complete or correct a name, and never use a name that is not in the text. The name ends where the person's name ends: a colon, a dash, a bracket or a comma that starts the topic of the episode ends it ("Sam Doe: More Topics, More Words" is "Sam Doe").`,
    `2. Keep each guest's credentials. Write the guest as the text writes them: the name and its credentials together in ONE string, with the punctuation between the name and its credentials as the text writes it, and nothing after the last credential. "Jane Roe, M.D., M.P.H.", "Sam Doe, M.D. Ph.D.", "Alex Poe Ph.D.", "Pat Lee, Ph.D.", "Kim Fox, L.C.S.W." are each one guest. Include every credential the text gives that person, never only one of several, and never add one the text does not give. A leading "Dr." or "Prof." stays when the text writes it. When the title names the guest, use the credentials the title gives them (none, if it gives none); when only the notes name the guest, copy the notes' rendering of the name, credentials included. A credential is never a guest of its own and never a separate list item. Leave out roles that are not credentials: "U.S. Senator Dr. Jane Roe, M.P.H." is "Dr. Jane Roe, M.P.H.".`,
    `3. Never list the host, ${show.host}, as a guest of his or her own show. (Another show's host can be a guest.)`,
    `4. Use [] when there is no guest: the host alone (solo episodes), AMAs, listener Q&A, live event Q&A, "Essentials" or recap episodes of the host alone, quarterly or podcast summaries and clip compilations (people named there are discussed, not interviewed), and talks the host gave.`,
    `5. A rebroadcast or tribute of an earlier interview ("In remembrance of Jane Roe", "a rebroadcast of the conversation with Jane Roe") has the person interviewed as its guest, even when the host is the one speaking in the notes.`,
    `6. Brackets, episode numbers and series notes are notes about the episode, never part of a name: "Jane Roe (#12 rebroadcast)" is the guest Jane Roe; "Jane Roe (Pt. 2)" is Jane Roe. A business, brand or channel next to a person is not a second guest: "Jane Roe, Acme Fitness Pt.2" and "Jane Roe from AF" are the ONE guest Jane Roe. The exception is a guest the text names only by a first name or a handle, together with the channel they publish under (a pseudonym): "Sam: Plates And Dates, Daily" and "Sam, Plates And Dates Daily Pt.2" are ONE guest, written as the first name, a comma, and the channel name as the text writes it without its punctuation or episode note: "Sam, Plates And Dates Daily". An abbreviation of a channel ("Sam from PDD") is not enough: that guest is "Sam".`,
    `7. A series label before a separator ("GUEST SERIES |", "Essentials:", "Journal Club with") is not a name. Read the notes to see who the guest is: when the notes say "my guest is Dr. X" and X is not this show's host, X is the guest, whatever the title says.`,
    `8. People who are only discussed or cited (an author whose book comes up, a scientist whose paper is read) are not guests.`,
    `9. Several guests: list each one, in the order the title names them.`,
    ``,
    `Reply with JSON only, no prose, no code fence:`,
    `{"episodes":[{"id":"<id exactly as given>","guests":["Full Name, M.D.","Full Name"]}]}`,
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

/** One place a name occurs in a text: the text's own spelling of it, and where it starts and ends. */
type NameOccurrence = { spelled: string; start: number; end: number }

/**
 * Every place `name` occurs in `text` up to punctuation, accents or case, in text order,
 * with the text's own spelling and offsets. A span that would cross a line break is not
 * a match (the title ends and the notes begin there).
 */
function nameOccurrences(name: string, text: string): NameOccurrence[] {
  const want = foldForMatch(name)
  // `D'Agostino` folds to two tokens but is one word of text, so try every span up to the folded length.
  const most = want.split(' ').length
  const words = [...text.matchAll(/\S+/g)].map(m => ({ s: m[0], at: m.index as number }))
  const out: NameOccurrence[] = []
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= most && i + len <= words.length; len++) {
      const first = words[i]
      const last = words[i + len - 1]
      const raw = text.slice(first.at, last.at + last.s.length)
      if (/[\r\n]/.test(raw)) break
      const span = trimSpan(raw.replace(/\s+/g, ' '))
      // A title in capitals does not turn `Matt Walker` into `MATT WALKER`.
      if (foldForMatch(span) !== want || (span === span.toUpperCase() && name !== name.toUpperCase())) continue
      const lead = raw.length - raw.replace(/^[^\p{L}\p{N}]+/u, '').length
      let end = last.at + last.s.replace(/[^\p{L}\p{N}.]+$/u, '').length
      if (!span.endsWith('.') && text[end - 1] === '.') end -= 1
      out.push({ spelled: span, start: first.at + lead, end })
      break
    }
  }
  return out
}

/**
 * The text's own spelling of a name that matches it only up to punctuation, accents
 * or case: the model writes `D'Agostino` for the title's `D’Agostino`, or `Pogacar`
 * for `Pogačar`. The shown spelling wins, so a row is not rewritten for a quote mark.
 * The BARE name: honorific and credentials are not part of it (see `writtenForm`).
 */
export function literalSpelling(name: string, text: string): string {
  return nameOccurrences(name, text)[0]?.spelled ?? name
}

/**
 * A guest as the show writes them: the bare `name` (already spelled the way the text
 * spells it) with the `Dr.`/`Prof.` before it and the credentials after it, copied from
 * the text. The title is read first and decides: a guest the title names carries the
 * credentials the title gives them, none if it gives none. A guest only the notes name
 * carries the notes' rendering. A name the text does not hold as written (a shared
 * surname: `Mark and Chris Bell`) comes back bare.
 *
 * `proposedCredentials` are the credentials the model attached; they are never copied
 * into the result, only used to recognise a credential the built-in list lacks (`FRSA`)
 * when the text writes it. So a model cannot add a credential the text does not give,
 * or lose one that it does.
 */
export function writtenForm(name: string, ep: GuestEpisode, proposedCredentials: readonly string[] = []): string {
  // A pseudonym and its channel is already in its one written form; the text spells it with colons and commas.
  if (pseudonymForm(name) === name) return name
  for (const source of [ep.title, cleanDescription(ep.description)]) {
    const found = nameOccurrences(name, source).map(o => ({ o, run: credentialRun(source.slice(o.end), proposedCredentials) }))
    if (found.length === 0) continue
    // A name that occurs twice and carries credentials once is written with them.
    const pick = found.find(f => f.run) ?? found[0]
    const honorific = honorificBefore(source, pick.o.start)
    return `${honorific ? `${honorific} ` : ''}${pick.o.spelled}${pick.run}`
  }
  return name
}

// First names that are short forms of each other but not prefixes (`Tom`/`Thomas` share only `Th`/`To`).
// Prefix pairs (`Matt`/`Matthew`) need no entry. Folded form, every group lower-case.
const FIRST_NAME_FORMS = [
  ['tom', 'thomas', 'tommy'],
  ['bill', 'billy', 'will', 'william'],
  ['bob', 'bobby', 'rob', 'robert'],
  ['jim', 'jimmy', 'james'],
  ['dick', 'rick', 'rich', 'richard'],
  ['ted', 'ed', 'edward', 'edmund'],
  ['jack', 'john', 'jon'],
  ['mike', 'michael'],
  ['dave', 'david'],
  ['steve', 'steven', 'stephen'],
  ['chris', 'christopher'],
  ['tony', 'anthony'],
  ['liz', 'beth', 'elizabeth'],
  ['kate', 'kathy', 'katherine', 'catherine'],
  ['peggy', 'margaret'],
  ['hank', 'henry'],
  ['jeff', 'jeffrey', 'geoff', 'geoffrey'],
]

function sameFirstName(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false
  if (a.startsWith(b) || b.startsWith(a)) return true
  return FIRST_NAME_FORMS.some(g => g.includes(a) && g.includes(b))
}

/**
 * The title's spelling of a name the model wrote longer or shorter. A title says
 * `Dr. Matt Walker` and the notes say `Dr. Matthew Walker`; the model may copy
 * either, and one person must not carry two spellings across a show's episodes
 * (`authors` is how a guest's claims are pooled). So when the model's name is not
 * in the title, but the title holds the same surname right after a first name that
 * is a prefix of it or begins with it (Matt/Matthew, David/David A.), or a listed
 * short form of it (Tom/Thomas, Bill/William), the title's form wins. Anything less
 * certain is left as the model wrote it.
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
    if (sameFirstName(foldForMatch(words[i - 1]), first)) return `${words[i - 1]} ${words[i]}`
  }
  return name
}

// A first name or handle, a separator, then the channel's words: `Derek: More Plates, More Dates`.
const PSEUDONYM = /^(\p{L}[\p{L}'’-]*)\s*[:,–—‒|-]\s*(.+)$/u
// An episode note after the channel (`Pt.2`, `Part II`) is not part of its name.
const TRAILING_EPISODE_NOTE = /\s*\(?\b(?:pt|part)\b\.?\s*[\p{L}\p{N}]+\)?\s*$/iu

/**
 * A guest the text knows only by a first name or handle plus the channel they publish
 * under (Paul, 2026-11-08: `Derek: More Plates, More Dates` is ONE guest, written
 * `Derek, More Plates More Dates`). Returns that one written form, or null when `name`
 * is not that shape: the channel must be two or more capitalised words, so a credential
 * (`Sam, M.D.`), an abbreviation (`Derek from MPMD`) or a surname is never taken for one.
 */
export function pseudonymForm(name: string): string | null {
  const m = PSEUDONYM.exec(name.trim())
  if (!m) return null
  const channel = m[2].replace(TRAILING_EPISODE_NOTE, '').replace(/[^\p{L}\p{N}'’ ]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const words = channel.split(' ')
  if (words.length < 2 || !words.every(w => /^\p{Lu}/u.test(w))) return null
  if (EPISODE_NOTE.test(channel) || /\d/.test(channel) || CONNECTIVE.test(channel) || isCredentialOnly(m[2])) return null
  return `${m[1]}, ${channel}`
}

/**
 * A guest the text names by first name and the INITIALS of a channel listed in
 * `CHANNEL_ALIASES` (`Derek from MPMD`, `Derek (MPMD)`, `Derek, MPMD`), or that channel
 * written out beside the first name (`Derek from More Plates More Dates`, `Derek: More
 * Plates, More Dates`), so the result does not depend on whether the model chose to carry
 * the channel. `raw` is what the model proposed: the bare first name (`Derek`), or
 * `Derek from MPMD` copied from the title. Returns the one written form `Derek, More Plates More Dates`, or null when `raw`
 * is not such a first name or the text does not write that first name next to the channel,
 * so a first name alone, or beside a channel nobody confirmed, is left to the normal path.
 */
export function channelAliasForm(raw: string, text: string): string | null {
  const m = /^(\p{L}[\p{L}'’-]*)(?:\s+(?:from|of|at)\s+(\p{Lu}[\p{Lu}\p{N}]+))?$/u.exec(raw.trim())
  if (!m) return null
  const first = foldForMatch(m[1])
  for (const [initials, channel] of Object.entries(CHANNEL_ALIASES)) {
    if (m[2] && m[2] !== initials) continue
    // The channel written out may carry the text's own commas (`More Plates, More Dates`).
    const marker = `${initials}|${channel.trim().split(/\s+/).join('[\\s,]+')}`
    const re = new RegExp(`(?<![\\p{L}\\p{N}'’-])(\\p{L}[\\p{L}'’-]*)\\s*(?:from|of|at|\\(|[:,–—|-])\\s*(?:${marker})(?![\\p{L}\\p{N}'’-])`, 'gu')
    for (const hit of text.matchAll(re)) {
      if (foldForMatch(hit[1]) === first) return `${m[1]}, ${channel}`
    }
  }
  return null
}

/**
 * A guest the model gave by first name only, when the show notes write the whole name:
 * the title says `Dr. Darya and Kevin Rose`, the notes say `Darya Rose`, and the model
 * copies the title's one word. The notes' two-word form wins, but only when it is
 * unambiguous: the first name occurs in the NOTES (never the title, whose Title Case
 * would read `Matt Talks` as a name) followed by one capitalised word, always the same
 * word, and the pair reads as a name. A pseudonym (`Derek: More Plates`, `Derek from
 * MPMD`) has punctuation or a lower-case word after the first name and stays as it was.
 */
export function fullerName(name: string, ep: GuestEpisode): string {
  if (name.trim().split(/\s+/).length !== 1) return name
  const first = foldForMatch(name)
  const found = new Set<string>()
  const notes = cleanDescription(ep.description)
  for (const m of notes.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'’-]*)[ \t]+(\p{Lu}[\p{L}'’-]*)(?![\p{L}\p{N}'’-])/gu)) {
    if (foldForMatch(m[1]) === first) found.add(`${m[1]} ${m[2]}`)
  }
  if (found.size !== 1) return name
  const full = [...found][0]
  return notANameReason(full) ? name : full
}

/**
 * The `Dr.`/`Prof.` the title writes before a guest's first name, for a guest whose
 * full name the title does not hold (`Dr. Darya and …` in the title, `Darya Rose` in the
 * notes). Empty when the title writes none or already holds the name.
 */
function titleHonorific(name: string, title: string): string {
  if (appearsIn(name, title)) return ''
  const first = foldForMatch(name).split(' ')[0]
  for (const m of title.matchAll(/(?<![\p{L}\p{N}])\p{L}[\p{L}'’-]*(?![\p{L}\p{N}'’-])/gu)) {
    if (foldForMatch(m[0]) === first) {
      const h = honorificBefore(title, m.index as number)
      if (h) return h
    }
  }
  return ''
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
    // A credential on its own (`M.P.H.`) is not a guest; it belongs to the name before it, which the text supplies.
    if (isCredentialOnly(raw)) continue
    // `Derek` / `Derek from MPMD`, with the text writing the initials of a confirmed channel: the same pseudonymous
    // guest as `Derek: More Plates, More Dates`, written `Derek, More Plates More Dates`. The text's own words are the check.
    const aliased = channelAliasForm(raw, text)
    if (aliased) {
      const aliasKey = foldForMatch(aliased)
      if (!seen.has(aliasKey)) { seen.add(aliasKey); guests.push(aliased) }
      continue
    }
    // A pseudonym and its channel is one name written `Derek, More Plates More Dates`, however the model punctuated
    // it. Read it BEFORE `splitName`, which would take everything after the comma for credentials it does not know.
    const pseudo = pseudonymForm(raw)
    const parts = pseudo ? { honorific: '', bare: pseudo, credentials: [] as string[] } : splitName(raw)
    const name = parts.bare
    if (!name) return { ok: false, reason: `empty name "${raw}"` }
    const bad = notANameReason(name)
    if (bad) return { ok: false, reason: `"${raw}" is not a name (${bad})` }
    if (isHostName(show, name)) { droppedHost.push(raw); continue }
    // The title's spelling of a short form comes first (`William Harris` -> `Bill Harris`): it comes FROM the
    // text, so the check that a name appears in the text is made on it, not on what the model wrote.
    const fromTitle = titleSpelling(name, ep.title)
    if (fromTitle === name && !appearsIn(name, text) && !sharedSurname(name, text)) return { ok: false, reason: `"${name}" is not in the title or description` }
    const literal = fromTitle !== name ? fromTitle : literalSpelling(name, text)
    const spelled = pseudonymForm(name) === name ? (pseudonymForm(literal) ?? name) : fullerName(literal, ep)
    const key = foldForMatch(spelled)
    if (seen.has(key)) continue
    seen.add(key)
    let written = writtenForm(spelled, ep, parts.credentials)
    // `Dr. Darya` in the title, `Darya Rose` in the notes: the honorific the title gives comes along.
    if (!/^(?:dr|prof|professor)\.?\s/i.test(written)) {
      const h = titleHonorific(spelled, ep.title)
      if (h) written = `${h} ${written}`
    }
    guests.push(written)
  }
  if (guests.length > MAX_GUESTS) return { ok: false, reason: `${guests.length} guests is more than ${MAX_GUESTS}` }
  return { ok: true, guests, droppedHost }
}

// ---------------------------------------------------------------------------
// Deciding an episode
// ---------------------------------------------------------------------------

export type Decision = {
  guests: string[]
  /** `override` = a guest list set by hand in lib/guestOverrides.ts; the model was not asked. */
  decided_by: 'claude' | 'fallback' | 'override'
  reason: string
}

/** The title rule the ingest used, with the host removed (the host is `authors[0]`). */
export function fallbackGuests(show: Show, title: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const g of parseGuests(title, show.strictGuests)) {
    const key = foldForMatch(g)
    // `M.P.H.` split off a name by the comma rule is a credential, not a guest.
    if (!key || seen.has(key) || isHostName(show, g) || isCredentialOnly(g)) continue
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

export function overrideDecision(o: GuestOverride): Decision {
  return {
    guests: [...o.guests],
    decided_by: 'override',
    reason: `guest list set by hand (lib/guestOverrides.ts): ${o.why}`,
  }
}

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
  opts: { batchSize?: number; onBatch?: (done: number, total: number) => void; overrides?: ReadonlyMap<string, GuestOverride> } = {}
): Promise<ResolveResult> {
  const decisions = new Map<string, Decision>()
  // A guest list set by hand is final: the model is not asked, so its variance cannot undo it.
  const overrides = opts.overrides ?? overridesByKey()
  const toAsk: GuestEpisode[] = []
  for (const ep of episodes) {
    const o = overrides.get(ep.id)
    if (o) decisions.set(ep.id, overrideDecision(o))
    else toAsk.push(ep)
  }
  const batches = chunk(toAsk, opts.batchSize ?? BATCH_SIZE)
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
  /** `override` is absent in plans made before the override list existed. */
  counts: { episodes: number; claude: number; fallback: number; no_row: number; changed: number; override?: number }
  rows: PlanRow[]
}

export function sameAuthors(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * The same people: order, case, accents, honorifics and credentials ignored (the gold-set
 * comparison of WHO). `Sally Greenwald, M.D., M.P.H.` is the same person as `Sally Greenwald`.
 */
export function sameGuestSet(a: readonly string[], b: readonly string[]): boolean {
  const x = a.map(n => foldForMatch(bareName(n))).sort()
  const y = b.map(n => foldForMatch(bareName(n))).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * The same guests written the same way: order, case, accents and punctuation ignored, but
 * every honorific and credential counts (`Sally Greenwald, M.D.` is not `Sally Greenwald, M.D., M.P.H.`).
 */
export function sameWrittenGuests(a: readonly string[], b: readonly string[]): boolean {
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
      override: rows.filter(r => r.decided_by === 'override').length,
      no_row: rows.filter(r => r.source_id === null).length,
      changed: rows.filter(r => r.changed).length,
    },
    rows,
  }
}

/**
 * The plan with every hand-set guest list written over what it proposed. `--apply` runs
 * this first, so a plan made before an override existed (or by a model that varied) still
 * cannot undo a row a person set by hand. Rows with no override are untouched; a changed
 * row's `changed` flag is recomputed against the row's recorded current authors, so the
 * stale-plan guard in `checkPlan` still compares the live row with what the plan SAW.
 */
export function withOverrides(
  plan: GuestPlan,
  show: Show,
  overrides: ReadonlyMap<string, GuestOverride> = overridesByKey()
): { plan: GuestPlan; replaced: PlanRow[] } {
  const replaced: PlanRow[] = []
  const rows = plan.rows.map(r => {
    const o = overrides.get(r.key)
    if (!o) return r
    const proposed = [show.host, ...o.guests]
    const d = overrideDecision(o)
    const next: PlanRow = {
      ...r,
      proposed_authors: proposed,
      decided_by: d.decided_by,
      reason: d.reason,
      changed: r.source_id !== null && !sameAuthors(r.current_authors, proposed),
    }
    if (!sameAuthors(r.proposed_authors, proposed) || r.changed !== next.changed) replaced.push(next)
    return next
  })
  const counts = {
    ...plan.counts,
    override: rows.filter(r => r.decided_by === 'override').length,
    claude: rows.filter(r => r.decided_by === 'claude').length,
    fallback: rows.filter(r => r.decided_by === 'fallback').length,
    changed: rows.filter(r => r.changed).length,
  }
  return { plan: { ...plan, rows, counts }, replaced }
}

/**
 * Has anyone read or corrected this row's guests yet? True for a library row that is not
 * yet extracted and whose guests are still exactly what the ingest's title rule wrote, so
 * `--new` asks Claude about the batch just ingested and nothing older. A row a person fixed,
 * or Claude already changed, differs from the title rule and is left alone.
 */
export function isUnreadRow(show: Show, row: SourceRow & { processing_status?: string | null }, title: string): boolean {
  if (row.processing_status === 'succeeded') return false
  const guests = (row.authors ?? []).slice(1)
  return sameGuestSet(guests, fallbackGuests(show, title)) && !!row.authors && row.authors.length >= 1 && isHostName(show, row.authors[0])
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
