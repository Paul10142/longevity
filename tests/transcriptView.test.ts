/**
 * Unit tests for lib/transcriptView.ts — the readable-transcript parser.
 *
 * Covers the five behaviours the view depends on: labelled turns, unlabelled
 * captions grouped by time, the no-timing fallback, a label mid-segment NOT
 * starting a turn, and the timestamp deep-link builder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTranscriptView,
  describeTranscriptView,
  formatTimestamp,
  normalizeTimedSegments,
  paragraphsFromCaptions,
  splitLabel,
  splitParagraphs,
  startsWithLabel,
  timestampLink,
  turnsFromPlainText,
  turnsFromTimedSegments,
} from '../lib/transcriptView'

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

// --- labelled turns (Deepgram / published) -----------------------------------

test('labelled segments start turns; the label is stripped and becomes the speaker', () => {
  const view = turnsFromTimedSegments([
    { text: 'Peter Attia: Hey, everyone. Welcome to The Drive.', start_ms: 11040, end_ms: 153100 },
    { text: 'David Allison: So I like the way you phrase the question.', start_ms: 153635, end_ms: 415455 },
    { text: 'Peter Attia: Do you ever spend time with physicists?', start_ms: 415855, end_ms: 487830 },
  ])
  assert.equal(view.timed, true)
  assert.equal(view.labelled, true)
  assert.deepEqual(view.turns, [
    { speaker: 'Peter Attia', start_ms: 11040, text: 'Hey, everyone. Welcome to The Drive.' },
    { speaker: 'David Allison', start_ms: 153635, text: 'So I like the way you phrase the question.' },
    { speaker: 'Peter Attia', start_ms: 415855, text: 'Do you ever spend time with physicists?' },
  ])
})

test('unlabelled segments continue the current turn; lead-in before the first label is its own block', () => {
  const view = turnsFromTimedSegments([
    { text: 'Intro music and sponsor read.', start_ms: 0, end_ms: 5000 },
    { text: 'Dr. Patrick: For those of you that do not know Satchin Panda,', start_ms: 5000, end_ms: 9000 },
    { text: 'he is a pioneer in time-restricted eating.', start_ms: 9000, end_ms: 14000 },
    { text: 'Dr. Panda: Yeah, so just imagine.', start_ms: 14000, end_ms: 20000 },
  ])
  assert.deepEqual(view.turns, [
    { speaker: null, start_ms: 0, text: 'Intro music and sponsor read.' },
    {
      speaker: 'Dr. Patrick',
      start_ms: 5000,
      text: 'For those of you that do not know Satchin Panda, he is a pioneer in time-restricted eating.',
    },
    { speaker: 'Dr. Panda', start_ms: 14000, text: 'Yeah, so just imagine.' },
  ])
})

test('numbered speakers ("Speaker 2: ") are labels too', () => {
  assert.deepEqual(splitLabel('Speaker 2: Thanks for having me.'), { speaker: 'Speaker 2', rest: 'Thanks for having me.' })
  assert.equal(startsWithLabel('Speaker 12: hi'), true)
  const view = turnsFromTimedSegments([
    { text: 'Peter Attia: Welcome.', start_ms: 0, end_ms: 1000 },
    { text: 'Speaker 2: Thanks for having me.', start_ms: 1000, end_ms: 2000 },
  ])
  assert.equal(view.turns[1].speaker, 'Speaker 2')
  assert.equal(view.turns[1].text, 'Thanks for having me.')
})

test('a label that appears mid-segment is NOT a turn start', () => {
  const view = turnsFromTimedSegments([
    { text: 'Peter Attia: Welcome back.', start_ms: 0, end_ms: 1000 },
    { text: 'and as David Allison: put it last time, the data are messy.', start_ms: 1000, end_ms: 3000 },
    { text: 'David Allison: They are.', start_ms: 3000, end_ms: 4000 },
  ])
  assert.equal(view.turns.length, 2)
  assert.deepEqual(view.turns[0], {
    speaker: 'Peter Attia',
    start_ms: 0,
    text: 'Welcome back. and as David Allison: put it last time, the data are messy.',
  })
  assert.deepEqual(view.turns[1], { speaker: 'David Allison', start_ms: 3000, text: 'They are.' })
})

test('splitLabel: what is and is not a label', () => {
  assert.equal(splitLabel('Peter Attia: hi').speaker, 'Peter Attia')
  assert.equal(splitLabel('Dr. Rhonda Patrick: hi').speaker, 'Dr. Rhonda Patrick')
  assert.equal(splitLabel("Conor O'Brien: hi").speaker, "Conor O'Brien")
  assert.equal(splitLabel('  Rhonda: hi').speaker, 'Rhonda')
  // Four capitalised words is not a name we accept.
  assert.equal(splitLabel('One Two Three Four: hi').speaker, null)
  // Lowercase, no colon, or no space after the colon → not a label.
  assert.equal(splitLabel('peter attia: hi').speaker, null)
  assert.equal(splitLabel('Peter Attia hi').speaker, null)
  assert.equal(splitLabel('Peter Attia:hi').speaker, null)
  // Unlabelled text comes back untouched.
  assert.deepEqual(splitLabel('plain words'), { speaker: null, rest: 'plain words' })
})

// --- captions grouped by time ------------------------------------------------

test('unlabelled captions are grouped into paragraphs of about a minute, stamped with the first caption', () => {
  const segments = []
  for (let i = 0; i < 15; i++) {
    segments.push({ text: `caption ${i}`, start_ms: i * 10_000, end_ms: i * 10_000 + 4000 })
  }
  const view = turnsFromTimedSegments(segments)
  assert.equal(view.timed, true)
  assert.equal(view.labelled, false)
  assert.equal(view.turns.length, 3)
  assert.deepEqual(view.turns.map(t => t.start_ms), [0, 60_000, 120_000])
  assert.equal(view.turns[0].text, 'caption 0 caption 1 caption 2 caption 3 caption 4 caption 5')
  assert.equal(view.turns[2].text, 'caption 12 caption 13 caption 14')
  assert.ok(view.turns.every(t => t.speaker === null))
})

test('paragraphsFromCaptions: window is configurable, whitespace collapsed, empty captions skipped', () => {
  const turns = paragraphsFromCaptions(
    [
      { text: '  hey   everyone ', start_ms: 1879, end_ms: 8790 },
      { text: '', start_ms: 4589, end_ms: 10679 },
      { text: 'welcome to the drive', start_ms: 8790, end_ms: 13049 },
      { text: 'second block', start_ms: 40_000, end_ms: 42_000 },
    ],
    30_000
  )
  assert.deepEqual(turns, [
    { speaker: null, start_ms: 1879, text: 'hey everyone welcome to the drive' },
    { speaker: null, start_ms: 40_000, text: 'second block' },
  ])
})

// --- plain-text fallback (no timing) -----------------------------------------

test('without timing, the plain transcript is split on labels with no timestamps', () => {
  const view = buildTranscriptView({
    timed_transcript: null,
    transcript: 'Peter Attia: Hey, everyone. David Allison: Thanks for having me. Peter Attia: Of course.',
  })
  assert.equal(view.timed, false)
  assert.equal(view.labelled, true)
  assert.deepEqual(view.turns, [
    { speaker: 'Peter Attia', start_ms: null, text: 'Hey, everyone.' },
    { speaker: 'David Allison', start_ms: null, text: 'Thanks for having me.' },
    { speaker: 'Peter Attia', start_ms: null, text: 'Of course.' },
  ])
})

test('plain text without any label is one unlabelled block', () => {
  const view = buildTranscriptView({ transcript: 'just a pasted paragraph with no names' })
  assert.deepEqual(view, {
    turns: [{ speaker: null, start_ms: null, text: 'just a pasted paragraph with no names' }],
    timed: false,
    labelled: false,
  })
})

test('plain text: blank lines break a turn into paragraphs; the speaker stays on the first', () => {
  const view = buildTranscriptView({
    transcript: 'Peter Attia: First paragraph.\nstill first.\n\nSecond paragraph.\n\n\n  Third paragraph.  \n\nDavid Allison: Reply.',
  })
  assert.deepEqual(view.turns, [
    { speaker: 'Peter Attia', start_ms: null, text: 'First paragraph.\nstill first.' },
    { speaker: null, start_ms: null, text: 'Second paragraph.' },
    { speaker: null, start_ms: null, text: 'Third paragraph.' },
    { speaker: 'David Allison', start_ms: null, text: 'Reply.' },
  ])
  assert.equal(view.labelled, true)
  // A single block with paragraph breaks and no labels becomes several blocks.
  const unlabelled = buildTranscriptView({ transcript: 'One.\n\nTwo.\n\nThree.' })
  assert.deepEqual(unlabelled.turns.map(t => t.text), ['One.', 'Two.', 'Three.'])
  assert.deepEqual(splitParagraphs({ speaker: 'X', start_ms: 5, text: 'no breaks here' }), [
    { speaker: 'X', start_ms: 5, text: 'no breaks here' },
  ])
})

test('plain text: a sentence-end swallowed into a label is returned to the previous turn', () => {
  const turns = turnsFromPlainText('Rhonda: It was fine. So. Peter: Was it? Dr. Patrick: Yes.')
  assert.deepEqual(turns, [
    { speaker: 'Rhonda', start_ms: null, text: 'It was fine. So.' },
    { speaker: 'Peter', start_ms: null, text: 'Was it?' },
    { speaker: 'Dr. Patrick', start_ms: null, text: 'Yes.' },
  ])
})

test('plain text: a label only counts at the start or after whitespace', () => {
  const turns = turnsFromPlainText('Peter Attia: email me at peter@x.comDavid: no')
  assert.equal(turns.length, 1)
  assert.equal(turns[0].text, 'email me at peter@x.comDavid: no')
})

// --- buildTranscriptView plumbing --------------------------------------------

test('timed segments win over the plain text; malformed entries are skipped', () => {
  const view = buildTranscriptView({
    transcript: 'Peter Attia: this text is ignored when timing exists',
    timed_transcript: [
      { text: 'Peter Attia: Timed version.', start_ms: '1000', end_ms: 2000 }, // numeric string ok
      null,
      { text: '', start_ms: 3000 },
      { text: 'no start' },
      { text: 'continues here.', start_ms: 4000 },
    ],
  })
  assert.equal(view.timed, true)
  assert.deepEqual(view.turns, [{ speaker: 'Peter Attia', start_ms: 1000, text: 'Timed version. continues here.' }])
})

test('normalizeTimedSegments: rejects non-arrays and clamps bad times', () => {
  assert.deepEqual(normalizeTimedSegments(null), [])
  assert.deepEqual(normalizeTimedSegments('nope'), [])
  assert.deepEqual(normalizeTimedSegments({ text: 'x', start_ms: 1 }), [])
  assert.deepEqual(normalizeTimedSegments([{ text: 'x', start_ms: -5, end_ms: -10 }]), [
    { text: 'x', start_ms: 0, end_ms: 0 },
  ])
})

test('an empty source yields an empty view', () => {
  assert.deepEqual(buildTranscriptView({ transcript: null, timed_transcript: null }), {
    turns: [],
    timed: false,
    labelled: false,
  })
  assert.deepEqual(buildTranscriptView({ transcript: '   ', timed_transcript: [] }).turns, [])
})

test('describeTranscriptView names the kind of transcript in plain words', () => {
  assert.equal(describeTranscriptView({ turns: [], timed: false, labelled: false }), 'No transcript yet.')
  const t = { speaker: null, start_ms: 0, text: 'x' }
  assert.match(describeTranscriptView({ turns: [t], timed: true, labelled: true }), /Speaker-labelled/)
  assert.match(describeTranscriptView({ turns: [t], timed: true, labelled: false }), /captions/)
  assert.match(describeTranscriptView({ turns: [t], timed: false, labelled: true }), /No timestamps/)
  assert.match(describeTranscriptView({ turns: [t], timed: false, labelled: false }), /No speaker names/)
})

// --- timestamps --------------------------------------------------------------

test('formatTimestamp: h:mm:ss above an hour, m:ss below', () => {
  assert.equal(formatTimestamp(3_735_000), '1:02:15')
  assert.equal(formatTimestamp(125_000), '2:05')
  assert.equal(formatTimestamp(0), '0:00')
  assert.equal(formatTimestamp(59_999), '0:59')
  assert.equal(formatTimestamp(36_000_000), '10:00:00')
})

test('timestampLink: ?t= on a bare URL, &t= when a query already exists, seconds floored', () => {
  assert.equal(timestampLink(VIDEO, 3_735_900), `${VIDEO}&t=3735`)
  assert.equal(timestampLink('https://youtu.be/dQw4w9WgXcQ', 125_000), 'https://youtu.be/dQw4w9WgXcQ?t=125')
  assert.equal(timestampLink(VIDEO, 0), `${VIDEO}&t=0`)
})

test('timestampLink: null without a video, without a time, or for a private feed URL', () => {
  assert.equal(timestampLink(null, 1000), null)
  assert.equal(timestampLink('', 1000), null)
  assert.equal(timestampLink(VIDEO, null), null)
  assert.equal(timestampLink(VIDEO, undefined), null)
  assert.equal(timestampLink(VIDEO, Number.NaN), null)
  assert.equal(timestampLink('https://peterattia.supercast.tech/episodes/x?key=SECRET', 1000), null)
})
