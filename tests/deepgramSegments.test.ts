/**
 * Unit tests for lib/deepgramSegments.ts speaker naming.
 *
 * The host is a required argument: the first speaker is whoever hosts THIS show.
 * It used to be a constant "Peter Attia", which would have labelled Andrew
 * Huberman's opening monologue with Attia's name.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nameSpeakers, buildLabelledSegments, transcriptText, type DgSegment } from '../lib/deepgramSegments'
import { hostLabelForKey } from '../lib/shows'

const seg = (speaker: number | null, text: string, start_ms: number): DgSegment => ({ speaker, text, start_ms, end_ms: start_ms + 1000 })

const twoSpeakers: DgSegment[] = [
  seg(0, 'Welcome to the show.', 0),
  seg(0, 'Today my guest is a professor.', 1000),
  seg(1, 'Thanks for having me.', 2000),
  seg(0, 'Let us begin.', 3000),
]

test('nameSpeakers: the first speaker is the host passed in, whoever that is', () => {
  for (const [key, host] of [['attia-0405', 'Peter Attia'], ['fmf-0114', 'Rhonda Patrick'], ['huberman-g3fb2c5', 'Andrew Huberman']] as const) {
    assert.equal(hostLabelForKey(key), host)
    const names = nameSpeakers(twoSpeakers, [], hostLabelForKey(key)!)
    assert.equal(names.get(0), host)
    assert.equal(names.get(1), 'Speaker 2')
  }
})

test('nameSpeakers: a lone feed guest names the one other speaker; two guests do not pair', () => {
  assert.equal(nameSpeakers(twoSpeakers, ['Dr. Scott Kanoski'], 'Andrew Huberman').get(1), 'Dr. Scott Kanoski')
  const three: DgSegment[] = [...twoSpeakers, seg(2, 'And I agree.', 4000)]
  const names = nameSpeakers(three, ['A One', 'B Two'], 'Andrew Huberman')
  assert.equal(names.get(1), 'Speaker 2')
  assert.equal(names.get(2), 'Speaker 3')
})

test('nameSpeakers: no diarized speaker means no names at all', () => {
  assert.equal(nameSpeakers([seg(null, 'x', 0)], [], 'Peter Attia').size, 0)
  assert.equal(nameSpeakers([], [], 'Peter Attia').size, 0)
})

test('the label written into the transcript is the show\'s host, once per turn', () => {
  const names = nameSpeakers(twoSpeakers, ['Dr. Scott Kanoski'], 'Andrew Huberman')
  const text = transcriptText(buildLabelledSegments(twoSpeakers, names))
  assert.equal(
    text,
    'Andrew Huberman: Welcome to the show. Today my guest is a professor. Dr. Scott Kanoski: Thanks for having me. Andrew Huberman: Let us begin.'
  )
  assert.doesNotMatch(text, /Attia/)
})

test('The Drive output is the same as before the host became an argument', () => {
  const text = transcriptText(buildLabelledSegments(twoSpeakers, nameSpeakers(twoSpeakers, ['Linus Abrams'], 'Peter Attia')))
  assert.equal(
    text,
    'Peter Attia: Welcome to the show. Today my guest is a professor. Linus Abrams: Thanks for having me. Peter Attia: Let us begin.'
  )
})
