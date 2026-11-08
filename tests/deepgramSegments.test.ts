/**
 * Unit tests for lib/deepgramSegments.ts speaker naming.
 *
 * The host is a required argument: the first speaker is whoever hosts THIS show.
 * It used to be a constant "Peter Attia", which would have labelled Andrew
 * Huberman's opening monologue with Attia's name.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nameSpeakers,
  buildLabelledSegments,
  transcriptText,
  cleanGuestNames,
  speakerGuestCandidates,
  chooseSpeakerGuests,
  manifestGuestsByKey,
  rebuildToStored,
  type DgSegment,
} from '../lib/deepgramSegments'
import { hostLabelForKey, showByPrefix } from '../lib/shows'

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

// ---------------------------------------------------------------------------
// Guest names come from the source row's `authors` (database), not the manifest
// ---------------------------------------------------------------------------

const drive = showByPrefix('attia')!
const huberman = showByPrefix('huberman')!
const fmf = showByPrefix('fmf')!

/** The text the attach would store for `twoSpeakers`, given a row's authors and a manifest's guests. */
function attachText(show: typeof drive, authors: string[] | null, manifest: string[] | undefined): string {
  const { guests } = chooseSpeakerGuests(show, authors, manifest)
  return transcriptText(buildLabelledSegments(twoSpeakers, nameSpeakers(twoSpeakers, guests, show.hostLabel)))
}

test('guests: the database authors win over the manifest guests', () => {
  const pick = chooseSpeakerGuests(huberman, ['Dr. Andrew Huberman', 'Dr. Scott Kanoski'], ['Old Title Rule Name'])
  assert.deepEqual(pick, { guests: ['Dr. Scott Kanoski'], source: 'database' })
  // End to end: the speaker label inside the transcript is the database's guest.
  const text = attachText(huberman, ['Dr. Andrew Huberman', 'Dr. Scott Kanoski'], ['Old Title Rule Name'])
  assert.match(text, /Dr\. Scott Kanoski: Thanks for having me\./)
  assert.doesNotMatch(text, /Old Title Rule Name/)
})

test('guests: a row with only the host, or no authors at all, falls back to the manifest guests', () => {
  for (const authors of [['Dr. Rhonda Patrick'], [], null]) {
    assert.deepEqual(chooseSpeakerGuests(fmf, authors, ['Dr. Valter Longo']), { guests: ['Dr. Valter Longo'], source: 'manifest' })
  }
  assert.match(attachText(fmf, ['Dr. Rhonda Patrick'], ['Dr. Valter Longo']), /Dr\. Valter Longo: Thanks for having me\./)
})

test('guests: nothing in the database or the manifest means no guest, and the other speaker stays numbered', () => {
  for (const manifest of [undefined, [], ['Dr. Rhonda Patrick']]) {
    assert.deepEqual(chooseSpeakerGuests(fmf, ['Dr. Rhonda Patrick'], manifest), { guests: [], source: 'none' })
  }
  assert.match(attachText(fmf, null, undefined), /Speaker 2: Thanks for having me\./)
})

test('guests: the host is never listed as a guest, whatever the spelling or position', () => {
  // host first (the ingest invariant), host last, host in the middle, another spelling
  assert.deepEqual(cleanGuestNames(drive, ['Dr. Peter Attia', 'Linus Abrams']), ['Linus Abrams'])
  assert.deepEqual(cleanGuestNames(drive, ['Linus Abrams', 'Dr. Peter Attia']), ['Linus Abrams'])
  assert.deepEqual(cleanGuestNames(drive, ['A One', 'peter attia, M.D.', 'B Two']), ['A One', 'B Two'])
  assert.deepEqual(cleanGuestNames(drive, ['Peter Attia']), [])
  // the first author is not the host (a hand-edited row): every non-host name is still a guest
  assert.deepEqual(cleanGuestNames(drive, ['Linus Abrams', 'Dr. Peter Attia']), ['Linus Abrams'])
  // ... and the manifest cannot smuggle the host in either
  assert.deepEqual(chooseSpeakerGuests(drive, null, ['Peter Attia']), { guests: [], source: 'none' })
  assert.deepEqual(chooseSpeakerGuests(drive, ['Dr. Peter Attia'], ['Dr. Peter Attia', 'Linus Abrams']), { guests: ['Linus Abrams'], source: 'manifest' })
  // so a lone real guest still names the other speaker, rather than reading as two "guests"
  assert.match(attachText(drive, ['Dr. Peter Attia', 'Peter Attia'], ['Linus Abrams']), /Linus Abrams: Thanks for having me\./)
})

