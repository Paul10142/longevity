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

test('the manifest fallback is a copy, with repeats removed', () => {
  const manifest = ['A B', 'A B']
  const c = guestsForLabels({ row: { authors: null }, manifestGuests: manifest, host: HOST })
  assert.deepEqual(c.guests, ['A B'])
  assert.notEqual(c.guests, manifest)
})

// authors carries each guest as the show writes them (credentials included); labels are bare.

test('credentialed authors label the speaker with the bare name', () => {
  const c = guestsForLabels({ row: { authors: ['Dr. Peter Attia', 'Sally Greenwald, M.D., M.P.H.'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c, { guests: ['Sally Greenwald'], from: 'authors' })
  const d = guestsForLabels({ row: { authors: [HOST, 'Max Diehn, M.D. Ph.D.', 'Arthur Brooks Ph.D.', 'David Allison, Ph.D.', 'Dr. Jane Roe'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(d.guests, ['Max Diehn', 'Arthur Brooks', 'David Allison', 'Jane Roe'])
})

test('two credentialed guests keep their order, one label each', () => {
  const c = guestsForLabels({ row: { authors: [HOST, 'BJ Miller, M.D.', 'Bridget Sumser, L.C.S.W.'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c.guests, ['BJ Miller', 'Bridget Sumser'])
})

test('a credential left standing alone by the old comma split is not a second guest', () => {
  // The Drive's legacy rows: `Sally Greenwald, M.D., M.P.H.` was split on commas.
  const legacy = guestsForLabels({ row: { authors: ['Dr. Peter Attia', 'Sally Greenwald', 'M.P.H.'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(legacy.guests, ['Sally Greenwald'])
  const segments: DgSegment[] = [
    { speaker: 0, text: 'Welcome.', start_ms: 0, end_ms: 1000 },
    { speaker: 1, text: 'Thanks.', start_ms: 1000, end_ms: 2000 },
  ]
  const names = nameSpeakers(segments, legacy.guests, HOST)
  assert.equal(buildLabelledSegments(segments, names).map(s => s.text).join(' '), 'Peter Attia: Welcome. Sally Greenwald: Thanks.')
})

test('a credentialed and a bare spelling of one guest are one guest', () => {
  const c = guestsForLabels({ row: { authors: [HOST, 'Sally Greenwald, M.D.', 'Sally Greenwald'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c.guests, ['Sally Greenwald'])
})

test('the host written with credentials is still never a guest', () => {
  const c = guestsForLabels({ row: { authors: ['Dr. Peter Attia', 'Peter Attia, M.D.', 'Matt Walker, Ph.D.'] }, manifestGuests: [], host: HOST })
  assert.deepEqual(c.guests, ['Matt Walker'])
})

test('manifest guests are bare too', () => {
  const c = guestsForLabels({ row: { authors: null }, manifestGuests: ['Dr. Richard Davidson', 'Jane Roe, Ph.D.', 'M.P.H.'], host: HOST })
  assert.deepEqual(c, { guests: ['Richard Davidson', 'Jane Roe'], from: 'manifest' })
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

test('re-attach after the credentials are added: the transcript text is the same, and a credential fragment no longer hides the guest', () => {
  const seg = (speaker: number, text: string, start_ms: number): DgSegment => ({ speaker, text, start_ms, end_ms: start_ms + 1000 })
  const segments = [seg(0, 'Welcome.', 0), seg(1, 'Thanks.', 1000)]
  const text = (authors: string[]) =>
    buildLabelledSegments(segments, nameSpeakers(segments, guestsForLabels({ row: { authors }, manifestGuests: [], host: HOST }).guests, HOST)).map(s => s.text).join(' ')
  const bare = text([HOST, 'Sally Greenwald'])
  assert.equal(bare, 'Peter Attia: Welcome. Sally Greenwald: Thanks.')
  // Adding the credentials to `sources.authors` changes nothing a label shows, so an episode already attached
  // with bare names still matches what the timing repair rebuilds (no TEXT MISMATCH).
  assert.equal(text([HOST, 'Sally Greenwald, M.D., M.P.H.']), bare)
  assert.equal(text([HOST, 'Dr. Sally Greenwald, M.D.']), bare)
  // The old comma split left `M.P.H.` as a second "guest", which made the label `Speaker 2`; re-attaching names her.
  assert.equal(text([HOST, 'Sally Greenwald', 'M.D.', 'M.P.H.']), bare)
})
