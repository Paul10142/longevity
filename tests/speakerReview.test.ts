/**
 * Tests for the speaker review flow (lib/speakerReview.ts, lib/speakerRead.ts, the unchanged naming rule in
 * lib/deepgramSegments.ts).
 *
 * Synthetic segment lists only: no model is reached (the model call is injected) and nothing touches the
 * database. What is under test:
 *   - the attach's own naming is UNCHANGED: a third voice is never guessed, it stays `Speaker N`;
 *   - a stored transcript is read back into turns and the unnamed voices summarised for the page;
 *   - Paul's answers are validated on the server (known labels, names from the episode's own list, the
 *     fingerprint computed server-side), and a saved mapping is applied at re-attach only when every
 *     fingerprint still matches the voice now carrying that label;
 *   - the links to the original, with a timestamp where one is possible and never the private feed URL;
 *   - the suggestion (a model read) only ever points at an unnamed voice and never writes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLabelledSegments, nameSpeakers, openingSpeaker, transcriptText, voiceOrder, type DgSegment } from '../lib/deepgramSegments'
import {
  SPEAKER_READ_MODEL,
  openingExcerpt,
  parseSpeakerReply,
  readGuestSpeaker,
  suggestGuestVoice,
  type SpeakerLlm,
} from '../lib/speakerRead'
import {
  assignableNames,
  buildAssignments,
  fingerprint,
  formatTimestamp,
  nameSpeakersAssigned,
  originalLink,
  parseTurns,
  readSpeakerNames,
  suggestGuestSpeaker,
  unnamedSpeakers,
  type SpeakerNames,
} from '../lib/speakerReview'
import { UsageLimitError } from '../lib/usageLimit'

const HOST = 'Rhonda Patrick'
const GUEST = 'Ronald Krauss'

const seg = (speaker: number | null, text: string, start_ms: number): DgSegment => ({ speaker, text, start_ms, end_ms: start_ms + 1500 })

/**
 * A FoundMyFitness-shaped episode: voice 0 is the produced intro, voice 1 the host's interview voice (it speaks
 * second, so it is `Speaker 2`), voice 2 the guest (`Speaker 3`), and voice 3 an ad read.
 */
const fmf: DgSegment[] = [
  seg(0, 'Welcome to the FoundMyFitness podcast, I am Rhonda Patrick.', 0),
  seg(0, 'Today I talk with a cardiologist.', 4000),
  seg(1, 'Welcome to another episode. I am sitting here with Doctor Ronald Krauss.', 70_000),
  seg(2, 'Thanks so much for having me, Rhonda.', 76_000),
  seg(2, 'It is a pleasure to be here.', 79_000),
  seg(1, 'Let us start with saturated fat.', 83_000),
  seg(2, 'Saturated fat raises LDL particles, and the size matters a great deal.', 88_000),
  seg(3, 'This episode is brought to you by a sponsor.', 400_000),
  seg(0, 'Thanks for listening.', 900_000),
]

// ---------------------------------------------------------------------------
// The attach's own rule is unchanged
// ---------------------------------------------------------------------------

test('a third voice is never guessed: every non-host voice stays Speaker N, even with one named guest', () => {
  const names = nameSpeakers(fmf, [GUEST], HOST)
  assert.equal(names.get(0), HOST)
  assert.equal(names.get(1), 'Speaker 2')
  assert.equal(names.get(2), 'Speaker 3')
  assert.equal(names.get(3), 'Speaker 4')
})

test('the clear two-voice case is still named automatically', () => {
  const two = fmf.filter(s => s.speaker === 0 || s.speaker === 2)
  assert.equal(nameSpeakers(two, [GUEST], HOST).get(2), GUEST)
  assert.equal(nameSpeakers(two, [], HOST).get(2), 'Speaker 2')
})

test('voiceOrder lists the non-opening voices by first appearance; openingSpeaker is the first diarized one', () => {
  assert.deepEqual(voiceOrder(fmf), [1, 2, 3])
  assert.equal(openingSpeaker(fmf), 0)
  assert.deepEqual(voiceOrder([seg(null, 'x', 0)]), [])
  assert.equal(openingSpeaker([seg(null, 'x', 0), seg(4, 'y', 1)]), 4)
})

// ---------------------------------------------------------------------------
// Reading a stored transcript back
// ---------------------------------------------------------------------------

const stored = buildLabelledSegments(fmf, nameSpeakers(fmf, [GUEST], HOST))
const KNOWN = [HOST, GUEST]

