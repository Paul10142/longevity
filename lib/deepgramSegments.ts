/**
 * Deepgram utterances → the transcript shape the pipeline stores.
 *
 * Shared by scripts/attachTranscripts.ts (new episodes) and
 * scripts/repairDeepgramTiming.ts (fixing the ones already attached).
 *
 * THE 2026-10-12 TIMING BUG. The first attach merged consecutive utterances by
 * the same speaker into ONE timed segment, so a six-minute host monologue became
 * a single segment starting at 0:11. Chunks are ~2,400 characters (a minute or
 * two of speech), so every chunk inside that monologue — and every insight in
 * them — inherited 0:11. Episode 387 kept 79 segments out of 1,340 utterances;
 * Paul spotted six chunks at 0:11 followed by a jump to 4:59. Timing was coarse,
 * not wrong, but a deep-link that lands minutes early is useless for following
 * along.
 *
 * Now every utterance stays its own segment (median ~3 s). The speaker label is
 * written ONCE per turn, at the start of the turn's first utterance, exactly as
 * before — so `segments.map(s => s.text).join(' ')` is byte-identical to the
 * transcript the merged version produced, and the chunk→segment alignment in
 * lib/transcriptSegments.ts needs no change.
 */

import { bareName, bareNames, foldForMatch } from './personName'

export type DgSegment = { text: string; speaker: number | null; start_ms: number; end_ms: number }
export type LabelledSegment = { text: string; start_ms: number; end_ms: number }

export type GuestChoice = {
  guests: string[]
  /** Where the list came from: the source row's `authors`, the feed manifest, or neither (no row, no manifest entry). */
  from: 'authors' | 'manifest' | 'none'
}

/**
 * Which guest names label the speakers of one episode.
 *
 * `sources.authors` is the single record of who the guests are: `[host, ...guests]`,
 * written by the ingest and then corrected by `scripts/refreshGuests.ts` (Claude
 * reads the title and show notes). The attach used to take guests from the
 * `manifest.json` that `fetchPodcastFeed` writes in each audio folder, which holds
 * only the title-rule guests, so applying a guest plan did not change the
 * `Name:` labels baked into the transcripts.
 *
 *   - Row has authors: guests are `authors.slice(1)`. Authors that are just the
 *     host mean the episode has NO guest, which is a real answer, so the manifest
 *     is NOT consulted. Anyone who repeats the host (by the first author's name
 *     or the show's host label) is dropped, and repeats are removed, in order.
 *   - Row has no authors value (null or empty): the manifest guests, as before.
 *   - No row: the manifest guests too (callers skip such an episode anyway).
 *
 * LABELS ARE BARE. `authors` carries each guest as the show writes them, credentials
 * included (`Sally Greenwald, M.D., M.P.H.`); the label is `Sally Greenwald:`. A
 * credential in a label would make one person two speakers, and corroboration counts
 * distinct speakers. So every name returned here has its `Dr.`/credentials removed
 * (`bareName`), and a credential left standing alone by the old comma split
 * (`M.P.H.`) is dropped rather than counted as a second guest, which would stop the
 * guest being named at all (`nameSpeakers` needs exactly one). The manifest's names
 * get the same treatment.
 */
export function guestsForLabels(args: {
  row: { authors: string[] | null } | null | undefined
  manifestGuests: readonly string[] | undefined
  /** The show's host label (`hostLabelForKey(key)`), which `nameSpeakers` puts on the opening speaker. */
  host: string
}): GuestChoice {
  const { row, manifestGuests, host } = args
  const authors = row?.authors?.filter(a => typeof a === 'string' && a.trim() !== '')
  if (authors && authors.length > 0) {
    const hostKeys = new Set([foldForMatch(bareName(authors[0])), foldForMatch(host)])
    return { guests: bareNames(authors.slice(1), name => hostKeys.has(foldForMatch(name))), from: 'authors' }
  }
  if (manifestGuests) return { guests: bareNames(manifestGuests), from: 'manifest' }
  return { guests: [], from: 'none' }
}

// ---------------------------------------------------------------------------
// A third voice: when can the one named guest still be told apart?
// ---------------------------------------------------------------------------

