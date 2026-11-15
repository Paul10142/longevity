/** The extraction hold for episodes awaiting Paul's speaker review (lib/speakerHold.ts). Pure; no database. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdUnreviewedVoicesEnabled, isHeldForSpeakerReview, unnamedLabelsIn, unresolvedVoices } from '../lib/speakerHold'
import { runIsFinished, classifyOpenJobs } from '../lib/runnableWork'

const T = 'Andrew Huberman: welcome. Speaker 2: thanks for having me. Andrew Huberman: sure. Speaker 3: hi'
const ans = (name: string | null) => ({ name, check: 'x' })

test('unnamed labels are found, named ones are not', () => {
  assert.deepEqual(unnamedLabelsIn(T).sort(), ['Speaker 2', 'Speaker 3'])
  assert.deepEqual(unnamedLabelsIn('Andrew Huberman: hi. Rhonda Patrick: hello'), [])
  assert.deepEqual(unnamedLabelsIn(null), [])
})

test('an unnamed voice with no saved review is held', () => {
  assert.equal(isHeldForSpeakerReview(T, null), true)
})

test('a saved name that is not yet in the transcript still holds', () => {
  assert.equal(isHeldForSpeakerReview(T, { 'Speaker 2': ans('Guest A'), 'Speaker 3': ans('Guest B') }), true)
})

test('every remaining voice answered Not A Guest releases the episode', () => {
  assert.equal(isHeldForSpeakerReview(T, { 'Speaker 2': ans(null), 'Speaker 3': ans(null) }), false)
  assert.deepEqual(unresolvedVoices(T, { 'Speaker 2': ans(null) }), ['Speaker 3'])
})

test('a transcript with no unnamed voice is never held, saved review or not', () => {
  assert.equal(isHeldForSpeakerReview('Andrew Huberman: hi. Guest A: yo', { 'Speaker 2': ans('Guest A') }), false)
  assert.equal(isHeldForSpeakerReview('Andrew Huberman: hi', null), false)
})

test('the off switch: only "0" turns the hold off', () => {
  assert.equal(holdUnreviewedVoicesEnabled({}), true)
  assert.equal(holdUnreviewedVoicesEnabled({ EXTRACT_HOLD_UNREVIEWED_VOICES: '1' }), true)
  assert.equal(holdUnreviewedVoicesEnabled({ EXTRACT_HOLD_UNREVIEWED_VOICES: '0' }), false)
})

test('a run with only held rows left finishes (held rows are not in the work list)', () => {
  const work = classifyOpenJobs([], Date.now() + 1000)
  assert.equal(runIsFinished(0, work), true)
})