test('parseTurns: one turn per label change, continuation segments join the turn, colons in speech start nothing', () => {
  const turns = parseTurns(stored, KNOWN)
  assert.deepEqual(turns.map(t => t.label), [HOST, 'Speaker 2', 'Speaker 3', 'Speaker 2', 'Speaker 3', 'Speaker 4', HOST])
  assert.equal(turns[0].text, 'Welcome to the FoundMyFitness podcast, I am Rhonda Patrick. Today I talk with a cardiologist.')
  assert.equal(turns[0].start_ms, 0)
  assert.equal(turns[2].firstText, 'Thanks so much for having me, Rhonda.')
  const withColon = parseTurns([{ text: `${HOST}: The rule is simple: eat well.`, start_ms: 0, end_ms: 1 }, { text: 'Note: this is not a label.', start_ms: 1, end_ms: 2 }], KNOWN)
  assert.equal(withColon.length, 1)
  assert.equal(withColon[0].text, 'The rule is simple: eat well. Note: this is not a label.')
})

test('parseTurns: segments before the first label are dropped; a label that is not a known name is not a turn', () => {
  const turns = parseTurns([{ text: 'orphan text', start_ms: 0, end_ms: 1 }, { text: 'Somebody Else: hello', start_ms: 1, end_ms: 2 }], KNOWN)
  assert.equal(turns.length, 0)
})

test('unnamedSpeakers: unnamed voices in order, with words, share, first turns and a fingerprint', () => {
  const sp = unnamedSpeakers(parseTurns(stored, KNOWN), 2)
  assert.deepEqual(sp.map(s => s.label), ['Speaker 2', 'Speaker 3', 'Speaker 4'])
  const two = sp[0]
  assert.equal(two.turns, 2)
  assert.equal(two.firstTurns.length, 2)
  assert.equal(two.firstTurns[0].start_ms, 70_000)
  assert.equal(two.check, fingerprint('Welcome to another episode. I am sitting here with Doctor Ronald Krauss.'))
  assert.ok(Math.abs(sp.reduce((a, s) => a + s.share, 0) - 1) < 1e-9)
  assert.ok(sp[1].words > sp[2].words)
})

test('unnamedSpeakers: a long first turn is cut on a word boundary', () => {
  const long = 'alpha '.repeat(200).trim()
  const sp = unnamedSpeakers(parseTurns([{ text: `Speaker 2: ${long}`, start_ms: 0, end_ms: 1 }], KNOWN), 3, 40)
  assert.ok(sp[0].firstTurns[0].text.endsWith('…'))
  assert.ok(sp[0].firstTurns[0].text.length <= 44)
})

test('fingerprint ignores case, punctuation and spacing but not words, and is capped at 60 characters', () => {
  assert.equal(fingerprint('Thanks so much — for having me!'), fingerprint('thanks   so much for having me'))
  assert.notEqual(fingerprint('Thanks so much for having me'), fingerprint('Thanks so much for having us'))
  assert.ok(fingerprint('x'.repeat(200)).length <= 60)
})

// ---------------------------------------------------------------------------
// Which names, and saving an answer
// ---------------------------------------------------------------------------

test('assignableNames: host first, then guests, all bare, no repeats', () => {
  assert.deepEqual(assignableNames(['Rhonda Patrick', 'Dr. Ronald Krauss, M.D.', 'Ronald Krauss'], HOST), [HOST, GUEST])
  assert.deepEqual(assignableNames(['Dr. Peter Attia, M.D.'], null), ['Peter Attia'])
  assert.deepEqual(assignableNames(null, HOST), [HOST])
})

const speakers = unnamedSpeakers(parseTurns(stored, KNOWN))
const allowed = [HOST, GUEST]

test('buildAssignments: names from the episode, null for not a guest, fingerprint computed from the transcript', () => {
  const r = buildAssignments({ input: { 'Speaker 2': HOST, 'Speaker 3': GUEST, 'Speaker 4': null }, speakers, allowed })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.names['Speaker 2'], { name: HOST, check: speakers[0].check })
  assert.deepEqual(r.names['Speaker 3'], { name: GUEST, check: speakers[1].check })
  assert.deepEqual(r.names['Speaker 4'], { name: null, check: speakers[2].check })
})

