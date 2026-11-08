/**
 * Unit tests for the pure helpers in lib/podcastFeed.ts that the downloader's
 * `--keys` and `--fit-budget` paths depend on: the per-feed hours total (now
 * built on the shared estimate rule), the key-list reader, and the
 * select-exactly-these-keys step with its uniqueness assertions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  parseKeyList,
  selectByKeys,
  totalHours,
  parseFeed,
  parseGuests,
  parseEpisodeNumber,
  isFeedKey,
  titleKey,
  matchOlderRows,
  mergeManifestEpisodes,
  type Episode,
} from '../lib/podcastFeed'

const ep = (key: string, extra: Partial<Episode> = {}): Episode => ({
  key,
  title: key,
  episode_number: null,
  guests: [],
  published_at: null,
  duration_seconds: null,
  description: null,
  page_url: null,
  guid: key,
  audio_url: `https://example.invalid/${key}.mp3?key=secret`,
  audio_bytes: null,
  file: `${key}.mp3`,
  ...extra,
})

test('totalHours: duration tag when present, bytes at 128 kbps otherwise, and counts the estimated ones', () => {
  const eps = [
    ep('tagged', { duration_seconds: 3600, audio_bytes: 999 }),
    ep('sized', { duration_seconds: null, audio_bytes: 57_600_000 }),
    ep('zero-tag-sized', { duration_seconds: 0, audio_bytes: 28_800_000 }),
    ep('nothing', { duration_seconds: null, audio_bytes: null }),
  ]
  const { hours, estimated } = totalHours(eps)
  assert.ok(Math.abs(hours - 2.5) < 1e-9, `hours=${hours}`)
  assert.equal(estimated, 2)
  assert.deepEqual(totalHours([]), { hours: 0, estimated: 0 })
  assert.equal(totalHours([ep('sized', { audio_bytes: 57_600_000 })], 64_000).hours, 2)
})

test('parseKeyList: one key per line, comments and blanks dropped, duplicates collapsed, order kept', () => {
  const text = [
    '# the 98 twins first',
    'attia-0239',
    '',
    '  attia-0101  ',
    'attia-0239   # again, on purpose',
    'attia-g1a2b3c',
    '\tattia-0007\t',
  ].join('\n')
  assert.deepEqual(parseKeyList(text), ['attia-0239', 'attia-0101', 'attia-g1a2b3c', 'attia-0007'])
  assert.deepEqual(parseKeyList(''), [])
  assert.deepEqual(parseKeyList('# only comments\n\n'), [])
  assert.deepEqual(parseKeyList('a\r\nb\r\n'), ['a', 'b'])
})

test('parseKeyList: accepts audio and transcript filenames as keys', () => {
  assert.deepEqual(
    parseKeyList('attia-0239.mp3\nattia-0240.deepgram.json\nattia-0241.nova-3-medical.deepgram.json\nattia-0239'),
    ['attia-0239', 'attia-0240', 'attia-0241']
  )
})

test('selectByKeys: returns exactly the listed episodes, in list order', () => {
  const feed = [ep('attia-0405'), ep('attia-0404'), ep('attia-0403'), ep('attia-0402')]
  const picked = selectByKeys(feed, ['attia-0402', 'attia-0405'])
  assert.deepEqual(picked.map(e => e.key), ['attia-0402', 'attia-0405'])
  assert.deepEqual(selectByKeys(feed, []), [])
})

test('selectByKeys: a key that is not in the feed is an error that names it', () => {
  const feed = [ep('attia-0405'), ep('attia-0404')]
  assert.throws(() => selectByKeys(feed, ['attia-0405', 'attia-9999', 'attia-0001']), /2 key\(s\) are not in the feed: attia-9999, attia-0001/)
})

test('selectByKeys: refuses a feed whose keys are not unique', () => {
  const feed = [ep('attia-0405'), ep('attia-0405')]
  assert.throws(() => selectByKeys(feed, ['attia-0405']), /attia-0405 twice/)
})

// ── Show-aware parsing (FoundMyFitness, Huberman Lab, The Drive) ─────────────
// The titles below are REAL feed titles (checked against the live feeds on
// 2026-11-08); only the audio URLs and guids are made up.

const fp = (guid: string) => createHash('sha1').update(guid).digest('hex').slice(0, 6)

const item = (o: { title: string; guid: string; link?: string; length?: number | string; cdataLink?: boolean; duration?: string }) => `
  <item>
    <title>${o.title.replace(/&/g, '&amp;')}</title>
    <guid isPermaLink="false">${o.guid}</guid>
    ${o.link ? (o.cdataLink ? `<link><![CDATA[${o.link}]]></link>` : `<link>${o.link}</link>`) : ''}
    <pubDate>Mon, 03 Nov 2025 08:00:00 +0000</pubDate>
    <itunes:duration>${o.duration ?? '01:00:00'}</itunes:duration>
    <enclosure url="https://example.invalid/${fp(o.guid)}.mp3?key=secret" length="${o.length ?? 1000}" type="audio/mpeg"/>
  </item>`
const rss = (...items: string[]) => `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`

const FMF_XML = rss(
  item({ title: '#114 How Meditation Rewires Your Brain, Gut, & Immune System | Dr. Richard Davidson', guid: 'fmf-g-114', link: 'https://foundmyfitness.libsyn.com/114-how-meditation-rewires-your-brain-gut-immune-system-dr-richard-davidson', cdataLink: true, length: 105294288 }),
  item({ title: '#115 The Science of Blueberries for Brain and Vascular Health', guid: 'fmf-g-115', link: 'https://foundmyfitness.libsyn.com/115-the-science-of-blueberries-for-brain-and-vascular-health', cdataLink: true, length: 68124340 }),
  item({ title: '#092 The Truth About Alcohol: Risks, Benefits, and Everything In-Between | Dr. Rhonda Patrick', guid: 'fmf-g-092', link: 'https://foundmyfitness.libsyn.com/092-the-truth-about-alcohol', cdataLink: true }),
)

const HUBERMAN_XML = rss(
  item({ title: 'How Food Choices Shape Memory, Cognition & Cravings | Dr. Scott Kanoski', guid: 'hub-kanoski', link: 'https://www.hubermanlab.com/episode/how-food-choices-shape-memory-cognition-and-cravings-scott-kanoski', length: 0 }),
  item({ title: 'Master Your Sleep & Be More Alert When Awake', guid: 'hub-sleep', link: 'https://www.hubermanlab.com/episode/master-your-sleep-and-be-more-alert-when-awake', length: 0 }),
  item({ title: 'AMA #19: Collagen vs. Whey Protein, Creatine, Smelling Salts, Stimulants & More', guid: 'hub-ama19', link: 'https://www.hubermanlab.com/episode/ama-19-collagen-vs-whey-protein-creatine-smelling-salts-stimulants', length: 0 }),
  item({ title: 'GUEST SERIES | Dr. Matt Walker: The Science of Dreams, Nightmares & Lucid Dreaming', guid: 'hub-walker', link: 'https://www.hubermanlab.com/episode/guest-series-dr-matt-walker-the-science-of-dreams-nightmares-lucid-dreaming', length: 0 }),
  item({ title: 'Journal Club With Dr. Peter Attia | Metformin for Longevity & the Power of Belief Effects', guid: 'hub-jc', link: 'https://www.hubermanlab.com/episode/journal-club-with-dr-peter-attia-metformin-for-longevity-and-the-power-of-belief-effects', length: 0 }),
  item({ title: 'The Best Vitality & Health Protocols | Dr. Rhonda Patrick', guid: 'hub-rp', length: 0 }),
)

const DRIVE_XML = rss(
  item({ title: '#404 ‒ Topic of the week | Linus Abrams, M.D.', guid: 'https://peterattia.supercast.tech/episodes/abc?key=SECRETKEY', length: 50000000 }),
  item({ title: '#287 ‒ AMA #52 (#287 rebroadcast) | Dr. Someone', guid: 'https://peterattia.supercast.tech/episodes/def?key=SECRETKEY' }),
)

test('parseFeed fmf: numbered keys, guests only for real guest credits, never the host', () => {
  const eps = parseFeed(FMF_XML, 'fmf')
  assert.deepEqual(eps.map(e => e.key), ['fmf-0114', 'fmf-0115', 'fmf-0092'])
  assert.deepEqual(eps.map(e => e.episode_number), [114, 115, 92])
  assert.deepEqual(eps[0].guests, ['Dr. Richard Davidson'])
  assert.deepEqual(eps[1].guests, [], 'a solo title with no pipe has no guest')
  assert.deepEqual(eps[2].guests, [], 'a title ending in the host\'s own name is solo, not a guest')
  assert.equal(eps[0].audio_bytes, 105294288)
})

test('parseFeed fmf: the CDATA <link> is the public episode page (and keeps no query string)', () => {
  const eps = parseFeed(FMF_XML, 'fmf')
  assert.equal(eps[0].page_url, 'https://foundmyfitness.libsyn.com/114-how-meditation-rewires-your-brain-gut-immune-system-dr-richard-davidson')
  assert.equal(eps[1].page_url, 'https://foundmyfitness.libsyn.com/115-the-science-of-blueberries-for-brain-and-vascular-health')
})

test('parseFeed huberman: no episode numbers at all; keys come from the guid', () => {
  const eps = parseFeed(HUBERMAN_XML, 'huberman')
  assert.equal(eps.length, 6)
  for (const e of eps) {
    assert.equal(e.episode_number, null, e.title)
    assert.match(e.key, /^huberman-g[0-9a-f]{6}$/, e.title)
    assert.equal(e.file, `${e.key}.mp3`)
  }
  assert.equal(eps[1].key, `huberman-g${fp('hub-sleep')}`)
  assert.equal(eps.find(e => e.title.startsWith('AMA #19'))!.episode_number, null, '"AMA #19" is the 19th AMA, not episode 19')
  assert.equal(new Set(eps.map(e => e.key)).size, eps.length)
})

test('parseFeed huberman: guests from GUEST SERIES and a plain guest credit; the Journal Club topic is not a guest', () => {
  const eps = parseFeed(HUBERMAN_XML, 'huberman')
  const guests = (start: string) => eps.find(e => e.title.startsWith(start))!.guests
  assert.deepEqual(guests('How Food Choices'), ['Dr. Scott Kanoski'])
  assert.deepEqual(guests('GUEST SERIES'), ['Dr. Matt Walker'], 'the colon ends the name; the topic\'s commas are not more guests')
  assert.deepEqual(guests('Master Your Sleep'), [])
  assert.deepEqual(guests('AMA #19'), [])
  assert.deepEqual(guests('Journal Club'), [], 'the topic after the pipe is not a name')
  assert.deepEqual(guests('The Best Vitality'), ['Dr. Rhonda Patrick'], 'another show\'s host is a normal guest here')
})

test('parseFeed huberman: enclosure length="0" means unknown, not an empty file', () => {
  for (const e of parseFeed(HUBERMAN_XML, 'huberman')) assert.equal(e.audio_bytes, null, e.title)
})

test('parseFeed huberman: an item with no <link> has no page url, and never a private one', () => {
  const eps = parseFeed(HUBERMAN_XML, 'huberman')
  assert.equal(eps.find(e => e.title.startsWith('The Best Vitality'))!.page_url, null)
  assert.equal(eps[0].page_url, 'https://www.hubermanlab.com/episode/how-food-choices-shape-memory-cognition-and-cravings-scott-kanoski')
})

test('parseFeed the Drive: unchanged — numbered keys, legacy guest rule, private guid never exposed as a page', () => {
  const eps = parseFeed(DRIVE_XML, 'attia')
  assert.deepEqual(eps.map(e => e.key), ['attia-0404', 'attia-0287'])
  assert.deepEqual(eps[0].guests, ['Linus Abrams'])
  // The legacy (non-strict) rule keeps what it always returned for this title.
  assert.deepEqual(eps[1].guests, ['Dr. Someone'])
  for (const e of eps) {
    assert.doesNotMatch(JSON.stringify(e), /SECRETKEY/, 'the membership key is redacted everywhere')
  }
  assert.equal(eps[0].audio_bytes, 50000000)
})

test('parseFeed: a prefix that is not registered parses like the Drive did (numbered, legacy guests)', () => {
  const eps = parseFeed(DRIVE_XML, 'mystery')
  assert.deepEqual(eps.map(e => e.key), ['mystery-0404', 'mystery-0287'])
})

test('parseGuests: legacy rule is untouched, strict rule only adds the two new forms', () => {
  assert.deepEqual(parseGuests('#404 ‒ x | Linus Abrams, M.D.'), ['Linus Abrams'])
  assert.deepEqual(parseGuests('#404 ‒ x | Linus Abrams, M.D.', true), ['Linus Abrams'])
  assert.deepEqual(parseGuests('#100 AMA | AMA #52'), [])
  assert.deepEqual(parseGuests('no pipe here'), [])
  // GUEST SERIES: the legacy rule splits the topic on commas; strict reads the name before the colon.
  assert.deepEqual(parseGuests('GUEST SERIES | Dr. Matt Walker: Sleep, Dreams & Memory', true), ['Dr. Matt Walker'])
  assert.deepEqual(parseGuests('GUEST SERIES | Dr. Paul Conti: Tools and Protocols for Mental Health', true), ['Dr. Paul Conti'])
  // A leading role is dropped.
  assert.deepEqual(parseGuests('#350 Politics of health | U.S. Surgeon General Dr. Vivek Murthy', true), ['Dr. Vivek Murthy'])
  // Topic tails are not names.
  assert.deepEqual(parseGuests('Journal Club With Dr. Peter Attia | Metformin for Longevity & the Power of Belief Effects', true), [])
  // A real credit with a lowercase connective inside survives.
  assert.deepEqual(parseGuests('Mitochondria | Derek from MPMD', true), ['Derek from MPMD'])
  // Two guests still split.
  assert.deepEqual(parseGuests('Two views | Dr. Ann Lee & Dr. Bob Roe', true), ['Dr. Ann Lee', 'Dr. Bob Roe'])
})

test('parseEpisodeNumber reads #N anywhere (the registry decides whether a show uses it)', () => {
  assert.equal(parseEpisodeNumber('#114 How Meditation Rewires Your Brain'), 114)
  assert.equal(parseEpisodeNumber('AMA #19: Collagen vs. Whey Protein'), 19)
  assert.equal(parseEpisodeNumber('Master Your Sleep & Be More Alert When Awake'), null)
})

test('isFeedKey: keys the feed reader produces, not the older published-transcript slugs', () => {
  for (const k of ['fmf-0114', 'fmf-12345', 'fmf-g1a2b3c', 'fmf-0114-1a2b3c', 'fmf-0114-1a2b3c-2']) assert.equal(isFeedKey('fmf', k), true, k)
  for (const k of ['fmf-george-church', 'fmf-george-church-2', 'attia-0114', 'fmf-', 'fmf']) assert.equal(isFeedKey('fmf', k), false, k)
  assert.equal(isFeedKey('huberman', 'huberman-g3fb2c5'), true)
  assert.equal(isFeedKey('fmf', null), false)
})

test('titleKey: same episode, different number / case / punctuation / spacing', () => {
  assert.equal(titleKey('#114 How Meditation Rewires Your Brain, Gut, & Immune System | Dr. Richard Davidson'), titleKey('how meditation rewires your brain gut immune system dr richard davidson'))
  assert.equal(titleKey('#092 The Truth About Alcohol'), 'the truth about alcohol')
  assert.notEqual(titleKey('#114 A'), titleKey('#114 B'))
})

test('matchOlderRows: the older fmf-<slug> rows pair with their feed episode, one-to-one only', () => {
  const eps = parseFeed(FMF_XML, 'fmf')
  const older = [
    // exact title (numbers and punctuation ignored)
    { id: 'r1', external_id: 'fmf-the-science-of-blueberries', title: 'The Science of Blueberries for Brain and Vascular Health' },
    // reworded title, matched by the slug's words
    { id: 'r2', external_id: 'fmf-richard-davidson', title: 'Meditation and the brain' },
    // nothing in the feed fits
    { id: 'r3', external_id: 'fmf-george-church', title: 'Reversing aging' },
  ]
  const m = matchOlderRows(eps, older, 'fmf')
  assert.equal(m.get('fmf-0115')?.id, 'r1')
  assert.equal(m.get('fmf-0114')?.id, 'r2')
  assert.equal(m.size, 2)
})

test('matchOlderRows: doubt means no match — two rows for one episode, or one row for two episodes', () => {
  const eps = parseFeed(FMF_XML, 'fmf')
  const twoRows = [
    { id: 'a', external_id: 'fmf-richard-davidson', title: 'x' },
    { id: 'b', external_id: 'fmf-richard-davidson-2', title: 'y' },
  ]
  assert.equal(matchOlderRows(eps, twoRows, 'fmf').size, 0)
  const twoEps = [
    { key: 'fmf-0001', title: '#1 Sleep and Memory with Dr. Matt Walker' },
    { key: 'fmf-0002', title: '#2 Sleep Revisited with Dr. Matt Walker' },
  ]
  assert.equal(matchOlderRows(twoEps, [{ id: 'c', external_id: 'fmf-matt-walker', title: 'z' }], 'fmf').size, 0)
  // A one-word slug is too weak to match on.
  assert.equal(matchOlderRows(eps, [{ id: 'd', external_id: 'fmf-davidson', title: 'z' }], 'fmf').size, 0)
})

test('mergeManifestEpisodes: a run replaces only its own show\'s entries', () => {
  const existing = [{ key: 'attia-0404', g: 1 }, { key: 'fmf-0114', g: 2 }, { key: 'fmf-0115', g: 3 }]
  const merged = mergeManifestEpisodes(existing, 'fmf', [{ key: 'fmf-0114', g: 9 }])
  assert.deepEqual(merged, [{ key: 'attia-0404', g: 1 }, { key: 'fmf-0114', g: 9 }])
  assert.deepEqual(mergeManifestEpisodes([], 'huberman', [{ key: 'huberman-gabc123' }]), [{ key: 'huberman-gabc123' }])
  // A prefix that merely starts the same is not the same show.
  assert.deepEqual(mergeManifestEpisodes([{ key: 'fmfx-1' }], 'fmf', []), [{ key: 'fmfx-1' }])
})
