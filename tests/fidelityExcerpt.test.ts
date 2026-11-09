import test from 'node:test'
import assert from 'node:assert/strict'
import { alignWords, buildExcerpt, excerptLink, sameEpisodeTitle, wordsOf } from '../lib/fidelityExcerpt'

const timed = [
  { text: 'Peter Attia: So what is NDMA?', start_ms: 1000, end_ms: 4000 },
  { text: 'Guest: It sticks to DNA all the time and that changes the structure.', start_ms: 5000, end_ms: 9000 },
  { text: 'Peter Attia: Right, okay.', start_ms: 10000, end_ms: 12000 },
]

test('speaker turns with timestamps, quote highlighted, chunk edges clipped', () => {
  const chunk = 'is NDMA? Guest: It sticks to DNA all the time and that changes the structure. Peter Attia: Right'
  const ex = buildExcerpt(chunk, timed, null, 'sticks to DNA all the time')
  assert.ok(ex)
  assert.equal(ex.mode, 'timed')
  assert.deepEqual(ex.turns.map(t => t.speaker), ['Peter Attia', 'Guest', 'Peter Attia'])
  assert.equal(ex.turns[0].clippedStart, true)
  assert.equal(ex.turns[2].clippedEnd, true)
  assert.equal(ex.turns[1].start_ms, 5000)
  assert.equal(ex.quoteFound, true)
  const hit = ex.turns[1].hit!
  assert.equal(ex.turns[1].text.slice(hit[0], hit[1]), 'sticks to DNA all the time')
})

test('quote not in the text: nothing marked', () => {
  const ex = buildExcerpt('Guest: It sticks to DNA all the time and that changes the structure.', timed, null, 'something never said')
  assert.ok(ex)
  assert.equal(ex.quoteFound, false)
})

test('chunk not in the stored transcript: split on its own labels, no timestamps', () => {
  const ex = buildExcerpt('Host: first thing said here. Guest: and then an answer follows.', timed, null, null)
  assert.ok(ex)
  assert.equal(ex.mode, 'labelled')
  assert.deepEqual(ex.turns.map(t => [t.speaker, t.start_ms]), [['Host', null], ['Guest', null]])
})

test('an untimed article with a couple of "Name:" patterns stays plain text', () => {
  const article = 'By: Someone wrote this. Disclaimer: this blog is general information only.'
  assert.equal(buildExcerpt(article, null, article, null), null)
})

test('no speaker labels anywhere: plain text fallback (null)', () => {
  assert.equal(buildExcerpt('just some words with no labels at all', null, 'just some words with no labels at all', null), null)
})

test('link: video 30 s before, else video, else episode page, else none', () => {
  const yt = { youtube_url: 'https://www.youtube.com/watch?v=abcdefghijk' }
  assert.deepEqual(excerptLink(yt, 100_000), { href: 'https://www.youtube.com/watch?v=abcdefghijk&t=70s', kind: 'video-at-time' })
  assert.deepEqual(excerptLink(yt, null), { href: 'https://www.youtube.com/watch?v=abcdefghijk', kind: 'video' })
  assert.deepEqual(excerptLink({ article_url: 'https://example.com/ep' }, 5000), { href: 'https://example.com/ep', kind: 'episode' })
  assert.equal(excerptLink({ url: 'https://pod.supercast.com/feed?key=x' }, 5000), null)
  assert.equal(excerptLink(null, 5000), null)
})

// An episode long enough for word matching to have something to vote on.
const longEpisode = [
  { text: 'Host: Welcome to the show today we are talking about the risk factors for dementia in older adults.', start_ms: 1000, end_ms: 9000 },
  { text: 'Guest: If you look at the risk factors for Alzheimer disease every single one is also a risk factor for stroke and vascular disease.', start_ms: 20000, end_ms: 30000 },
  { text: 'Host: And what about the pathology findings when you look at the brain after death in men and women.', start_ms: 40000, end_ms: 50000 },
]

test('older caption-style chunk (no labels, different punctuation) still finds its place and the quote time', () => {
  const chunk =
    'welcome to the show today we are talking about the risk factors for dementia in older adults ' +
    'if you look at the risk factors for alzheimers disease every single one is also a risk factor for stroke and vascular disease ' +
    'and what about the pathology findings when you look at the brain after death'
  const ex = buildExcerpt(chunk, longEpisode, null, "if you look at the risk factors for Alzheimer's disease every single one is also a risk factor for stroke")
  assert.ok(ex)
  assert.equal(ex.fuzzy, true)
  assert.equal(ex.mode, 'timed')
  assert.equal(ex.quoteFound, true)
  assert.equal(ex.startFrom, 'quote')
  assert.equal(ex.startMs, 20000)
  assert.ok(ex.turns.some(t => t.hit))
})

test('passage found but quote absent: time falls back to the passage start', () => {
  const chunk = 'and what about the pathology findings when you look at the brain after death in men and women'
  const ex = buildExcerpt(chunk, longEpisode, null, null)
  assert.ok(ex)
  assert.equal(ex.startFrom, 'passage')
  assert.equal(ex.startMs, 40000)
})

test('alignWords: unrelated text does not align', () => {
  const hay = wordsOf('one two three four five six seven eight nine ten eleven twelve')
  assert.equal(alignWords(hay, wordsOf('completely different words about something else entirely here today')), null)
})

test('episode titles match across dash style, case and a trailing bar or cut-off', () => {
  assert.equal(sameEpisodeTitle('#374 – The evolutionary biology | ', '#374 - The evolutionary biology | Carole Hooven, Ph.D.'), true)
  assert.equal(sameEpisodeTitle('#351 ‒ Male fertility', '#351 - male fertility'), true)
  assert.equal(sameEpisodeTitle('#374 – The evo', '#375 - Other'), false)
  assert.equal(sameEpisodeTitle('', 'anything'), false)
})
