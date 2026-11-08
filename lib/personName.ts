/**
 * A person's name the way a show writes it, and the bare name a transcript uses.
 *
 * THE TWO FORMS. `sources.authors` holds each guest exactly as the show writes them:
 * `Sally Greenwald, M.D., M.P.H.`, `Max Diehn, M.D. Ph.D.`, `Arthur Brooks Ph.D.`,
 * `Dr. David Sinclair`. Episode pages show that. Everything that LABELS a speaker or
 * names a person to a model (the `Name:` labels baked into a transcript, the
 * extraction prompt's `Guest(s):` line, the speaker stored on a fact) uses the BARE
 * name, `Sally Greenwald`: a credential in a label would split one person into two
 * speakers (`Sally Greenwald:` and `Sally Greenwald, M.D.:`) and corroboration counts
 * distinct speakers. `bareName` is the one place that turns the first form into the
 * second.
 *
 * Pure: no imports, no I/O. Used by lib/guestNames.ts (the reader), lib/deepgramSegments.ts
 * (speaker labels) and lib/extraction.ts (the prompt and the stored speaker).
 */

// ---------------------------------------------------------------------------
// Comparing names
// ---------------------------------------------------------------------------

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
// Credentials
// ---------------------------------------------------------------------------

const LEADING_HONORIFIC = /^(?:dr|prof|professor|mr|mrs|ms|mx|sir|rev|reverend)\.?\s+/i

// Credentials that are safe after a space as well as after a comma: `Arthur Brooks Ph.D.`, `Max Diehn, M.D. Ph.D.`.
// Dots are optional everywhere (`MD`, `M.D.`, `PhD`, `Ph.D.`): shows write both.
const FREE_CREDENTIALS = [
  'm\\.?d\\.?',
  'ph\\.?\\s?d\\.?',
  'd\\.?v\\.?m\\.?',
  'd\\.?d\\.?s\\.?',
  'm\\.?p\\.?h\\.?',
  'sc\\.?\\s?d\\.?',
  'd\\.?sc\\.?',
  'm\\.?b\\.?a\\.?',
  'l\\.?c\\.?s\\.?w\\.?',
  'd\\.?p\\.?t\\.?',
  'c\\.?s\\.?c\\.?s\\.?',
  'psy\\.?\\s?d\\.?',
  'ed\\.?\\s?d\\.?',
  'pharm\\.?\\s?d\\.?',
  'm\\.?phil\\.?',
  'd\\.?phil\\.?',
  'm\\.?b\\.?b\\.?s\\.?',
  'm\\.?s\\.?p\\.?t\\.?',
  'm\\.?p\\.?t\\.?',
  'm\\.?r\\.?c\\.?p\\.?',
  'f\\.?r\\.?a\\.?c\\.?p\\.?',
  'r\\.?d\\.?n\\.?',
  // Fellowships: `Tom Dayspring, M.D., FACP, FNLA`.
  'f\\.?a\\.?c\\.?[cps]\\.?',
  'f\\.?a\\.?c\\.?o\\.?g\\.?',
  'f\\.?a\\.?c\\.?s\\.?m\\.?',
  'f\\.?n\\.?l\\.?a\\.?',
  'f\\.?a\\.?h\\.?a\\.?',
  'f\\.?a\\.?s\\.?n\\.?',
  'f\\.?c\\.?c\\.?p\\.?',
  'f\\.?a\\.?a\\.?[pn]\\.?',
  'f\\.?r\\.?c\\.?[ps]\\.?c?\\.?',
]
// Short ones that are also words or surnames (`Tran Do`, `Ms`, `Rd`, `Ma`, `Washington D.C.`): only after a comma.
const COMMA_ONLY_CREDENTIALS = [
  'd\\.?o\\.?',
  'd\\.?c\\.?',
  'm\\.?s\\.?c?\\.?',
  'r\\.?d\\.?',
  'j\\.?d\\.?',
  'b\\.?s\\.?c?\\.?',
  'm\\.?a\\.?',
  'm\\.?ed\\.?',
  'b\\.?a\\.?',
  'm\\.?p\\.?[ap]\\.?',
  'm\\.?h\\.?s\\.?',
  'p\\.?t\\.?',
  'c\\.?p\\.?t\\.?',
  'm\\.?s\\.?w\\.?',
  'n\\.?p\\.?',
  'p\\.?a\\.?-?c?\\.?',
  'l\\.?m\\.?f\\.?t\\.?',
  'o\\.?d\\.?',
  'n\\.?d\\.?',
  'c\\.?n\\.?s\\.?',
  'a\\.?p\\.?r\\.?n\\.?',
  'd\\.?n\\.?p\\.?',
]

/** A credential token the model attached that the lists above do not know: capitals and dots (`FRSA`, `C.S.C.S.`), nothing else. */
const CREDENTIAL_LIKE = /^[\p{Lu}.]{2,10}$/u

function vocabSource(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\.?') + '\\.?'
}

/**
 * One credential with the separator before it. It must end where the word ends: not
 * before a letter (`M.D.` never matches inside `MDMA`) and not before `.X` (`M.S.` never
 * matches the front of `M.S.P.T.`, which would keep one credential of several).
 */