test('buildAssignments: a name is matched ignoring case and accents and stored in the episode\'s spelling', () => {
  const r = buildAssignments({ input: { 'Speaker 3': 'ronald KRAUSS' }, speakers, allowed })
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.names['Speaker 3'].name, GUEST)
})

test('buildAssignments: rejects a name that is not on the episode, a label that is not an unnamed voice, bad shapes', () => {
  assert.equal(buildAssignments({ input: { 'Speaker 3': 'Peter Attia' }, speakers, allowed }).ok, false)
  assert.equal(buildAssignments({ input: { 'Speaker 9': GUEST }, speakers, allowed }).ok, false)
  assert.equal(buildAssignments({ input: { [HOST]: GUEST }, speakers, allowed }).ok, false)
  assert.equal(buildAssignments({ input: { 'Speaker 3': 7 }, speakers, allowed }).ok, false)
  assert.equal(buildAssignments({ input: ['Speaker 3'], speakers, allowed }).ok, false)
  assert.equal(buildAssignments({ input: null, speakers, allowed }).ok, false)
})

test('buildAssignments: earlier answers are replaced for labels still unnamed and kept for labels already applied', () => {
  const existing: SpeakerNames = {
    'Speaker 2': { name: GUEST, check: 'old' },
    'Speaker 7': { name: HOST, check: 'applied earlier' },
  }
  const r = buildAssignments({ input: { 'Speaker 2': HOST }, speakers, allowed, existing })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.names['Speaker 2'].name, HOST)
  assert.deepEqual(r.names['Speaker 7'], existing['Speaker 7'])
})

test('readSpeakerNames keeps only the documented shape', () => {
  assert.deepEqual(readSpeakerNames(null), {})
  assert.deepEqual(readSpeakerNames([1, 2]), {})
  assert.deepEqual(
    readSpeakerNames({ 'Speaker 2': { name: GUEST, check: 'a' }, 'Speaker 3': { name: null, check: 'b' }, [HOST]: { name: GUEST, check: 'c' }, 'Speaker 4': { name: 5, check: 'd' }, 'Speaker 5': 'x' }),
    { 'Speaker 2': { name: GUEST, check: 'a' }, 'Speaker 3': { name: null, check: 'b' } }
  )
})

// ---------------------------------------------------------------------------
// The re-attach applies the saved mapping
// ---------------------------------------------------------------------------

const review = (input: Record<string, string | null>): SpeakerNames => {
  const r = buildAssignments({ input, speakers, allowed })
  assert.ok(r.ok)
  return r.ok ? r.names : {}
}

test('nameSpeakersAssigned: no mapping is exactly nameSpeakers', () => {
  for (const m of [undefined, null, {}]) {
    const r = nameSpeakersAssigned(fmf, [GUEST], HOST, m)
    assert.deepEqual([...r.names], [...nameSpeakers(fmf, [GUEST], HOST)])
    assert.equal(r.ignored, null)
    assert.deepEqual(r.applied, [])
  }
})

test('nameSpeakersAssigned: the host\'s interview voice and the guest get names, the ad stays Speaker 4, and the host turns merge', () => {
  const saved = review({ 'Speaker 2': HOST, 'Speaker 3': GUEST, 'Speaker 4': null })
  const r = nameSpeakersAssigned(fmf, [GUEST], HOST, saved)
  assert.equal(r.ignored, null)
  assert.deepEqual(r.applied, [`Speaker 2 → ${HOST}`, `Speaker 3 → ${GUEST}`])
  assert.equal(r.names.get(1), HOST)
  assert.equal(r.names.get(2), GUEST)
  assert.equal(r.names.get(3), 'Speaker 4')
  const text = transcriptText(buildLabelledSegments(fmf, r.names))
  // the intro and the interview voice are both Rhonda Patrick, so they read as one turn (one label)
  assert.ok(text.startsWith(`${HOST}: Welcome to the FoundMyFitness podcast, I am Rhonda Patrick. Today I talk with a cardiologist. Welcome to another episode.`))
  assert.ok(text.includes(`${GUEST}: Thanks so much for having me, Rhonda.`))
  assert.ok(text.includes('Speaker 4: This episode is brought to you by a sponsor.'))
  // Rhonda Patrick labels: the intro + interview turn, her question after the guest, and the closing line after the ad
  assert.equal((text.match(new RegExp(`${HOST}:`, 'g')) ?? []).length, 3)
})

