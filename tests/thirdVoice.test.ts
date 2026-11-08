/**
 * Tests for naming the guest when an episode has a third diarized voice
 * (lib/deepgramSegments.ts `guestVoiceCall` / `nameSpeakers`, lib/speakerRead.ts).
 *
 * Synthetic segment lists only: no model is reached (the model call is injected) and
 * nothing touches the database. The rule under test: with ONE named guest and two or more
 * voices besides the host, the guest is named only when one voice holds 80%+ of the
 * non-host words, every other voice is under 10%, AND the confirmation read names the same
 * voice. Two voices are named exactly as before. Anything less sure stays `Speaker N`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUEST_VOICE_MIN_SHARE,
  OTHER_VOICE_MAX_SHARE,
  buildLabelledSegments,
  dominantVoice,
  guestVoiceCall,
  nameSpeakers,
  transcriptText,
  voiceShares,
  type DgSegment,
} from '../lib/deepgramSegments'
import {
  SPEAKER_READ_MODEL,
  nameSpeakersWithRead,
  openingExcerpt,
  parseSpeakerReply,
  readGuestSpeaker,
  type SpeakerLlm,
} from '../lib/speakerRead'
import { UsageLimitError } from '../lib/usageLimit'

const HOST = 'Rhonda Patrick'
const GUEST = 'Sally Greenwald'

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
let clock = 0
const utt = (speaker: number | null, nWords: number, startMs?: number): DgSegment => {
  const start_ms = startMs ?? (clock += 2000)
  return { speaker, text: words(nWords), start_ms, end_ms: start_ms + 1500 }
}

/** Host opens, then the guest voices talk in the given word counts (voice 1, 2, 3, … in that order). */
function episode(guestWords: number[]): DgSegment[] {
  clock = 0
  const segs: DgSegment[] = [utt(0, 40, 0)]
  guestWords.forEach((w, i) => { segs.push(utt(i + 1, w), utt(0, 10)) })
  return segs
}

/** A model stub that answers with `reply` and counts its calls. */
function stub(reply: unknown): SpeakerLlm & { calls: number } {
  const f: SpeakerLlm & { calls: number } = Object.assign(
    async () => { f.calls++; return reply },
    { calls: 0 }
  )
  return f
}

const labelOf = (names: Map<number, string>) => [...names].map(([k, v]) => `${k}=${v}`).join(', ')

// --- the two-voice case: unchanged ---------------------------------------------------------------------------------

test('two voices and one guest: the other voice is the guest, with or without a read, and no model is asked', async () => {
  const segs = episode([500])
  assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST)), `0=${HOST}, 1=${GUEST}`)
  assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST, 'unsure')), `0=${HOST}, 1=${GUEST}`)
  const llm = stub({ speaker: 1 })
  const r = await nameSpeakersWithRead({ segments: segs, guests: [GUEST], host: HOST, llm })
  assert.equal(labelOf(r.names), `0=${HOST}, 1=${GUEST}`)
  assert.equal(r.candidate, null)
  assert.equal(llm.calls, 0)
})

test('two voices and no guest, or two guests: the other voice stays Speaker 2', () => {
  const segs = episode([500])
  assert.equal(nameSpeakers(segs, [], HOST).get(1), 'Speaker 2')
  assert.equal(nameSpeakers(segs, ['A One', 'B Two'], HOST).get(1), 'Speaker 2')
})

// --- the dominant voice --------------------------------------------------------------------------------------------

test('a dominant voice (90%) with a stray (4%) and a small one (6%) is named only when the read agrees', () => {
  const segs = episode([900, 40, 60])
  const shares = voiceShares(segs)
  assert.deepEqual(shares.map(v => v.speaker), [1, 2, 3])
  assert.equal(dominantVoice(shares), 1)

  // The read agrees: only the guest's label changes. The small voices keep the number they always had.
  assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST, 1)), `0=${HOST}, 1=${GUEST}, 2=Speaker 3, 3=Speaker 4`)
  assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST)), `0=${HOST}, 1=Speaker 2, 2=Speaker 3, 3=Speaker 4`)
  // Anything else leaves every non-host voice numbered, exactly as today.
  for (const read of ['unsure', 2, 0, undefined] as const) {
    assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST, read)), `0=${HOST}, 1=Speaker 2, 2=Speaker 3, 3=Speaker 4`, `read ${read}`)
  }
})

test('the guest need not be the first non-host voice to speak', () => {
  // Voice 1 is a 20-word stray that speaks first; voice 2 does the talking.
  clock = 0
  const segs = [utt(0, 40, 0), utt(1, 4), utt(0, 10), utt(2, 500), utt(0, 10), utt(2, 400)]
  assert.equal(dominantVoice(voiceShares(segs)), 2)
  assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST, 2)), `0=${HOST}, 1=Speaker 2, 2=${GUEST}`)
})

