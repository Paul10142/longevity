/**
 * Speaker review: Paul names the unnamed voices of an episode himself.
 *
 * WHY A PERSON, NOT A RULE. Diarization says how many voices there are and when each one
 * speaks; it never says who they are. With one guest and one other voice the answer is
 * forced, so the attach step names the guest on its own (lib/deepgramSegments.ts
 * `nameSpeakers`, unchanged). With a THIRD voice nothing in the audio settles it: on the
 * FoundMyFitness episodes the "third voice" is the host herself, recorded differently for
 * the interview than for the produced intro, so no speaking-share rule can tell her from
 * the guest, and a wrong name is worse than none (corroboration counts distinct speakers,
 * so a misattribution invents agreement between people who never spoke). Paul listens, then
 * clicks a name per voice on /admin/speakers.
 *
 * THE MAPPING. What he decides is stored in `sources.speaker_names` (migration 038), and
 * ONLY there, never in the transcript:
 *
 *     { "Speaker 2": { "name": "Rhonda Patrick", "check": "welcome to another episode of the" },
 *       "Speaker 3": { "name": "Ronald Krauss",  "check": "thanks so much for having me" },
 *       "Speaker 4": { "name": null,             "check": "this episode is brought to you" } }
 *
 * The key is the label the stored transcript carries (`Speaker N`, numbered by first
 * appearance among the non-opening voices, the order `nameSpeakers` uses). `name` is a bare
 * name from the row's own `authors` (or the show's host label), or `null` for "not a guest"
 * (an ad, a clip, a producer): that voice stays `Speaker N`. `check` is a fingerprint of the
 * first thing that voice says. The re-attach (scripts/attachTranscripts.ts) rebuilds the
 * labels from the Deepgram file and applies the mapping only if every `check` still matches
 * the voice that now carries that number, so a re-diarized file can never have a name
 * applied to the wrong voice: a mismatch ignores the whole mapping and says so.
 *
 * Pure (no I/O) apart from `suggestGuestSpeaker`'s injected model call; tested in
 * tests/speakerReview.test.ts.
 */
import { buildLabelledSegments, nameSpeakers, voiceOrder } from './deepgramSegments'
import type { DgSegment, LabelledSegment } from './deepgramSegments'
import { bareName, bareNames, foldForMatch } from './personName'
import { episodeLinks, isPublicUrl, publicVideoUrl } from './sourceLinks'
import type { SourceLinkInput } from './sourceLinks'
import { youtubeTimestampUrl } from './youtubeUtils'

/** One voice's saved answer. `name: null` means "not a guest" (the voice stays `Speaker N`). */
export type SpeakerAssignment = { name: string | null; check: string }
/** `sources.speaker_names`: the transcript's `Speaker N` label → Paul's answer. */
export type SpeakerNames = Record<string, SpeakerAssignment>

const UNNAMED = /^Speaker (\d+)$/
/** `Speaker 2`, `Speaker 3`, …: a voice nobody has named yet. */
export const isUnnamedLabel = (label: string): boolean => UNNAMED.test(label)

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The first things a voice says, as a short, forgiving key: lower case, letters and digits
 * only, the first 60 characters. Compared between what the review page saw (the stored
 * transcript) and what the re-attach sees (the Deepgram file), which differ only in
 * punctuation and spacing, never in the words.
 */
export function fingerprint(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60).trim()
}

// ---------------------------------------------------------------------------
// Reading a stored transcript back into turns
// ---------------------------------------------------------------------------

/** One turn of the stored transcript: a label and everything that voice says until the label changes. */
export type Turn = {
  label: string
  start_ms: number
  end_ms: number
  text: string
  /** The first utterance's own text (no label): what the fingerprint is taken from. */
  firstText: string
  words: number
}

/**
 * `timed_transcript` → turns. A segment that opens with `Speaker N: ` or `<a known name>: `
 * starts a turn; every other segment continues the current one (the attach writes the label
 * once per turn, on its first utterance). `knownNames` are the names that may appear as
 * labels (the host label and the row's guests); only those are recognised, so a sentence
 * that merely contains a colon never starts a turn. Segments before the first label are
 * dropped.
 */
