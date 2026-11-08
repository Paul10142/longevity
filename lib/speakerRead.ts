/**
 * The confirmation read for an episode with a third voice: Claude reads the first
 * minutes of the transcript and says which speaker number is the named guest.
 *
 * WHY. The speaking-share rule (lib/deepgramSegments.ts) names a guest from numbers
 * alone: one voice does 80%+ of the non-host talking. That is almost always the guest,
 * but "almost" is not enough when a wrong name is worse than no name (corroboration
 * counts distinct speakers, so a misattribution invents agreement between people who
 * never spoke). A person would check by listening to the opening: the host says "my
 * guest today is Dr. X", someone answers "thanks for having me", the next question is
 * put to that person by name. Claude does the same read on the text. The guest is named
 * ONLY when the share rule and the read pick the same voice; any other outcome (the
 * read is unsure, picks another voice, fails, or is unreadable) leaves everyone
 * numbered, and the disagreement is returned so the caller can log it.
 *
 * COST. Only an episode the share rule would already name is read (an episode with two
 * voices never is, one with no standout voice cannot be named whatever the read says):
 * about one call per such episode (62 of the 220 episodes on disk on 2026-11-08, all
 * Huberman). Each sends about five minutes of speech (roughly 1,000 words) and gets one
 * number back, on a Sonnet model at low effort.
 *
 * SHAPE. Pure functions plus an INJECTED model call (`SpeakerLlm`), like lib/guestNames.ts,
 * so the tests never reach a model. `claudeSpeakerLlm` is the real one, through lib/llm.ts
 * (the subscription backend by default in the scripts). `SKIP_GUEST_VOICE_READ=1` skips the
 * read, for tests: the share rule then decides alone and the log says so.
 *
 * Nothing here touches the database.
 */
import {
  guestVoiceCall,
  nameSpeakers,
  voiceShares,
  dominantVoice,
  type DgSegment,
  type GuestRead,
  type GuestVoiceCall,
  type VoiceShare,
} from './deepgramSegments'
import { stopKindOf } from './guestNames'

/** How much of the opening is read. */
export const READ_WINDOW_MS = 5 * 60 * 1000
/** A hard cap on the excerpt, in case a five-minute window holds an unusually dense monologue. */
export const READ_MAX_CHARS = 12_000
/** Sonnet, not Haiku: attributing a speaker from conversational cues is a judgment, and the call is tiny. */
export const SPEAKER_READ_MODEL = 'claude-sonnet-5-5'
export const SPEAKER_READ_EFFORT = 'low' as const

/** `SKIP_GUEST_VOICE_READ=1` skips the read (tests). The share rule alone then decides, and the log says so. */
export function readSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKIP_GUEST_VOICE_READ === '1'
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The first `windowMs` of speech as turns, each speaker by their RAW diarization number
 * (`Speaker 0:`, `Speaker 1:`, `Speaker 2:`), consecutive utterances of one speaker joined.
 * Raw numbers, not the `Speaker 2`/`Speaker 3` labels the stored transcript uses for
 * non-hosts, so the answer is the same number the share rule works in.
 */
export function openingExcerpt(
  segments: readonly DgSegment[],
  windowMs = READ_WINDOW_MS,
  maxChars = READ_MAX_CHARS
): { text: string; speakers: number[] } {
  const spoken = segments.filter(s => s.speaker !== null && s.text.trim() !== '')
  if (spoken.length === 0) return { text: '', speakers: [] }
  const t0 = spoken[0].start_ms
  const turns: { speaker: number; text: string }[] = []
  for (const s of spoken) {
    if (s.start_ms - t0 >= windowMs) break
    const last = turns[turns.length - 1]
    if (last && last.speaker === s.speaker) last.text += ` ${s.text.trim()}`
    else turns.push({ speaker: s.speaker as number, text: s.text.trim() })
  }
  let text = turns.map(t => `Speaker ${t.speaker}: ${t.text}`).join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()} …`
  return { text, speakers: [...new Set(turns.map(t => t.speaker))] }
}

export const SPEAKER_SYSTEM_PROMPT = [
  `You work out who is who in a podcast transcript whose speakers were separated by an audio model but never named.`,
  `The speakers are numbered (Speaker 0, Speaker 1, …). The numbers only say which voice is which; they say nothing about who is the host.`,
  `You are given the host's name, the name of ONE guest, and the first minutes of the transcript. Say which speaker number is that guest.`,
  ``,
  `Evidence that counts: the host introduces the guest by name or credentials; a speaker answers that introduction ("thanks for having me"); someone is addressed by the guest's name; a speaker talks about their own research, practice or book in the first person in answer to the host's questions.`,
  `More than two speakers may appear (a stray fragment, a sponsor read, a clip). Only the one named guest matters.`,
  ``,
  `Answer "unsure" whenever the text does not settle it: nobody is introduced, two speakers could both be the guest, the guest has not spoken yet, or the evidence points to the host. A wrong answer is far worse than "unsure", so never guess.`,
  ``,
  `Reply with JSON only, no prose, no code fence: {"speaker": <number>} or {"speaker": "unsure"}.`,
].join('\n')

