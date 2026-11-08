import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExcerpt, excerptLink } from '../lib/fidelityExcerpt'

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
