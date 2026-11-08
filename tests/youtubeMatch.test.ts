import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchVideo, parseCatalogTsv, titleEpisodeNumber, titleTokens, type CatalogVideo } from '../lib/youtubeMatch'

const cat: CatalogVideo[] = [
  { id: 'AAAAAAAAAAA', title: '253 ‒ Hormone replacement therapy and the Women’s Health Initiative | JoAnn Manson, M.D.', durationSec: 9000 },
  { id: 'BBBBBBBBBBB', title: 'Why hormone therapy decisions are so hard | JoAnn Manson, M.D.', durationSec: 150 },
  { id: 'CCCCCCCCCCC', title: '174-The 20th anniversary of the 9/11 attacks: reflections & lessons learned', durationSec: 12000 },
  { id: 'DDDDDDDDDDD', title: '196 - [AMA 32 Sneak Peek] Exercise, squats, deadlifts', durationSec: 1000 },
  { id: 'EEEEEEEEEEE', title: 'Sleep and memory', durationSec: 5000 },
  { id: 'FFFFFFFFFFF', title: 'Sleep and memory', durationSec: 5100 },
]

test('episode number and title words are read through the channel formatting', () => {
  assert.equal(titleEpisodeNumber('#253 ‒ Hormone'), 253)
  assert.equal(titleEpisodeNumber('174-The 20th'), 174)
  assert.equal(titleEpisodeNumber('Sleep and memory'), null)
  assert.deepEqual(titleTokens('#253 ‒ Women’s Health & More'), ['women', 's', 'health', 'and', 'more'])
})

test('an identical title (ignoring the number marker and punctuation) matches', () => {
  const r = matchVideo({ title: '#253 ‒ Hormone replacement therapy and the Women’s Health Initiative | JoAnn Manson, M.D.', episodeNumber: 253, durationSec: 9100 }, cat)
  assert.deepEqual(r, { videoId: 'AAAAAAAAAAA', how: 'exact-title', score: 1 })
})

test('the episode number picks the full episode when the channel shortened the title', () => {
  const r = matchVideo({ title: '#174 - Lawrence Wright: The 20th anniversary of the 9/11 attacks: reflections on how they happened', episodeNumber: 174, durationSec: 10800 }, cat)
  assert.equal(r.videoId, 'CCCCCCCCCCC')
})

test('a short sneak-peek with the same number is rejected on length', () => {
  const r = matchVideo({ title: '#196 - AMA #32: Exercise, squats, deadlifts', episodeNumber: 196, durationSec: 4800 }, cat)
  assert.equal(r.videoId, null)
})

test('a short clip with a similar title is not the episode', () => {
  const r = matchVideo({ title: 'Why hormone therapy decisions are so hard | JoAnn Manson, M.D.', episodeNumber: null, durationSec: 9000 }, cat)
  assert.deepEqual(r, { videoId: null, reason: 'duration-mismatch' })
})

test('two equally good uploads are ambiguous, never guessed', () => {
  const r = matchVideo({ title: 'Sleep and memory', episodeNumber: null, durationSec: null }, cat)
  assert.deepEqual(r, { videoId: null, reason: 'ambiguous' })
})

test('the length can settle two identical titles', () => {
  const r = matchVideo({ title: 'Sleep and memory', episodeNumber: null, durationSec: 5090 }, [cat[4], { ...cat[5], durationSec: 9000 }])
  assert.equal(r.videoId, 'EEEEEEEEEEE')
})

test('an unknown title, or none, stays blank', () => {
  assert.deepEqual(matchVideo({ title: 'Something nobody uploaded', episodeNumber: null, durationSec: null }, cat), { videoId: null, reason: 'no-candidate' })
  assert.deepEqual(matchVideo({ title: null, episodeNumber: null, durationSec: null }, cat), { videoId: null, reason: 'no-title' })
})

test('a different episode number blocks a similar title', () => {
  const r = matchVideo({ title: '#999 ‒ Hormone replacement therapy and the Women’s Health Initiative | JoAnn Manson, M.D.', episodeNumber: 999, durationSec: 9000 }, cat)
  assert.equal(r.videoId, null)
})

test('parseCatalogTsv keeps well-formed rows only', () => {
  const v = parseCatalogTsv('abcdefghijk\tA title\t123\nbad\tNope\t1\nlmnopqrstuv\tNo length\tNA\n')
  assert.deepEqual(v, [
    { id: 'abcdefghijk', title: 'A title', durationSec: 123 },
    { id: 'lmnopqrstuv', title: 'No length', durationSec: null },
  ])
})