export function speakerUserPrompt(args: { host: string; guest: string; excerpt: string; speakers: readonly number[] }): string {
  return [
    `HOST: ${args.host}`,
    `GUEST: ${args.guest}`,
    `SPEAKERS IN THIS EXCERPT: ${args.speakers.map(n => `Speaker ${n}`).join(', ')}`,
    ``,
    `TRANSCRIPT (the start of the episode):`,
    args.excerpt,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

/**
 * The reply as a speaker number or `'unsure'`. Takes what `claudeJson` returns (an object
 * `{speaker: …}`) or raw text around one. A number that is not a speaker in the excerpt, or
 * anything unreadable, is `'unsure'`: a reply that cannot be trusted never names anyone.
 */
export function parseSpeakerReply(raw: unknown, allowed: readonly number[]): number | 'unsure' {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const body = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw
    try { value = JSON.parse(body) } catch { return 'unsure' }
  }
  if (!value || typeof value !== 'object') return 'unsure'
  const answer = (value as { speaker?: unknown }).speaker
  let n: number | null = null
  if (typeof answer === 'number' && Number.isInteger(answer)) n = answer
  else if (typeof answer === 'string') {
    const m = answer.trim().match(/^(?:speaker\s*)?(\d+)$/i)
    if (m) n = Number(m[1])
  }
  return n !== null && allowed.includes(n) ? n : 'unsure'
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** One model call: prompt in, parsed JSON (or text) out. */
export type SpeakerLlm = (system: string, user: string) => Promise<unknown>

/**
 * The model call the scripts use: `claudeJson` through lib/llm.ts, so `LLM_BACKEND=claude-code`
 * bills the subscription. The model and effort are arguments for tests and tuning.
 * Imported lazily so the pure functions above load without the SDK.
 */
export function claudeSpeakerLlm(model: string = SPEAKER_READ_MODEL): SpeakerLlm {
  return async (system, user) => {
    const { claudeJson } = await import('./llm')
    return claudeJson<unknown>(system, user, 1000, model, SPEAKER_READ_EFFORT)
  }
}

export type SpeakerReadResult = {
  read: GuestRead
  /** Why the read is `unsure` when something went wrong (a failed call, an unreadable reply); empty otherwise. */
  note: string
}

/**
 * Ask Claude which speaker is `guest`. Never throws for an ordinary failure (a bad reply, a
 * one-off error): that is `unsure`, which leaves everyone unnamed. A failure every later call
 * would repeat (a full usage window, a halted CLI, no `claude` command) IS thrown, so the caller
 * does not quietly bake `Speaker 2` into a transcript that a re-run could have named.
 */
export async function readGuestSpeaker(args: {
  segments: readonly DgSegment[]
  host: string
  guest: string
  llm: SpeakerLlm
}): Promise<SpeakerReadResult> {
  const { text, speakers } = openingExcerpt(args.segments)
  if (!text) return { read: 'unsure', note: 'no speech in the opening to read' }
  try {
    const reply = await args.llm(SPEAKER_SYSTEM_PROMPT, speakerUserPrompt({ host: args.host, guest: args.guest, excerpt: text, speakers }))
    return { read: parseSpeakerReply(reply, speakers), note: '' }
  } catch (err) {
    if (stopKindOf(err)) throw err
    return { read: 'unsure', note: `the read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}` }
  }
}

// ---------------------------------------------------------------------------
// One episode: names, with the read where it is needed
// ---------------------------------------------------------------------------

export type SpeakerNaming = {
  names: Map<number, string>
  /** Non-host voices with their share of the non-host words. */
  shares: VoiceShare[]
  /** The voice the share rule would name, or null. Set only when there are two or more non-host voices and one guest. */
  candidate: number | null
  /** The read, when one was made (or skipped); undefined when the rule made it unnecessary. */
  read: GuestRead | undefined
  note: string
  call: GuestVoiceCall
}

/**
 * Name the speakers of one episode. The read is made only when the share rule has a candidate
 * (exactly one guest, two or more non-host voices, one dominant): every other case is decided
 * by the rule alone, with no model call.
 */
export async function nameSpeakersWithRead(args: {
  segments: DgSegment[]
  guests: string[]
  host: string
  llm: SpeakerLlm
  skipRead?: boolean
}): Promise<SpeakerNaming> {
  const { segments, guests, host } = args
  const shares = voiceShares(segments)
  const candidate = guests.length === 1 && shares.length >= 2 ? dominantVoice(shares) : null
  let read: GuestRead | undefined
  let note = ''
  if (candidate !== null) {
    if (args.skipRead ?? readSkipped()) read = 'skipped'
    else ({ read, note } = await readGuestSpeaker({ segments, host, guest: guests[0], llm: args.llm }))
  }
  return {
    names: nameSpeakers(segments, guests, host, read),
    shares,
    candidate,
    read,
    note,
    call: guestVoiceCall(segments, guests, read),
  }
}