export function parseTurns(segments: readonly LabelledSegment[], knownNames: readonly string[]): Turn[] {
  const names = [...new Set(knownNames.map(n => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const labelRe = new RegExp(`^(Speaker \\d+${names.length > 0 ? `|${names.join('|')}` : ''}): `)
  const turns: Turn[] = []
  for (const s of segments) {
    const m = labelRe.exec(s.text)
    const body = m ? s.text.slice(m[0].length) : s.text
    if (m) {
      turns.push({ label: m[1], start_ms: s.start_ms, end_ms: s.end_ms, text: body, firstText: body, words: wordCount(body) })
    } else if (turns.length > 0) {
      const t = turns[turns.length - 1]
      t.text += ` ${body}`
      t.end_ms = s.end_ms
      t.words += wordCount(body)
    }
  }
  return turns
}

/** What the page shows for one unnamed voice. */
export type SpeakerSummary = {
  label: string
  turns: number
  words: number
  /** Share of all the words the unnamed voices speak (not of the whole episode). */
  share: number
  /** The first few things this voice says, trimmed, each with where it starts. */
  firstTurns: { start_ms: number; text: string }[]
  /** Fingerprint of the first thing this voice says (saved with the answer). */
  check: string
}

/**
 * The unnamed voices (`Speaker N`) of a transcript in the order they first speak, each with
 * its size and its first `firstCount` turns (cut at `maxChars` on a word boundary).
 */
export function unnamedSpeakers(turns: readonly Turn[], firstCount = 3, maxChars = 300): SpeakerSummary[] {
  const byLabel = new Map<string, Turn[]>()
  for (const t of turns) if (isUnnamedLabel(t.label)) byLabel.set(t.label, [...(byLabel.get(t.label) ?? []), t])
  const total = [...byLabel.values()].reduce((a, ts) => a + ts.reduce((b, t) => b + t.words, 0), 0)
  return [...byLabel].map(([label, ts]) => {
    const words = ts.reduce((a, t) => a + t.words, 0)
    return {
      label,
      turns: ts.length,
      words,
      share: total > 0 ? words / total : 0,
      firstTurns: ts.slice(0, firstCount).map(t => ({ start_ms: t.start_ms, text: clip(t.text, maxChars) })),
      check: fingerprint(ts[0].firstText),
    }
  })
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).trimEnd()} …`
}

// ---------------------------------------------------------------------------
// Which names can be chosen, and saving an answer
// ---------------------------------------------------------------------------

/**
 * The names Paul can click for an episode: the host (the show's label, else `authors[0]`)
 * and every guest in `authors`, all bare (`Sally Greenwald`, not `Sally Greenwald, M.D.`),
 * because that is the form a transcript label takes. No repeats.
 */
export function assignableNames(authors: readonly string[] | null | undefined, hostLabel: string | null): string[] {
  const list = (authors ?? []).filter(a => typeof a === 'string' && a.trim() !== '')
  const host = hostLabel ?? (list[0] ? bareName(list[0]) : null)
  return bareNames([host, ...list])
}

export type AssignResult = { ok: true; names: SpeakerNames } | { ok: false; error: string }

/**
 * Check what the page posted and turn it into the mapping to store.
 *
 * `input` is `{ "Speaker 2": "Rhonda Patrick" | null }`: a name from `allowed` (matched ignoring
 * case and accents, stored in the allowed spelling) or `null` for "not a guest". Every key must be
 * a voice that is still unnamed in the transcript, and the fingerprint is computed HERE from the
 * stored transcript, never taken from the browser. Answers already saved for a label that has
 * since been applied to the transcript (so it is no longer a `Speaker N`) are kept as they were.
 */
export function buildAssignments(args: {
  input: unknown
  speakers: readonly SpeakerSummary[]
  allowed: readonly string[]
  existing?: SpeakerNames | null
}): AssignResult {
  const { input, speakers, allowed } = args
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'assignments must be an object of speaker label to name' }
  const entries = Object.entries(input as Record<string, unknown>)
  const byLabel = new Map(speakers.map(s => [s.label, s]))
  const canonical = new Map(allowed.map(n => [foldForMatch(n), n]))
  const fresh: SpeakerNames = {}
  for (const [label, value] of entries) {
    const speaker = byLabel.get(label)
    if (!speaker) return { ok: false, error: `${label} is not an unnamed voice in this transcript` }
    if (value === null) {
      fresh[label] = { name: null, check: speaker.check }
      continue
    }
    if (typeof value !== 'string') return { ok: false, error: `the answer for ${label} must be a name or null` }
    const name = canonical.get(foldForMatch(value))
    if (!name) return { ok: false, error: `"${value}" is not one of this episode's names (${allowed.join(', ') || 'none'})` }
    fresh[label] = { name, check: speaker.check }
  }
  const kept = Object.fromEntries(Object.entries(args.existing ?? {}).filter(([label]) => !byLabel.has(label)))
  return { ok: true, names: { ...kept, ...fresh } }
}

/** Read `sources.speaker_names` defensively: anything that is not the documented shape is dropped. */
export function readSpeakerNames(raw: unknown): SpeakerNames {
  const out: SpeakerNames = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [label, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isUnnamedLabel(label) || !v || typeof v !== 'object') continue
    const { name, check } = v as { name?: unknown; check?: unknown }
    if ((typeof name === 'string' || name === null) && typeof check === 'string') out[label] = { name: name as string | null, check }
  }
  return out
}

// ---------------------------------------------------------------------------
// The re-attach: applying a saved mapping to a Deepgram file
// ---------------------------------------------------------------------------

export type AssignedNaming = {
  names: Map<number, string>
  /** The labels whose saved name was applied (`Speaker 2 → Ronald Krauss`). */
  applied: string[]
  /** Why a saved mapping was NOT applied (the file no longer matches it), or null. */
  ignored: string | null
}

/**
 * `nameSpeakers`, plus Paul's saved answers. Without a mapping the result is exactly
 * `nameSpeakers`. With one, every answer is checked against the voice that now carries that
 * label (the fingerprint of its first utterance must match what Paul saw); if ANY check fails
 * the whole mapping is ignored, because the numbering may have shifted for all of them, and
 * `ignored` says why. A `null` answer keeps that voice as `Speaker N`.
 */
