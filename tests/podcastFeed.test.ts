/**
 * Unit tests for the pure helpers in lib/podcastFeed.ts that the downloader's
 * `--keys` and `--fit-budget` paths depend on: the per-feed hours total (now
 * built on the shared estimate rule), the key-list reader, and the
 * select-exactly-these-keys step with its uniqueness assertions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseKeyList, selectByKeys, totalHours, type Episode } from '../lib/podcastFeed'

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