/**
 * THE SPEAKING-SHARE RULE (Paul, 2026-11-08: "when there is a third voice, can we
 * still identify the guest?"). With one named guest and two or more voices besides
 * the host, the guest is named only when ONE voice does nearly all of the non-host
 * talking:
 *
 *   - that voice holds at least `GUEST_VOICE_MIN_SHARE` of the non-host WORDS, and
 *   - every other non-host voice holds under `OTHER_VOICE_MAX_SHARE`.
 *
 * Why these numbers. In an interview the guest answers nearly everything; the extra
 * voice is a stray (diarization splitting a few of the guest's sentences off, a
 * clip, a sponsor read, a caller). 80% / 10% leaves a wide gap on each side: a split
 * like 45/55 is two real people (or one guest cut in two) and nothing in the audio
 * says which is the guest, so nobody is named. The small voices stay `Speaker N`
 * either way: they could be anyone. A word count, not seconds, so a slow talker is
 * not out-voted by a fast one.
 *
 * The rule alone is never enough in production: see lib/speakerRead.ts, where Claude
 * reads the first minutes and must name the SAME voice. A wrong name is worse than no
 * name, because corroboration counts distinct speakers.
 */
export const GUEST_VOICE_MIN_SHARE = 0.8
export const OTHER_VOICE_MAX_SHARE = 0.1

/** One non-host voice: its Deepgram speaker number, its words, and its share of ALL non-host words. */
export type VoiceShare = { speaker: number; words: number; share: number }