test('the call says why, in a plain sentence, for each outcome', () => {
  const segs = episode([920, 80])
  assert.match(guestVoiceCall(segs, [GUEST], 1).reason, /holds 92% .* read agrees/)
  assert.match(guestVoiceCall(segs, [GUEST]).reason, /no confirmation read was made/)
  assert.match(guestVoiceCall(segs, [GUEST], 'unsure').reason, /read was unsure/)
  assert.match(guestVoiceCall(segs, [GUEST], 2).reason, /picked voice 2: they disagree/)
  assert.match(guestVoiceCall(segs, [GUEST], 'skipped').reason, /share rule alone/)
  assert.equal(guestVoiceCall(segs, [GUEST], 'skipped').speaker, 1)
})

// --- thresholds ----------------------------------------------------------------------------------------------------

test('the thresholds are 80% and 10%, and an exact tie on a threshold does not name anyone', () => {
  assert.equal(GUEST_VOICE_MIN_SHARE, 0.8)
  assert.equal(OTHER_VOICE_MAX_SHARE, 0.1)
  // 91 / 9: named.
  assert.equal(dominantVoice(voiceShares(episode([910, 90]))), 1)
  // 90 / 10: the other voice is not UNDER 10%.
  assert.equal(dominantVoice(voiceShares(episode([900, 100]))), null)
  // 80 / 10 / 10: the dominant voice qualifies, the others are not under 10%.
  assert.equal(dominantVoice(voiceShares(episode([800, 100, 100]))), null)
  // 82 / 9 / 9: named.
  assert.equal(dominantVoice(voiceShares(episode([820, 90, 90]))), 1)
  // 79 / 21: below 80%.
  assert.equal(dominantVoice(voiceShares(episode([790, 210]))), null)
})

// --- an ambiguous split --------------------------------------------------------------------------------------------