test('guests: only THIS show\'s host is filtered — another show\'s host is a real guest', () => {
  assert.deepEqual(cleanGuestNames(huberman, ['Dr. Andrew Huberman', 'Dr. Rhonda Patrick']), ['Dr. Rhonda Patrick'])
  assert.deepEqual(cleanGuestNames(fmf, ['Dr. Rhonda Patrick', 'Dr. Andrew Huberman']), ['Dr. Andrew Huberman'])
})

test('guests: the speaker label for the host is the registry label, never authors[0]', () => {
  const text = attachText(drive, ['Dr. Peter Attia', 'Linus Abrams'], undefined)
  assert.ok(text.startsWith('Peter Attia: Welcome'))
  assert.doesNotMatch(text, /Dr\. Peter Attia/)
})

test('guests: names are trimmed, blanks and repeats dropped (ignoring case), and odd values ignored', () => {
  assert.deepEqual(cleanGuestNames(fmf, ['  Dr.  Valter   Longo ', '', '   ', 'dr. valter longo', 'Sue Smith']), ['Dr. Valter Longo', 'Sue Smith'])
  assert.deepEqual(cleanGuestNames(fmf, [42, null, undefined, {}, 'Sue Smith']), ['Sue Smith'])
  assert.deepEqual(cleanGuestNames(fmf, null), [])
  assert.deepEqual(cleanGuestNames(fmf, undefined), [])
  // a repeated guest counts once, so a lone guest still names the other speaker
  assert.match(attachText(fmf, ['Dr. Rhonda Patrick', 'Sue Smith', 'sue smith'], undefined), /Sue Smith: Thanks for having me\./)
})

test('guests: two guests in the database leave the speakers numbered, as before', () => {
  assert.match(attachText(huberman, ['Dr. Andrew Huberman', 'A One', 'B Two'], ['C Three']), /Speaker 2: Thanks for having me\./)
})

test('guests: candidates run database first, manifest second, and drop a manifest that adds nothing', () => {
  assert.deepEqual(speakerGuestCandidates(drive, ['Dr. Peter Attia', 'New Guest'], ['Old Guest']), [
    { guests: ['New Guest'], source: 'database' },
    { guests: ['Old Guest'], source: 'manifest' },
  ])
  assert.deepEqual(speakerGuestCandidates(drive, ['Dr. Peter Attia', 'Same Guest'], ['same guest']), [
    { guests: ['Same Guest'], source: 'database' },
  ])
  assert.deepEqual(speakerGuestCandidates(drive, ['Dr. Peter Attia'], []), [])
})

test('manifestGuestsByKey reads guests by key and tolerates a broken manifest', () => {
  const m = manifestGuestsByKey({ episodes: [{ key: 'a-1', guests: ['X Y'] }, { key: 'a-2' }, { key: 'a-3', guests: ['P Q', 7] }, { guests: ['no key'] }, null] })
  assert.deepEqual([...m.entries()], [['a-1', ['X Y']], ['a-2', []], ['a-3', ['P Q']]])
  for (const bad of [null, undefined, 'x', 3, {}, { episodes: 'nope' }]) assert.equal(manifestGuestsByKey(bad).size, 0)
})

test('rebuildToStored keeps the stored labels when the database guests changed after the attach', () => {
  // Attached when the manifest's title-rule guest was the only one; refreshGuests has since put someone else in `authors`.
  const stored = attachText(huberman, ['Dr. Andrew Huberman'], ['Old Title Rule Name'])
  assert.match(stored, /Old Title Rule Name: Thanks/)
  const candidates = speakerGuestCandidates(huberman, ['Dr. Andrew Huberman', 'Dr. Scott Kanoski'], ['Old Title Rule Name'])
  assert.equal(candidates[0].source, 'database')
  const r = rebuildToStored(twoSpeakers, 'Andrew Huberman', candidates, stored)
  assert.ok(r)
  assert.equal(r.source, 'manifest')
  assert.equal(transcriptText(r.segments), stored)
})

test('rebuildToStored prefers the current database guests when they reproduce the stored text', () => {
  const stored = attachText(huberman, ['Dr. Andrew Huberman', 'Dr. Scott Kanoski'], undefined)
  const r = rebuildToStored(twoSpeakers, 'Andrew Huberman', speakerGuestCandidates(huberman, ['Dr. Andrew Huberman', 'Dr. Scott Kanoski'], ['Old']), stored)
  assert.equal(r?.source, 'database')
})

test('rebuildToStored falls back to "no guest" for a transcript that was stored numbered, and gives up on edited text', () => {
  const numbered = attachText(fmf, null, undefined)
  const candidates = speakerGuestCandidates(fmf, ['Dr. Rhonda Patrick', 'Sue Smith'], undefined)
  assert.equal(rebuildToStored(twoSpeakers, 'Rhonda Patrick', candidates, numbered)?.source, 'none')
  assert.equal(rebuildToStored(twoSpeakers, 'Rhonda Patrick', candidates, numbered + ' edited by hand'), null)
})