/** The opening speaker (the host, by the episode's structure), or null when nothing is diarized. */
export function openingSpeaker(segments: readonly DgSegment[]): number | null {
  return segments.find(s => s.speaker !== null)?.speaker ?? null
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/**
 * Every voice except the opener, in the order each first speaks, with its share of the
 * non-host words. The order is the one `nameSpeakers` has always numbered `Speaker 2`,
 * `Speaker 3`, … in, so a voice keeps its number whether or not another voice is named.
 */
export function voiceShares(segments: readonly DgSegment[]): VoiceShare[] {
  const first = openingSpeaker(segments)
  const words = new Map<number, number>()
  for (const s of segments) {
    if (s.speaker === null || s.speaker === first) continue
    words.set(s.speaker, (words.get(s.speaker) ?? 0) + wordCount(s.text))
  }
  const total = [...words.values()].reduce((a, b) => a + b, 0)
  return [...words].map(([speaker, w]) => ({ speaker, words: w, share: total > 0 ? w / total : 0 }))
}

/** The voice that holds the guest's share of the talking (see the rule above), or null when none does. */
export function dominantVoice(shares: readonly VoiceShare[]): number | null {
  if (shares.length < 2) return null
  const top = shares.reduce((a, b) => (b.share > a.share ? b : a))
  if (top.share < GUEST_VOICE_MIN_SHARE) return null
  return shares.every(v => v === top || v.share < OTHER_VOICE_MAX_SHARE) ? top.speaker : null
}

/**
 * What the confirmation read (lib/speakerRead.ts) said about which voice is the named guest:
 * a speaker number, `'unsure'`, or `'skipped'` (no read was made, `SKIP_GUEST_VOICE_READ=1`: for tests).
 * `undefined` means no read was offered at all, so a third voice is never named.
 */
export type GuestRead = number | 'unsure' | 'skipped'

/** Which voice, if any, is named as the one guest, and one plain sentence saying why. */
export type GuestVoiceCall = { speaker: number | null; reason: string }

const pct = (share: number) => `${Math.round(share * 100)}%`

/**
 * Decide which voice gets the one guest's name. Pure: the read, if any, is an argument.
 *
 *   - not exactly one guest, or no voice besides the host: nobody.
 *   - exactly one other voice: that voice (the long-standing two-voice rule, no read needed).
 *   - two or more other voices: the dominant voice by the speaking-share rule, and only when
 *     the read named the SAME voice. A read that is missing, unsure or names another voice
 *     leaves everyone unnamed.
 */
export function guestVoiceCall(segments: readonly DgSegment[], guests: readonly string[], read?: GuestRead): GuestVoiceCall {
  const shares = voiceShares(segments)
  if (guests.length !== 1) {
    return {
      speaker: null,
      // Two guests and two unnamed speakers is NOT enough to pair them: the feed lists guests in title order,
      // which need not match speaking order.
      reason: guests.length === 0 ? 'no guest is listed' : `${guests.length} guests are listed; voices cannot be paired with names`,
    }
  }
  if (shares.length === 0) return { speaker: null, reason: 'no voice besides the host' }
  if (shares.length === 1) return { speaker: shares[0].speaker, reason: 'two voices: the other voice is the guest' }

  const dominant = dominantVoice(shares)
  const biggest = Math.max(...shares.map(v => v.share))
  if (dominant === null) {
    return {
      speaker: null,
      reason:
        `${shares.length} non-host voices and none stands out (the largest holds ${pct(biggest)}; the rule needs ` +
        `${pct(GUEST_VOICE_MIN_SHARE)} with every other voice under ${pct(OTHER_VOICE_MAX_SHARE)})`,
    }
  }
  const sharePart = `voice ${dominant} holds ${pct(shares.find(v => v.speaker === dominant)!.share)} of the non-host words`
  if (read === undefined) return { speaker: null, reason: `${sharePart}, but no confirmation read was made` }
  if (read === 'skipped') return { speaker: dominant, reason: `${sharePart}; confirmation read skipped, the share rule alone decided` }
  if (read === 'unsure') return { speaker: null, reason: `${sharePart}, but the confirmation read was unsure` }
  if (read !== dominant) return { speaker: null, reason: `${sharePart}, but the confirmation read picked voice ${read}: they disagree` }
  return { speaker: dominant, reason: `${sharePart} and the confirmation read agrees` }
}

/**
 * Map Deepgram's speaker indices to names, or leave them numbered.
 *
 * Diarization establishes that people alternate; it never says who they
 * are. The speaker who opens the episode is the host (these episodes begin with
 * a scripted host intro). When the feed names EXACTLY ONE guest, the guest is
 *   - the one other speaker, when there is only one (two voices), or
 *   - the one voice that does nearly all of the non-host talking, when there are
 *     more AND `read` (the confirmation read) agrees; see `guestVoiceCall`.
 * Anyone else stays `Speaker 2`, `Speaker 3`, … A voice keeps the number it would
 * have had, so naming the guest changes only the guest's label.
 * A wrong name is worse than no name: corroboration counts DISTINCT speakers,
 * so a misattribution invents agreement between people who never spoke.
 *
 * `host` is a REQUIRED argument, never a default: it is the show's host label
 * (`hostLabelForKey(key)` in lib/shows.ts, resolved from the join key's prefix).
 * It used to be a constant "Peter Attia", which would have labelled Andrew
 * Huberman's opening monologue as Peter Attia the first time a Huberman Lab
 * episode was attached.
 *
 * Without `read` the third-voice rule is off and the result is exactly what it was
 * before it existed (callers that rebuild an old transcript rely on that).
 */
export function nameSpeakers(segments: DgSegment[], guests: string[], host: string, read?: GuestRead): Map<number, string> {
  const names = new Map<number, string>()
  const first = openingSpeaker(segments)
  if (first == null) return names
  names.set(first, host)

  const others = voiceShares(segments).map(v => v.speaker)
  const guest = guestVoiceCall(segments, guests, read).speaker
  others.forEach((sp, i) => names.set(sp, sp === guest ? guests[0] : `Speaker ${i + 2}`))
  return names
}

/**
 * One segment per utterance, the speaker label on the first utterance of each
 * turn. Consecutive utterances by the same speaker share a turn.
 */
export function buildLabelledSegments(segments: DgSegment[], names: Map<number, string>): LabelledSegment[] {
  const out: LabelledSegment[] = []
  let currentLabel: string | null = null
  for (const s of segments) {
    const label = s.speaker != null ? names.get(s.speaker) ?? `Speaker ${s.speaker + 1}` : null
    const newTurn = label !== null && label !== currentLabel
    if (label !== null) currentLabel = label
    out.push({ text: newTurn ? `${label}: ${s.text}` : s.text, start_ms: s.start_ms, end_ms: s.end_ms })
  }
  return out
}

/** The stored `sources.transcript` is the segments' text joined by single spaces. */
export function transcriptText(segments: LabelledSegment[]): string {
  return segments.map(s => s.text).join(' ')
}