test('nameSpeakersAssigned: a file whose voice no longer starts with what was reviewed ignores the WHOLE mapping', () => {
  const saved = review({ 'Speaker 2': HOST, 'Speaker 3': GUEST })
  // a re-transcription finds a new voice before the interview starts: Speaker 2 is now somebody else
  const shifted = [fmf[0], fmf[1], seg(5, 'A brand new voice appears first.', 60_000), ...fmf.slice(2)]
  const r = nameSpeakersAssigned(shifted, [GUEST], HOST, saved)
  assert.ok(r.ignored)
  assert.match(r.ignored ?? '', /Speaker 2 no longer starts with what was reviewed/)
  assert.deepEqual(r.applied, [])
  assert.deepEqual([...r.names], [...nameSpeakers(shifted, [GUEST], HOST)])
  // renumbering the same voices does NOT matter: labels follow first appearance, not Deepgram's numbers
  const renumbered = fmf.map(s => (s.speaker === 1 ? { ...s, speaker: 8 } : s.speaker === 2 ? { ...s, speaker: 9 } : s))
  assert.equal(nameSpeakersAssigned(renumbered, [GUEST], HOST, saved).ignored, null)
})

test('nameSpeakersAssigned: a label the file does not have is ignored with a reason, never half-applied', () => {
  const saved: SpeakerNames = { ...review({ 'Speaker 2': HOST }), 'Speaker 9': { name: GUEST, check: 'x' } }
  const r = nameSpeakersAssigned(fmf, [GUEST], HOST, saved)
  assert.match(r.ignored ?? '', /Speaker 9 is not a voice in this file/)
  assert.equal(r.names.get(1), 'Speaker 2')
})

test('nameSpeakersAssigned: punctuation differences between the page and the Deepgram file do not break the check', () => {
  const saved = review({ 'Speaker 3': GUEST })
  const reworded = fmf.map(s => (s.text.startsWith('Thanks so much') ? { ...s, text: 'thanks so much for having me rhonda' } : s))
  const r = nameSpeakersAssigned(reworded, [GUEST], HOST, saved)
  assert.equal(r.ignored, null)
  assert.equal(r.names.get(2), GUEST)
})

// ---------------------------------------------------------------------------
// The link to the original
// ---------------------------------------------------------------------------

test('formatTimestamp: m:ss under an hour, h:mm:ss from an hour, never negative', () => {
  assert.equal(formatTimestamp(0), '0:00')
  assert.equal(formatTimestamp(70_000), '1:10')
  assert.equal(formatTimestamp(3_725_000), '1:02:05')
  assert.equal(formatTimestamp(-5), '0:00')
})

