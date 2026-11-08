/**
 * Unit tests for guestsForLabels (lib/deepgramSegments.ts): which guest names
 * label an episode's speakers. `sources.authors` is the record (host =
 * authors[0], guests = the rest); the feed manifest is only the fallback for a
 * row whose authors is null.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guestsForLabels, nameSpeakers, buildLabelledSegments, type DgSegment } from '../lib/deepgramSegments'

const HOST = 'Peter Attia'

test('authors with a guest: the guests are authors after the host, and the manifest is ignored', () => {
  const c = guestsForLabels({ row: { authors: [HOST, 'Matt Walker'] }, manifestGuests: ['Somebody Else'], host: HOST })
  assert.deepEqual(c, { guests: ['Matt Walker'], from: 'authors' })
})

test('authors with several guests keep their order', () => {
  const c = guestsForLabels({ row: { authors: [HOST, 'Zeta Guest', 'Alpha Guest'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c.guests, ['Zeta Guest', 'Alpha Guest'])
})

test('host-only authors: no guest, and the manifest guests are NOT consulted', () => {
  const c = guestsForLabels({ row: { authors: [HOST] }, manifestGuests: ['Wrong Title Rule Guest'], host: HOST })
  assert.deepEqual(c, { guests: [], from: 'authors' })
})

test('null authors fall back to the manifest guests', () => {
  const c = guestsForLabels({ row: { authors: null }, manifestGuests: ['Matt Walker'], host: HOST })
  assert.deepEqual(c, { guests: ['Matt Walker'], from: 'manifest' })
})

test('empty authors carry no answer and fall back to the manifest, like null', () => {
  assert.deepEqual(guestsForLabels({ row: { authors: [] }, manifestGuests: ['Matt Walker'], host: HOST }).from, 'manifest')
  assert.deepEqual(guestsForLabels({ row: { authors: ['', '  '] }, manifestGuests: ['Matt Walker'], host: HOST }).from, 'manifest')
})

test('null authors and no manifest entry: no guests, nothing to fall back on', () => {
  assert.deepEqual(guestsForLabels({ row: { authors: null }, manifestGuests: undefined, host: HOST }), { guests: [], from: 'none' })
})

test('the host repeated in authors is dropped, by the first author or the host label, accents and case aside', () => {
  const c = guestsForLabels({ row: { authors: [HOST, 'Matt Walker', HOST, 'peter attia', 'Matt Walker'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c.guests, ['Matt Walker'])
  // First author is not the show's host label (a hand edit): the label's name is still never a guest.
  const d = guestsForLabels({ row: { authors: ['P. Attia', 'Matt Walker', 'Péter Attia'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(d.guests, ['Matt Walker'])
})

test('duplicate guests are listed once, in first-seen order', () => {
  const c = guestsForLabels({ row: { authors: [HOST, 'Matt Walker', 'Sara Gottfried', 'matt walker'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c.guests, ['Matt Walker', 'Sara Gottfried'])
})

test('no row: the manifest guests, or none at all', () => {
  assert.deepEqual(guestsForLabels({ row: undefined, manifestGuests: ['Matt Walker'], host: HOST }), { guests: ['Matt Walker'], from: 'manifest' })
  assert.deepEqual(guestsForLabels({ row: null, manifestGuests: undefined, host: HOST }), { guests: [], from: 'none' })
})

test('the manifest fallback is passed through unchanged and is a copy', () => {
  const manifest = ['A B', 'A B']
  const c = guestsForLabels({ row: { authors: null }, manifestGuests: manifest, host: HOST })
  assert.deepEqual(c.guests, ['A B', 'A B'])
  assert.notEqual(c.guests, manifest)
})

test('end to end: authors decide the Name: label baked into the transcript, not the manifest', () => {
  const seg = (speaker: number, text: string, start_ms: number): DgSegment => ({ speaker, text, start_ms, end_ms: start_ms + 1000 })
  const segments = [seg(0, 'Welcome.', 0), seg(1, 'Thanks.', 1000)]
  const text = (guests: string[]) => buildLabelledSegments(segments, nameSpeakers(segments, guests, HOST)).map(s => s.text).join(' ')
  const manifestGuests = ['Wrong Person']
  const fromAuthors = guestsForLabels({ row: { authors: [HOST, 'Matt Walker'] }, manifestGuests, host: HOST }).guests
  assert.equal(text(fromAuthors), 'Peter Attia: Welcome. Matt Walker: Thanks.')
  const soloByAuthors = guestsForLabels({ row: { authors: [HOST] }, manifestGuests, host: HOST }).guests
  assert.equal(text(soloByAuthors), 'Peter Attia: Welcome. Speaker 2: Thanks.')
})