test('a 45/55 split names nobody, even when the read confidently picks one voice, and the read is never asked', async () => {
  const segs = episode([450, 550])
  assert.equal(dominantVoice(voiceShares(segs)), null)
  for (const read of [1, 2, 'unsure', 'skipped'] as const) {
    assert.equal(labelOf(nameSpeakers(segs, [GUEST], HOST, read)), `0=${HOST}, 1=Speaker 2, 2=Speaker 3`, `read ${read}`)
  }
  const llm = stub({ speaker: 2 })
  const r = await nameSpeakersWithRead({ segments: segs, guests: [GUEST], host: HOST, llm })
  assert.equal(llm.calls, 0)
  assert.equal(r.candidate, null)
  assert.equal(r.names.get(1), 'Speaker 2')
  assert.equal(r.names.get(2), 'Speaker 3')
  assert.match(r.call.reason, /none stands out \(the largest holds 55%/)
})

// --- a second named guest ------------------------------------------------------------------------------------------

test('two named guests are never paired with voices, however lopsided the talking is', async () => {
  const segs = episode([900, 50, 50])
  for (const read of [1, 'skipped', 'unsure'] as const) {
    assert.equal(labelOf(nameSpeakers(segs, ['A One', 'B Two'], HOST, read)), `0=${HOST}, 1=Speaker 2, 2=Speaker 3, 3=Speaker 4`)
  }
  const llm = stub({ speaker: 1 })
  const r = await nameSpeakersWithRead({ segments: segs, guests: ['A One', 'B Two'], host: HOST, llm })
  assert.equal(llm.calls, 0)
  assert.match(r.call.reason, /2 guests are listed/)
})

// --- the confirmation read -----------------------------------------------------------------------------------------

test('nameSpeakersWithRead asks once, with the host, the guest and the opening, and names the guest when the read agrees', async () => {
  const segs = episode([900, 40, 60])
  let seen = { system: '', user: '' }
  const llm: SpeakerLlm = async (system, user) => { seen = { system, user }; return { speaker: 1 } }
  const r = await nameSpeakersWithRead({ segments: segs, guests: [GUEST], host: HOST, llm })
  assert.equal(r.candidate, 1)
  assert.equal(r.read, 1)
  assert.equal(r.names.get(1), GUEST)
  assert.match(seen.user, new RegExp(`HOST: ${HOST}`))
  assert.match(seen.user, new RegExp(`GUEST: ${GUEST}`))
  assert.match(seen.user, /Speaker 0: w0 w1/)
  assert.match(seen.system, /unsure/)
  assert.match(SPEAKER_READ_MODEL, /^claude-sonnet-/)
})

test('a read that disagrees, is unsure, is unreadable or fails leaves the guest unnamed and says so', async () => {
  const segs = episode([900, 40, 60])
  const cases: [string, unknown, RegExp][] = [
    ['disagrees', { speaker: 2 }, /picked voice 2: they disagree/],
    ['picks the host', { speaker: 0 }, /picked voice 0: they disagree/],
    ['unsure', { speaker: 'unsure' }, /read was unsure/],
    ['unreadable', 'I cannot tell who is who.', /read was unsure/],
    ['a voice that is not in the opening', { speaker: 9 }, /read was unsure/],
  ]
  for (const [name, reply, why] of cases) {
    const r = await nameSpeakersWithRead({ segments: segs, guests: [GUEST], host: HOST, llm: stub(reply) })
    assert.equal(r.names.get(1), 'Speaker 2', name)
    assert.match(r.call.reason, why, name)
  }
  const failing: SpeakerLlm = async () => { throw new Error('socket hang up') }
  const r = await nameSpeakersWithRead({ segments: segs, guests: [GUEST], host: HOST, llm: failing })
  assert.equal(r.names.get(1), 'Speaker 2')
  assert.match(r.note, /the read failed: socket hang up/)
})

test('a failure every later call would repeat is thrown, so the episode is not attached unnamed by accident', async () => {
  const segs = episode([900, 40, 60])
  const limited: SpeakerLlm = async () => { throw new UsageLimitError('reached', null) }
  await assert.rejects(readGuestSpeaker({ segments: segs, host: HOST, guest: GUEST, llm: limited }), UsageLimitError)
  await assert.rejects(nameSpeakersWithRead({ segments: segs, guests: [GUEST], host: HOST, llm: limited }), UsageLimitError)
})

test('skipRead makes no model call and lets the share rule decide alone', async () => {
  const llm = stub({ speaker: 2 })
  const r = await nameSpeakersWithRead({ segments: episode([900, 40, 60]), guests: [GUEST], host: HOST, llm, skipRead: true })
  assert.equal(llm.calls, 0)
  assert.equal(r.read, 'skipped')
  assert.equal(r.names.get(1), GUEST)
})

test('parseSpeakerReply accepts a number, "Speaker N", JSON in prose, and treats everything else as unsure', () => {
  const ok = [0, 1, 2]
  assert.equal(parseSpeakerReply({ speaker: 1 }, ok), 1)
  assert.equal(parseSpeakerReply({ speaker: '2' }, ok), 2)
  assert.equal(parseSpeakerReply({ speaker: 'Speaker 2' }, ok), 2)
  assert.equal(parseSpeakerReply('Sure: {"speaker": 1}', ok), 1)
  assert.equal(parseSpeakerReply({ speaker: 'UNSURE' }, ok), 'unsure')
  assert.equal(parseSpeakerReply({ speaker: 7 }, ok), 'unsure')
  assert.equal(parseSpeakerReply({ speaker: 1.5 }, ok), 'unsure')
  assert.equal(parseSpeakerReply({}, ok), 'unsure')
  assert.equal(parseSpeakerReply(null, ok), 'unsure')
  assert.equal(parseSpeakerReply('not json', ok), 'unsure')
})

test('the opening excerpt is the first five minutes, by raw speaker number, one turn per speaker change', () => {
  const at = (speaker: number, text: string, start_ms: number): DgSegment => ({ speaker, text, start_ms, end_ms: start_ms + 1000 })
  const segs = [
    at(2, 'Welcome.', 10_000),
    at(2, 'My guest today is Dr. Greenwald.', 12_000),
    at(1, 'Thanks for having me.', 15_000),
    at(2, 'Inside the window.', 10_000 + 299_000),
    at(1, 'Outside the window.', 10_000 + 300_000),
  ]
  const { text, speakers } = openingExcerpt(segs)
  assert.equal(
    text,
    'Speaker 2: Welcome. My guest today is Dr. Greenwald.\nSpeaker 1: Thanks for having me.\nSpeaker 2: Inside the window.'
  )
  assert.deepEqual(speakers.sort(), [1, 2])
  assert.equal(openingExcerpt([]).text, '')
})

// --- end to end ----------------------------------------------------------------------------------------------------

test('the stored transcript carries the guest label on the dominant voice and Speaker N on the small ones', () => {
  const segs: DgSegment[] = [
    { speaker: 0, text: 'Welcome. My guest is Sally Greenwald.', start_ms: 0, end_ms: 1000 },
    { speaker: 1, text: 'Thanks for having me.', start_ms: 1000, end_ms: 2000 },
    { speaker: 2, text: 'A clip.', start_ms: 2000, end_ms: 3000 },
    { speaker: 1, text: 'Back to it.', start_ms: 3000, end_ms: 4000 },
  ]
  const named = transcriptText(buildLabelledSegments(segs, nameSpeakers(segs, [GUEST], HOST, 'skipped')))
  // Only 2 words of 8 non-host words come from voice 2 (25%), so the rule does not name anyone here.
  assert.equal(
    named,
    `${HOST}: Welcome. My guest is Sally Greenwald. Speaker 2: Thanks for having me. Speaker 3: A clip. Speaker 2: Back to it.`
  )
  const big: DgSegment[] = [...segs, ...Array.from({ length: 30 }, (_, i): DgSegment => ({ speaker: 1, text: 'more talking here', start_ms: 5000 + i, end_ms: 5001 + i }))]
  const text = transcriptText(buildLabelledSegments(big, nameSpeakers(big, [GUEST], HOST, 1)))
  assert.match(text, new RegExp(`^${HOST}: Welcome\\. My guest is Sally Greenwald\\. ${GUEST}: Thanks for having me\\. Speaker 3: A clip\\. ${GUEST}: Back to it\\.`))
})
