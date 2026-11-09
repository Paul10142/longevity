/**
 * Deterministic post-extraction gate (2026-11-08).
 *
 * The fidelity judge (lib/extractionFidelity.ts) flagged 35% of a sampled set of
 * claims, mostly ADDED_DETAIL and DROPPED_QUALIFIER. A prompt can only ask the
 * model not to do that; this gate checks, with no model call, three things that
 * can be verified mechanically against the chunk the insight came from:
 *
 *   1. every number in the insight is in the chunk (digits or spelled out);
 *   2. every hedge or degree word in the quoted span survives into the insight
 *      ("probably", "might", "seems", "very", "if", "I think", "about 40", …);
 *   3. the `direct_quote` is verbatim in the chunk (repaired to its longest
 *      verbatim prefix when it can be, otherwise the insight is rejected).
 *
 * It is deliberately coarse. It cannot see an invented mechanism or a narrowed
 * population; the judge and the prompt own those. What it buys is a cheap floor:
 * an insight that fails here is certain to be wrong in a way a clinician would
 * care about, or is unverifiable, and costs no model call to find out.
 *
 * Pure functions, no I/O, no database: safe to import anywhere.
 */

import { resolveQuote } from './quoteResolve'

// ── Types ───────────────────────────────────────────────────

/** The fields of an extracted insight the gate reads (and, for the quote, repairs). */
export type GateInsight = {
  statement: string
  context_note?: string | null
  direct_quote?: string | null
  speaker?: string | null
  qualifiers?: Record<string, unknown> | null
}

export type GateRule = 'number_not_in_chunk' | 'hedge_dropped' | 'quote_not_in_chunk'

export type GateViolation = {
  rule: GateRule
  /** What failed: the number, the hedge word from the quote, or the unverifiable quote. */
  detail: string
}

export type GateResult = {
  ok: boolean
  violations: GateViolation[]
  /** The quote after repair (longest verbatim prefix), or null when none verifies. */
  quote: string | null
  /** True when the quote was shortened to a verbatim prefix. */
  quoteRepaired: boolean
}

// ── 1. Numbers ──────────────────────────────────────────────

const UNITS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 }
/** Words that stand for a number on their own. ("one" is excluded: it is an article far more often than a count.) */
const SINGLE_WORDS: Record<string, number> = { twice: 2, thrice: 3, dozen: 12, decade: 10, decades: 10 }

/** Numbers named by digits: "40", "1,200", "0.5", "10k", "1990s". Glued identifiers (B12, VO2, ApoB100) are not counts. */
const DIGIT_NUMBER = /(?<![A-Za-z\d.])(\d[\d,]*(?:\.\d+)?)(k|s|x|%|th|st|nd|rd)?(?![A-Za-z\d])/g

function addDigitNumbers(text: string, into: Set<number>, includeSmall: boolean): void {
  for (const m of text.matchAll(DIGIT_NUMBER)) {
    const raw = m[1].replace(/,/g, '')
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    if (!includeSmall && (n === 0 || n === 1)) continue
    into.add(n)
    if (m[2] === 'k') into.add(n * 1000)
    if (m[1].includes(',')) into.add(Number(m[1].replace(/,/g, '')))
  }
}

/**
 * Numbers spelled out: "thirty five" → 35, "two hundred fifty" → 250, "a hundred and fifty" → 150,
 * "twenty nineteen" → 2019, "twice" → 2. Punctuation ends a phrase, so "two, three" is 2 and 3, never 5.
 * With `components` (the chunk side), each word's own value is added too, so a transcript's looser
 * phrasing never makes a legitimate number look absent.
 */
function addWordNumbers(text: string, into: Set<number>, components = false): void {
  const tokens = text.toLowerCase().replace(/-/g, ' ').match(/[a-z']+|[^a-z'\s]/g) ?? []
  const val = (w: string | undefined): number | undefined =>
    w === undefined ? undefined : UNITS[w] ?? TENS[w] ?? SCALES[w] ?? SINGLE_WORDS[w]
  let prevPhrase: number | null = null
  let prevEnd = -1
  let i = 0
  while (i < tokens.length) {
    const w = tokens[i]
    if (SINGLE_WORDS[w] !== undefined) { into.add(SINGLE_WORDS[w]); i++; continue }
    const startsPhrase =
      UNITS[w] !== undefined || TENS[w] !== undefined ||
      ((w === 'a' || w === 'one') && SCALES[tokens[i + 1]] !== undefined)
    if (!startsPhrase) { i++; continue }
    let total = 0, current = 0, j = i, plainLast = false, scaleLast = false
    for (;;) {
      const t = tokens[j]
      if ((t === 'a' || t === 'one') && SCALES[tokens[j + 1]] !== undefined && !plainLast) {
        current = 1; j++; plainLast = false; scaleLast = false
      } else if (SCALES[t] !== undefined) {
        if (t === 'hundred') current = (current || 1) * 100
        else { total += (current || 1) * SCALES[t]; current = 0 }
        j++; plainLast = false; scaleLast = true
      } else if (TENS[t] !== undefined && !plainLast) {
        current += TENS[t]
        j++
        if (UNITS[tokens[j]] !== undefined && UNITS[tokens[j]] < 10) { current += UNITS[tokens[j]]; j++ }
        plainLast = true; scaleLast = false
      } else if (UNITS[t] !== undefined && !plainLast) {
        current += UNITS[t]; j++; plainLast = true; scaleLast = false
      } else if (t === 'and' && scaleLast && (UNITS[tokens[j + 1]] !== undefined || TENS[tokens[j + 1]] !== undefined)) {
        j++
      } else break
    }
    const value = total + current
    if (j === i) { i++; continue }
    into.add(value)
    if (components) for (let k = i; k < j; k++) { const v = val(tokens[k]); if (v !== undefined) into.add(v) }
    // "twenty nineteen" / "nineteen ninety" read as a year.
    if (prevPhrase !== null && prevEnd === i && (prevPhrase === 19 || prevPhrase === 20) && value >= 10 && value <= 99) {
      into.add(prevPhrase * 100 + value)
    }
    prevPhrase = value; prevEnd = j
    i = j
  }
}