function credentialAfter(extra: readonly string[]): string {
  const free = [...FREE_CREDENTIALS, ...extra.map(vocabSource)].join('|')
  return `(?:(?:,\\s*|\\s+)(?:${free})|,\\s*(?:${COMMA_ONLY_CREDENTIALS.join('|')}))(?![\\p{L}\\p{N}]|\\.[\\p{L}\\p{N}])`
}

const TRAILING_CREDENTIAL = new RegExp(`${credentialAfter([])}$`, 'iu')
const CREDENTIALS_ONLY = new RegExp(`^(?:${credentialAfter([])})+$`, 'iu')

// Not credentials: part of the name.
const NAME_SUFFIX = /^,\s*(?:jr|sr|ii|iii|iv)\.?$/i

export type NameParts = {
  /** A leading `Dr.` / `Prof.` as written, or ''. */
  honorific: string
  /** The name with the honorific and every credential removed. */
  bare: string
  /** The credentials that were removed, in the order written (`['M.D.', 'M.P.H.']`). */
  credentials: string[]
}

/** `Dr. Sally Greenwald, M.D., M.P.H.` -> honorific `Dr.`, bare `Sally Greenwald`, credentials `M.D.`, `M.P.H.`. */
export function splitName(raw: string): NameParts {
  let n = raw.replace(/\s+/g, ' ').trim()
  let honorific = ''
  for (let i = 0; i < 4; i++) {
    const m = n.match(LEADING_HONORIFIC)
    if (!m) break
    if (!honorific) honorific = m[0].trim()
    n = n.slice(m[0].length)
  }
  let credentials: string[] = []
  for (let i = 0; i < 12; i++) {
    const m = TRAILING_CREDENTIAL.exec(n)
    if (!m) break
    credentials.unshift(m[0].replace(/^[\s,]+/, ''))
    n = n.slice(0, m.index).trim()
  }
  n = n.replace(/[,;]+$/, '').trim()
  // A credential the lists do not know (`Jane Roe, FRSA`): the part after the first comma is not part of the name.
  const comma = n.indexOf(',')
  if (comma > 0 && !NAME_SUFFIX.test(n.slice(comma))) {
    const extra = n.slice(comma + 1).split(/[,\s]+/).filter(t => CREDENTIAL_LIKE.test(t))
    credentials = [...extra, ...credentials]
    n = n.slice(0, comma).trim()
  }
  return { honorific, bare: n, credentials }
}

/**
 * The name a transcript label, a model prompt or a stored speaker uses: no honorific, no
 * credentials (`Dr. Sally Greenwald, M.D., M.P.H.` -> `Sally Greenwald`). Keeps `Jr.`, `II`
 * and surnames that look like credentials (`Tran Do`).
 */
export function bareName(name: string): string {
  return splitName(name).bare
}

/** Same as `bareName`; the name this module's callers have always used for it. */
export const stripHonorifics = bareName

/** True when the whole string is credentials (`M.P.H.`, `MD, Ph.D.`): a fragment of a name, never a person. */
export function isCredentialOnly(raw: string): boolean {
  const n = raw.replace(/\s+/g, ' ').trim()
  return n.length > 0 && CREDENTIALS_ONLY.test(`, ${n}`)
}

/**
 * The credentials a text writes right after a name, exactly as it writes them, with the
 * separator before the first one: `, M.D., M.P.H.` or ` Ph.D.`. '' when the text writes
 * none. `after` is the text that follows the name. `vocabulary` is credentials the reader
 * proposed that the built-in list may not know (`FRSA`); a role is never accepted.
 */
export function credentialRun(after: string, vocabulary: readonly string[] = []): string {
  const extra = vocabulary.filter(t => CREDENTIAL_LIKE.test(t))
  const m = new RegExp(`^(?:${credentialAfter(extra)})+`, 'iu').exec(after)
  if (!m) return ''
  let run = m[0].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ')
  // A sentence's full stop after a dotless credential (`..., MD. She`) is not part of it.
  const last = /[^\s,]+$/.exec(run)?.[0] ?? ''
  if (last.endsWith('.') && !last.slice(0, -1).includes('.')) run = run.slice(0, -1)
  return run
}

/** A leading `Dr.` or `Prof.` written right before position `at` of `text`, as written, or ''. */
export function honorificBefore(text: string, at: number): string {
  return /(?:^|[^\p{L}\p{N}.])((?:dr|prof|professor)\.?)[ \t]+$/iu.exec(text.slice(0, at))?.[1] ?? ''
}

/**
 * Bare names for labels and prompts: honorific and credentials removed, a credential that
 * stands alone (the `M.P.H.` fragment older rows hold) dropped, repeats removed in order,
 * and anyone `isExcluded` says is somebody else (the host) left out.
 */
export function bareNames(
  names: readonly (string | null | undefined)[],
  isExcluded: (bare: string) => boolean = () => false
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    if (typeof raw !== 'string' || raw.trim() === '' || isCredentialOnly(raw)) continue
    const bare = bareName(raw)
    const key = foldForMatch(bare)
    if (!key || seen.has(key) || isExcluded(bare)) continue
    seen.add(key)
    out.push(bare)
  }
  return out
}
