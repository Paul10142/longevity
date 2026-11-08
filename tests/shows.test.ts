/**
 * Unit tests for lib/shows.ts — the one registry that says which podcasts the
 * library ingests and who hosts each. The property that matters: nothing about
 * The Drive changes, and a Huberman or FoundMyFitness row never resolves to
 * Peter Attia.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHOWS,
  DEFAULT_SHOW,
  showBySeries,
  showByPrefix,
  showByExternalId,
  showByHostName,
  showForSource,
  isHostName,
  canonicalHostLabel,
  hostLabelForKey,
  externalIdPrefix,
} from '../lib/shows'

const by = (prefix: string) => SHOWS.find(s => s.prefix === prefix)!

test('registry: three shows, unique series / prefix / env, The Drive first and the default', () => {
  assert.deepEqual(SHOWS.map(s => s.prefix), ['attia', 'fmf', 'huberman'])
  assert.deepEqual(SHOWS.map(s => s.series), ['The Drive', 'FoundMyFitness', 'Huberman Lab'])
  assert.deepEqual(SHOWS.map(s => s.env), ['ATTIA_FEED_URL', 'FMF_FEED_URL', 'HUBERMAN_FEED_URL'])
  for (const k of ['series', 'prefix', 'env'] as const) assert.equal(new Set(SHOWS.map(s => s[k])).size, SHOWS.length, k)
  assert.equal(DEFAULT_SHOW, SHOWS[0])
  assert.equal(DEFAULT_SHOW.series, 'The Drive')
})

test('registry: The Drive keeps exactly the values the pipeline hard-coded before', () => {
  const d = by('attia')
  assert.equal(d.host, 'Dr. Peter Attia')
  assert.equal(d.hostLabel, 'Peter Attia')
  assert.deepEqual(d.keyterms, ['Peter Attia', 'Attia'])
  assert.equal(d.numbered, true)
  assert.equal(d.strictGuests, false)
  assert.equal(d.searchBase, 'https://peterattiamd.com/?s=')
  assert.equal(d.siteHost, 'peterattiamd.com')
  assert.equal(d.searchByNumber, true)
})

test('registry: Huberman Lab does not number episodes; FoundMyFitness does not search by number', () => {
  assert.equal(by('huberman').numbered, false)
  assert.equal(by('fmf').numbered, true)
  assert.equal(by('fmf').searchByNumber, false)
  assert.equal(by('huberman').searchByNumber, false)
  assert.equal(by('fmf').strictGuests && by('huberman').strictGuests, true)
})

test('every show: search base ends where the query goes, host patterns recognise their own host', () => {
  for (const s of SHOWS) {
    assert.match(s.searchBase, /^https:\/\/.+[?=]$/, s.series)
    assert.ok(s.searchBase.includes(s.siteHost), s.series)
    assert.ok(s.hostPattern.test(s.hostLabel), `${s.series}: ${s.hostLabel}`)
    assert.ok(s.hostPattern.test(s.host), `${s.series}: ${s.host}`)
    assert.ok(s.hostMention.test(s.host), s.series)
    assert.ok(s.keyterms.includes(s.hostLabel), `${s.series} keyterms name the host`)
  }
})

test('lookups by series, prefix and external_id', () => {
  assert.equal(showBySeries('Huberman Lab')?.prefix, 'huberman')
  assert.equal(showBySeries('  foundmyfitness ')?.prefix, 'fmf')
  assert.equal(showBySeries('Some Other Show'), null)
  assert.equal(showBySeries(null), null)
  assert.equal(showBySeries('   '), null)
  assert.equal(showByPrefix('FMF')?.series, 'FoundMyFitness')
  assert.equal(showByPrefix('nope'), null)
  assert.equal(showByPrefix(undefined), null)
  assert.equal(showByExternalId('attia-0405')?.series, 'The Drive')
  assert.equal(showByExternalId('attia-g1a2b3')?.series, 'The Drive')
  assert.equal(showByExternalId('fmf-george-church')?.series, 'FoundMyFitness')
  assert.equal(showByExternalId('huberman-g3fb2c5')?.series, 'Huberman Lab')
  assert.equal(showByExternalId('yt-dQw4w9WgXc'), null)
  assert.equal(showByExternalId('nodash'), null)
  assert.equal(showByExternalId(null), null)
  assert.equal(externalIdPrefix('huberman-g3fb2c5'), 'huberman')
  assert.equal(externalIdPrefix('-leading'), null)
})

test('showByHostName matches authors[0] in any usual spelling', () => {
  assert.equal(showByHostName('Dr. Peter Attia')?.prefix, 'attia')
  assert.equal(showByHostName('peter attia')?.prefix, 'attia')
  assert.equal(showByHostName('Rhonda Patrick')?.prefix, 'fmf')
  assert.equal(showByHostName('Dr. Andrew Huberman')?.prefix, 'huberman')
  assert.equal(showByHostName('Linus Abrams'), null)
  assert.equal(showByHostName(undefined), null)
})

test('showForSource: series wins, then the key prefix, then authors[0], then The Drive', () => {
  assert.equal(showForSource({ series: 'Huberman Lab', external_id: 'attia-0001' }).prefix, 'huberman')
  assert.equal(showForSource({ series: null, external_id: 'fmf-0114' }).prefix, 'fmf')
  assert.equal(showForSource({ external_id: null, authors: ['Dr. Andrew Huberman', 'Dr. Matt Walker'] }).prefix, 'huberman')
  // An unknown series does not block the next rule.
  assert.equal(showForSource({ series: 'Mystery', external_id: 'fmf-0114' }).prefix, 'fmf')
})

test('showForSource: the pre-feed Drive rows (series set, no external_id) and bare rows stay The Drive', () => {
  assert.equal(showForSource({ series: 'The Drive', external_id: null, authors: ['Peter Attia'] }).prefix, 'attia')
  assert.equal(showForSource({ series: null, external_id: null, authors: null }), DEFAULT_SHOW)
  assert.equal(showForSource({}), DEFAULT_SHOW)
  assert.equal(showForSource({ external_id: 'yt-abc' }), DEFAULT_SHOW)
})

test('isHostName: the host is never a guest, but a different show\'s host can be', () => {
  assert.equal(isHostName(by('attia'), 'Dr. Peter Attia'), true)
  assert.equal(isHostName(by('attia'), 'Peter Attia, M.D.'), true)
  assert.equal(isHostName(by('huberman'), 'Dr. Peter Attia'), false)
  assert.equal(isHostName(by('huberman'), 'Dr. Andrew D. Huberman'), true)
  assert.equal(isHostName(by('fmf'), 'Dr. Rhonda Patrick'), true)
})

test('canonicalHostLabel: collapses any registered host\'s spellings, leaves everyone else alone', () => {
  for (const s of ['Dr. Peter Attia', 'dr peter attia', 'Peter Attia, M.D.', 'peter attia', '  Peter Attia ']) {
    assert.equal(canonicalHostLabel(s), 'Peter Attia', s)
  }
  assert.equal(canonicalHostLabel('Dr. Andrew Huberman'), 'Andrew Huberman')
  assert.equal(canonicalHostLabel('Andrew D. Huberman, PhD'), 'Andrew Huberman')
  assert.equal(canonicalHostLabel('Dr. Rhonda Patrick'), 'Rhonda Patrick')
  assert.equal(canonicalHostLabel('Micky Collins'), 'Micky Collins')
  // Anchored: a name that merely contains a host's is not collapsed.
  assert.equal(canonicalHostLabel('Peter Attia Jr.'), 'Peter Attia Jr.')
})

test('hostLabelForKey: the speaker label for a join key, null (never a guess) for an unregistered prefix', () => {
  assert.equal(hostLabelForKey('attia-0405'), 'Peter Attia')
  assert.equal(hostLabelForKey('fmf-0114'), 'Rhonda Patrick')
  assert.equal(hostLabelForKey('huberman-g3fb2c5'), 'Andrew Huberman')
  assert.equal(hostLabelForKey('lexfridman-0001'), null)
  assert.equal(hostLabelForKey('nodash'), null)
})