export function nameSpeakersAssigned(
  segments: DgSegment[],
  guests: string[],
  host: string,
  assigned: SpeakerNames | null | undefined
): AssignedNaming {
  const names = nameSpeakers(segments, guests, host)
  const entries = Object.entries(assigned ?? {})
  if (entries.length === 0) return { names, applied: [], ignored: null }

  const voices = voiceOrder(segments)
  const resolved: [number, string, SpeakerAssignment][] = []
  for (const [label, answer] of entries) {
    const idx = Number(UNNAMED.exec(label)?.[1]) - 2
    const voice = voices[idx]
    if (voice === undefined) return { names, applied: [], ignored: `${label} is not a voice in this file (it has ${voices.length} besides the host)` }
    const firstUtterance = segments.find(s => s.speaker === voice)?.text ?? ''
    if (fingerprint(firstUtterance) !== answer.check) {
      return { names, applied: [], ignored: `${label} no longer starts with what was reviewed ("${answer.check}"): the file was re-transcribed, review it again` }
    }
    resolved.push([voice, label, answer])
  }
  const applied: string[] = []
  for (const [voice, label, answer] of resolved) {
    if (answer.name === null) continue
    names.set(voice, answer.name)
    applied.push(`${label} → ${answer.name}`)
  }
  return { names, applied, ignored: null }
}

/** The labelled transcript the attach would store for these names (a convenience for tests and previews). */
export function labelledTranscript(segments: DgSegment[], names: Map<number, string>): string {
  return buildLabelledSegments(segments, names).map(s => s.text).join(' ')
}

// ---------------------------------------------------------------------------
// The link to the original, at a moment
// ---------------------------------------------------------------------------

/** `m:ss`, or `h:mm:ss` from an hour up. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export type OriginalLink = { href: string; label: string; timed: boolean }

/**
 * Where to hear the original at `start_ms`, or the nearest thing.
 *   - a public YouTube video: the video with `&t=` (or `?t=`) at that second,
 *   - a public audio file (`media_url`): the file with `#t=` at that second,
 *   - otherwise the episode's public page (or a search on the show's own site), which cannot
 *     seek (`timed: false`): the page then shows the timestamp as text.
 * `sources.url` is the private member feed on the podcast rows and is never used here:
 * `episodeLinks` (lib/sourceLinks.ts) already keeps it out. The audio of the feed episodes
 * lives on the runner's Mac, which is why they fall in the last case.
 */
export function originalLink(
  row: SourceLinkInput & { media_url?: string | null },
  start_ms: number
): OriginalLink | null {
  const at = formatTimestamp(start_ms)
  const video = publicVideoUrl(row)
  const videoAt = video ? youtubeTimestampUrl(video, start_ms) : null
  if (videoAt) return { href: videoAt, label: `Play On YouTube At ${at}`, timed: true }
  if (isPublicUrl(row.media_url) && Number.isFinite(start_ms)) {
    return { href: `${row.media_url.trim()}#t=${Math.max(0, Math.floor(start_ms / 1000))}`, label: `Play Audio At ${at}`, timed: true }
  }
  const page = episodeLinks(row)[0]
  return page ? { href: page.href, label: page.label, timed: false } : null
}

// ---------------------------------------------------------------------------
// A suggestion (never a write)
// ---------------------------------------------------------------------------

/**
 * Which stored label a model read of the opening names as the one guest, or null. The stored
 * transcript's turns become pseudo-segments numbered by first appearance (the opening voice is 0,
 * the host by the episode's structure), the read (lib/speakerRead.ts) answers with a number, and the
 * answer maps back to a label. Only an UNNAMED voice can be suggested: if the read picks the
 * opening voice (a cold open clip of the guest, say) or is unsure, nothing is suggested. The page
 * shows this as a highlight on the buttons; it never saves anything.
 */
export type GuestSuggestion = { label: string | null; why: string }

export async function suggestGuestSpeaker(args: {
  turns: readonly Turn[]
  host: string
  guest: string
  read: (segments: DgSegment[], host: string, guest: string) => Promise<{ voice: number | null; why: string }>
}): Promise<GuestSuggestion> {
  const order: string[] = []
  const segments: DgSegment[] = args.turns.map(t => {
    if (!order.includes(t.label)) order.push(t.label)
    return { speaker: order.indexOf(t.label), text: t.text, start_ms: t.start_ms, end_ms: t.end_ms }
  })
  if (!order.some(isUnnamedLabel)) return { label: null, why: 'every voice already has a name' }
  const answer = await args.read(segments, args.host, args.guest)
  if (answer.voice === null) return { label: null, why: answer.why }
  const label = order[answer.voice]
  if (!label || !isUnnamedLabel(label)) return { label: null, why: `the read picked ${label ?? 'a voice that is not in the transcript'}, which is not an unnamed voice` }
  return { label, why: `A read of the first five minutes says ${label} is ${args.guest}` }
}