test('originalLink: a YouTube row links to the video at that second', () => {
  const l = originalLink({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'T', external_id: 'huberman-xyz' }, 125_900)
  assert.deepEqual(l, { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=125', label: 'Play On YouTube At 2:05', timed: true })
})

test('originalLink: a public audio file gets #t=', () => {
  const l = originalLink({ media_url: 'https://cdn.example.com/ep.mp3', external_id: 'x-1' }, 61_000)
  assert.deepEqual(l, { href: 'https://cdn.example.com/ep.mp3#t=61', label: 'Play Audio At 1:01', timed: true })
})

test('originalLink: the private member feed URL is never used; the public episode page is, without a timestamp', () => {
  const row = { url: 'https://feeds.supercast.com/episodes/secret', article_url: 'https://www.foundmyfitness.com/episodes/12', external_id: 'fmf-0012' }
  const l = originalLink(row, 70_000)
  assert.ok(l)
  assert.equal(l?.href, 'https://www.foundmyfitness.com/episodes/12')
  assert.equal(l?.timed, false)
  const none = originalLink({ url: 'https://feeds.supercast.com/episodes/secret', external_id: 'fmf-0012', title: '' }, 0)
  assert.ok(!none || !/supercast/i.test(none.href))
})

// ---------------------------------------------------------------------------
// The suggestion (a model read; never a write)
// ---------------------------------------------------------------------------

function stub(reply: unknown): SpeakerLlm & { calls: number; lastUser: string } {
  const f: SpeakerLlm & { calls: number; lastUser: string } = Object.assign(
    async (_system: string, user: string) => { f.calls++; f.lastUser = user; return reply },
    { calls: 0, lastUser: '' }
  )
  return f
}

test('parseSpeakerReply: a number in the excerpt, a "Speaker N" string, or text around JSON; anything else is unsure', () => {
  assert.equal(parseSpeakerReply({ speaker: 2 }, [0, 1, 2]), 2)
  assert.equal(parseSpeakerReply({ speaker: 'Speaker 1' }, [0, 1, 2]), 1)
  assert.equal(parseSpeakerReply('Sure: {"speaker": 2} done', [0, 1, 2]), 2)
  assert.equal(parseSpeakerReply({ speaker: 7 }, [0, 1, 2]), 'unsure')
  assert.equal(parseSpeakerReply({ speaker: 'unsure' }, [0, 1, 2]), 'unsure')
  assert.equal(parseSpeakerReply('not json', [0, 1, 2]), 'unsure')
  assert.equal(parseSpeakerReply(null, [0]), 'unsure')
})

test('openingExcerpt: turns by raw speaker number inside the window, consecutive utterances joined', () => {
  const ex = openingExcerpt(fmf, 100_000)
  assert.deepEqual(ex.speakers, [0, 1, 2])
  assert.ok(ex.text.startsWith('Speaker 0: Welcome to the FoundMyFitness podcast'))
  assert.ok(!ex.text.includes('sponsor'))
  assert.equal(openingExcerpt([], 1000).text, '')
})

test('readGuestSpeaker: reads with the guest\'s and host\'s names, maps the reply, never throws for an ordinary failure', async () => {
  const llm = stub({ speaker: 2 })
  const r = await readGuestSpeaker({ segments: fmf, host: HOST, guest: GUEST, llm })
  assert.equal(r.read, 2)
  assert.equal(llm.calls, 1)
  assert.match(llm.lastUser, /HOST: Rhonda Patrick/)
  assert.match(llm.lastUser, /GUEST: Ronald Krauss/)
  const failing: SpeakerLlm = async () => { throw new Error('boom') }
  const f = await readGuestSpeaker({ segments: fmf, host: HOST, guest: GUEST, llm: failing })
  assert.equal(f.read, 'unsure')
  assert.match(f.note, /the read failed: boom/)
})

test('readGuestSpeaker: a full usage window is thrown, not turned into "unsure"', async () => {
  const limited: SpeakerLlm = async () => { throw new UsageLimitError('reached', null) }
  await assert.rejects(readGuestSpeaker({ segments: fmf, host: HOST, guest: GUEST, llm: limited }), UsageLimitError)
})

test('suggestGuestVoice: the opening voice is never suggested (a cold-open clip), unsure is none, another voice is returned', async () => {
  assert.equal((await suggestGuestVoice({ segments: fmf, host: HOST, guest: GUEST, llm: stub({ speaker: 0 }) })).voice, null)
  assert.equal((await suggestGuestVoice({ segments: fmf, host: HOST, guest: GUEST, llm: stub({ speaker: 'unsure' }) })).voice, null)
  assert.equal((await suggestGuestVoice({ segments: fmf, host: HOST, guest: GUEST, llm: stub({ speaker: 2 }) })).voice, 2)
})

test('suggestGuestSpeaker: maps the read back to a stored label, only ever an unnamed one', async () => {
  const turns = parseTurns(stored, KNOWN)
  // the read numbers voices by first appearance in the turns: HOST=0, Speaker 2=1, Speaker 3=2, Speaker 4=3
  const read = (voice: number | null) => async () => ({ voice, why: 'because' })
  const hit = await suggestGuestSpeaker({ turns, host: HOST, guest: GUEST, read: read(2) })
  assert.equal(hit.label, 'Speaker 3')
  assert.equal(hit.why, `A read of the first five minutes says Speaker 3 is ${GUEST}`)
  assert.equal((await suggestGuestSpeaker({ turns, host: HOST, guest: GUEST, read: read(null) })).label, null)
  assert.equal((await suggestGuestSpeaker({ turns, host: HOST, guest: GUEST, read: read(0) })).label, null)
  assert.equal((await suggestGuestSpeaker({ turns, host: HOST, guest: GUEST, read: read(9) })).label, null)
  const named = parseTurns(buildLabelledSegments(fmf, new Map([[0, HOST], [1, HOST], [2, GUEST], [3, 'Sponsor']])), [...KNOWN, 'Sponsor'])
  const none = await suggestGuestSpeaker({ turns: named, host: HOST, guest: GUEST, read: read(2) })
  assert.equal(none.label, null)
  assert.match(none.why, /already has a name/)
})

test('the suggestion read uses a Sonnet model, not Haiku', () => {
  assert.match(SPEAKER_READ_MODEL, /sonnet/)
})