/** Every number a text states, by digits or by words. */
export function numbersIn(text: string, opts: { includeSmall?: boolean } = {}): Set<number> {
  const out = new Set<number>()
  addDigitNumbers(text, out, opts.includeSmall ?? true)
  addWordNumbers(text, out, true)
  return out
}

const ENUMERATION_COUNT = new RegExp(
  `\\b(?:${Object.keys(UNITS).join('|')})\\s+(?:[a-z-]+\\s+){0,2}(?:mechanisms?|pathways?|factors?|types?|kinds?|ways?|reasons?|causes?|categories|steps|components|phases|stages|principles|approaches|strategies|options|models|processes|systems|subtypes|classes|groups)\\b`,
  'gi'
)

function qualifierText(q: GateInsight['qualifiers']): string {
  if (!q) return ''
  return Object.values(q).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').join(' ')
}

/**
 * Numbers the insight asserts that the chunk does not contain. 0 and 1 written
 * as digits are ignored ("1 in 3" is checked by its 3; "type 1" is routine), and
 * so is "one" as a word.
 */
export function numbersNotInChunk(chunk: string, insight: GateInsight): number[] {
  const inChunk = numbersIn(chunk)
  const claimed = new Set<number>()
  const text = [insight.statement, insight.context_note ?? '', qualifierText(insight.qualifiers)].join(' ')
  addDigitNumbers(text, claimed, false)
  // "two adaptive mechanisms", "five primary causes": a count of the items the insight itself lists is the
  // writer's own enumeration, not a figure the speaker gave, so spelled-out counts of that shape are not checked.
  addWordNumbers(text.replace(ENUMERATION_COUNT, ' '), claimed)
  const missing: number[] = []
  for (const n of claimed) {
    if (inChunk.has(n)) continue
    // "50%" for a chunk that says "half", or "100" for "a hundred": covered above; a percent of a spoken
    // fraction is a derived figure and is judged by the judge, not here — but still flag it, it is unsupported.
    missing.push(n)
  }
  return missing.sort((a, b) => a - b)
}

// ── 2. Hedges and degrees ───────────────────────────────────

type HedgeRule = {
  name: string
  /** Fires on the quoted span. */
  trigger: RegExp
  /** Satisfied when the insight keeps this hedge or an equivalent. */
  kept: RegExp
}

const UNCERTAIN_FAMILY =
  /\b(probabl\w*|likel\w*|presum\w*|may|might|could|suggest\w*|appear\w*|seem\w*|possibl\w*|perhaps|maybe|potential\w*|tend\w*|often|usually|mostly|largely|generally|unclear|uncertain|unknown|unsure|not (?:known|established|clear|certain|well understood|proven)|speculat\w*|estimat\w*|guess\w*|believ\w*|think\w*|thought|expect\w*|hypothes\w*|suspect\w*|anecdot\w*|impression|hunch|opinion|sometimes|can|approximat\w*|roughly|about|around|nearly|almost)\b/i

const HEDGE_RULES: HedgeRule[] = [
  {
    name: 'probably/likely',
    trigger: /\b(probably|presumably|most likely|very likely|likely)\b/i,
    kept: UNCERTAIN_FAMILY,
  },
  {
    name: 'might/maybe/possibly',
    trigger: /\b(might|maybe|perhaps|possibly|potentially|could be|may be|may)\b/i,
    kept: UNCERTAIN_FAMILY,
  },
  {
    name: 'seems/appears',
    trigger: /\b(seems?|seemed|appears?|appeared|suggests?|looks like)\b/i,
    kept: UNCERTAIN_FAMILY,
  },
  {
    name: 'I think/guess',
    trigger: /\b(?:i|we) (?:think|guess|believe|suspect|bet|would guess|'d guess|imagine|assume|figure)\b|\bmy (?:guess|sense|hunch|impression|gut|feeling|suspicion)\b|\bi'?m not sure\b|\bi don'?t know\b|\bnot sure\b/i,
    kept: UNCERTAIN_FAMILY,
  },
  {
    name: 'very/extremely',
    trigger: /\b(very|extremely|incredibly|massively|hugely|enormously|tremendously)\b/i,
    kept: /\b(very|extremely|incredibl\w*|highly|massiv\w*|huge\w*|enormous\w*|tremendous\w*|markedly|substantial\w*|strong\w*|major|large|significant\w*|profound\w*|dramatic\w*|considerabl\w*|particularly|especially|greatly|vastly|overwhelming\w*|critical\w*|key)\b/i,
  },
  {
    name: 'if',
    trigger: /\bif\b/i,
    kept: /\b(if|when|whenever|unless|only|provided|given|depend\w*|conditional\w*|condition\w*|once|where|as long as|assuming|contingent|should|those who|people who|patients who|in (?:those|people|patients|cases|individuals|persons)|among|for (?:those|people|patients|someone|anyone)|whether|case|cases|in which|after|before|while|during|with|without)\b/i,
  },
  {
    name: 'about/roughly',
    trigger: new RegExp(
      `\\b(?:about|around|roughly|approximately|somewhere (?:around|between|in)|something like|nearly|almost|close to)\\s+(?:\\$|~)?(?:\\d|(?:${[...Object.keys(UNITS), ...Object.keys(TENS), 'a hundred', 'a thousand', 'one'].join('|')})\\b)`,
      'i'
    ),
    kept: /\b(?:about|around|roughly|approximately|approx|nearly|almost|close to|estimat\w*|up to|some|between|range|ranging|~)\b|~/i,
  },
]

/** Hedge/degree rules triggered by the quoted span but not honoured by the insight text. */
export function hedgesDropped(
  quote: string,
  insight: Pick<GateInsight, 'statement' | 'context_note' | 'speaker'>
): string[] {
  if (!quote.trim()) return []
  const kept = [insight.statement, insight.context_note ?? ''].join(' ')
  // A statement attributed to its speaker ("Attia estimated …") states a guess as a guess.
  const speakerSurname = insight.speaker?.trim().split(/\s+/).pop()
  const attributed = speakerSurname && speakerSurname.length > 2
    ? new RegExp(`\\b${speakerSurname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(kept)
    : false
  const dropped: string[] = []
  for (const rule of HEDGE_RULES) {
    const hit = quote.match(rule.trigger)
    if (!hit) continue
    if (rule.kept.test(kept)) continue
    // Attribution to the speaker preserves a personal hedge ("I think", "my guess") — nothing else.
    if (attributed && rule.name === 'I think/guess') continue
    dropped.push(hit[0].trim().toLowerCase())
  }
  return dropped
}

// ── 3 + gate ────────────────────────────────────────────────

/**
 * Run all three checks for one insight against its chunk.
 *
 * An absent quote (the model returned null, which the prompt allows) is not a
 * violation — the numbers are still checked against the whole chunk, but there
 * is no span to check hedges against. A quote that is present but not verbatim
 * is repaired to its longest verbatim prefix; if none verifies it is a violation.
 */
export function gateInsight(chunk: string, insight: GateInsight): GateResult {
  const violations: GateViolation[] = []

  let quote: string | null = null
  let quoteRepaired = false
  const raw = insight.direct_quote?.trim() || null
  if (raw) {
    const resolved = resolveQuote(chunk, raw)
    if (resolved.text === null) {
      violations.push({ rule: 'quote_not_in_chunk', detail: raw.slice(0, 120) })
    } else {
      quote = resolved.text
      quoteRepaired = resolved.text !== raw
    }
  }

  for (const n of numbersNotInChunk(chunk, insight)) {
    violations.push({ rule: 'number_not_in_chunk', detail: String(n) })
  }

  if (quote) {
    for (const h of hedgesDropped(quote, insight)) {
      violations.push({ rule: 'hedge_dropped', detail: h })
    }
  }

  return { ok: violations.length === 0, violations, quote, quoteRepaired }
}

export type GateOutcome<T extends GateInsight> = {
  kept: T[]
  rejected: { insight: T; violations: GateViolation[] }[]
}

/** Gate a whole chunk's insights. Kept insights carry the repaired quote. */
export function applyGate<T extends GateInsight>(chunk: string, insights: T[]): GateOutcome<T> {
  const kept: T[] = []
  const rejected: { insight: T; violations: GateViolation[] }[] = []
  for (const insight of insights) {
    const g = gateInsight(chunk, insight)
    if (g.ok) kept.push({ ...insight, direct_quote: g.quote })
    else rejected.push({ insight, violations: g.violations })
  }
  return { kept, rejected }
}

/** One line per violation, for the repair prompt and for logs. */
export function describeViolation(v: GateViolation): string {
  switch (v.rule) {
    case 'number_not_in_chunk':
      return `the number ${v.detail} does not appear in the text`
    case 'hedge_dropped':
      return `the speaker's hedge or degree word "${v.detail}" is in the quoted span but not carried into the insight`
    case 'quote_not_in_chunk':
      return `the direct_quote is not word-for-word in the text: "${v.detail}"`
  }
}
