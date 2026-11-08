import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findSpan, markSpan, youtubeVideoId, videoStartSeconds, videoLinkBefore, formatTimestamp,
  contextFromTurns, contextFromChunk, buildFlagContext, planReviewAction,
} from '../lib/flagReview'
import type { TranscriptTurn } from '../lib/transcriptView'

test('findSpan ignores case, line wrapping and curly quotes', () => {
  const text = 'He said it’s  not\nfrequently reported in women.'
  const s = findSpan(text, "it's not frequently reported")
  assert.ok(s)
  assert.equal(text.slice(s.start, s.end), 'it’s  not\nfrequently reported')
  assert.equal(findSpan(text, 'something else'), null)
  assert.equal(findSpan(text, '  '), null)
})

test('markSpan splits around the first match and tolerates no match', () => {
  assert.deepEqual(markSpan('a big cat sat', 'big cat'), [
    { text: 'a ', hit: false }, { text: 'big cat', hit: true }, { text: ' sat', hit: false },
  ])
  assert.deepEqual(markSpan('abc', 'zzz'), [{ text: 'abc', hit: false }])
})

test('youtubeVideoId reads every URL shape and rejects non-ids', () => {
  const id = 'dQw4w9WgXcQ'
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${id}`), id)
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?feature=x&v=${id}&t=5s`), id)
  assert.equal(youtubeVideoId(`https://youtu.be/${id}?t=3`), id)
  assert.equal(youtubeVideoId(`https://www.youtube.com/embed/${id}`), id)
  assert.equal(youtubeVideoId('https://example.com/watch?v=short'), null)
  assert.equal(youtubeVideoId(null), null)
})

test('the video link starts 30 seconds before the claim and never below zero', () => {
  assert.equal(videoStartSeconds(125_900), 95)
  assert.equal(videoStartSeconds(10_000), 0)
  const src = { youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
  assert.equal(videoLinkBefore(src, 125_900), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s')
  assert.equal(videoLinkBefore(src, 0), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s')
})

test('no link without a public video or a timestamp; a private feed URL never counts', () => {
  assert.equal(videoLinkBefore({ youtube_url: null, url: null }, 60_000), null)
  assert.equal(videoLinkBefore({ url: 'https://pods.supercast.com/feed/abc?v=dQw4w9WgXcQ' }, 60_000), null)
  assert.equal(videoLinkBefore({ youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, null), null)
  assert.equal(videoLinkBefore({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, 60_000), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')
})

test('formatTimestamp', () => {
  assert.equal(formatTimestamp(65_000), '1:05')
  assert.equal(formatTimestamp(3_725_000), '1:02:05')
})

const turns: TranscriptTurn[] = [
  { speaker: 'Host', start_ms: 0, text: 'Welcome to the show.' },
  { speaker: 'Guest', start_ms: 60_000, text: 'Gallstones are a not infrequently reported finding in women on hormones.' },
  { speaker: 'Host', start_ms: 120_000, text: 'Interesting, tell me more.' },
  { speaker: 'Guest', start_ms: 180_000, text: 'Sure, here is more.' },
]

test('context centres on the turn that holds the quote and marks it', () => {
  const c = contextFromTurns(turns, 65_000, 'not infrequently reported finding')
  assert.equal(c.kind, 'timed')
  assert.equal(c.quoteFound, true)
  assert.deepEqual(c.turns.map(t => t.role), ['before', 'claim', 'after'])
  assert.equal(c.turns[1].speaker, 'Guest')
  assert.ok(c.turns[1].parts.some(p => p.hit))
})

test('the quote is searched past the timestamp turn (chunk clock sits before the quote)', () => {
  const c = contextFromTurns(turns, 5_000, 'here is more')
  assert.equal(c.quoteFound, true)
  assert.equal(c.turns.find(t => t.role === 'claim')?.start_ms, 180_000)
})

test('no hit: the turn by time stands, nothing marked, quoteFound false', () => {
  const c = contextFromTurns(turns, 65_000, 'a phrase that is not there')
  assert.equal(c.quoteFound, false)
  assert.equal(c.turns.find(t => t.role === 'claim')?.start_ms, 60_000)
  assert.ok(c.turns.every(t => t.parts.every(p => !p.hit)))
})

test('no timestamp: a quote in exactly one turn is used, otherwise nothing', () => {
  assert.equal(contextFromTurns(turns, null, 'here is more').quoteFound, true)
  assert.equal(contextFromTurns(turns, null, 'more').kind, 'none')
  assert.equal(contextFromTurns([], 5, 'x').kind, 'none')
})

test('a very long turn is clipped around the quote', () => {
  const filler = 'word '.repeat(2000)
  const long: TranscriptTurn[] = [{ speaker: null, start_ms: 0, text: `${filler}THE QUOTED PART here ${filler}` }]
  const c = contextFromTurns(long, 0, 'the quoted part here')
  const t = c.turns[0]
  assert.equal(t.clippedStart && t.clippedEnd, true)
  assert.ok(t.parts.some(p => p.hit))
  assert.ok(t.parts.map(p => p.text).join('').length < 2400)
})

test('chunk fallback uses the stored offsets', () => {
  const content = 'before the thing. The key sentence is here. after the thing.'
  const start = content.indexOf('The key'), end = content.indexOf(' after')
  const c = contextFromChunk(content, null, start, end, 5000)
  assert.equal(c.kind, 'chunk')
  assert.equal(c.quoteFound, true)
  assert.equal(c.turns[0].parts.find(p => p.hit)?.text, 'The key sentence is here.')
  assert.equal(contextFromChunk('', 'x', null, null, null).kind, 'none')
})

const baseInput = () => ({
  flag: { id: 'f1', claim_id: 'c1', rule: 'extraction_fidelity', detail: 'ADDED_DETAIL: ...', evidence: { verdict: 'ADDED_DETAIL', offending: 'frequently performed', statement: 'X is frequently performed.' } },
  canonicalStatement: 'X is frequently performed in women.',
  member: { id: 'm1', statement: 'X is frequently performed.', start_ms: 125_900, direct_quote: 'not infrequently reported finding', quote_char_start: null, quote_char_end: null, speaker: 'Guest' },
  memberMatched: true,
  memberCount: 2,
  source: { id: 's1', title: 'Episode 1', date: '2025-01-01', episode_number: 1, youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', timed_transcript: [
    { text: 'Host: Welcome.', start_ms: 0, end_ms: 1000 },
    { text: 'Guest: It is a not infrequently reported finding.', start_ms: 125_000, end_ms: 130_000 },
  ] },
  chunk: null,
})

test('buildFlagContext assembles claim, judge reason, transcript and video link', () => {
  const c = buildFlagContext(baseInput())
  assert.equal(c.verdict, 'ADDED_DETAIL')
  assert.equal(c.canonical.find(p => p.hit)?.text, 'frequently performed')
  assert.ok(c.judgedStatement, 'the extracted statement differs from the claim, so it is shown')
  assert.equal(c.videoUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s')
  assert.equal(c.timestampLabel, '2:05')
  assert.equal(c.context.quoteFound, true)
})

test('buildFlagContext with no video gives the timestamp and episode links instead', () => {
  const input = baseInput()
  input.source = { ...input.source, youtube_url: null as unknown as string }
  const c = buildFlagContext(input)
  assert.equal(c.videoUrl, null)
  assert.equal(c.timestampLabel, '2:05')
  assert.equal(c.source?.title, 'Episode 1')
  assert.ok(c.links.length > 0)
})

test('planReviewAction maps the four choices through the claim gate', () => {
  const ctx = { currentStatus: 'flagged', rule: 'extraction_fidelity', currentStatement: 'Old wording.' }
  const approve = planReviewAction('approve', ctx)
  assert.deepEqual(approve.ok && [approve.resolution, approve.claimStatus, approve.closesFlag], ['false_positive', 'active', true])
  const reject = planReviewAction('reject', ctx)
  assert.deepEqual(reject.ok && [reject.resolution, reject.claimStatus, reject.closesFlag], ['approved', null, true])
  const edit = planReviewAction('edit', { ...ctx, statement: '  New   wording. ' })
  assert.ok(edit.ok)
  if (edit.ok) {
    assert.equal(edit.resolution, 'reworded')
    assert.equal(edit.claimStatus, 'active')
    assert.equal(edit.newStatement, 'New wording.')
  }
  const video = planReviewAction('needs_video_check', ctx)
  assert.deepEqual(video.ok && [video.resolution, video.claimStatus, video.closesFlag, video.markVideoCheck], [null, null, false, true])
})

test('planReviewAction rejects bad edits and unknown actions', () => {
  const ctx = { currentStatus: 'flagged', rule: 'extraction_fidelity', currentStatement: 'Old wording.' }
  assert.equal(planReviewAction('edit', ctx).ok, false)
  assert.equal(planReviewAction('edit', { ...ctx, statement: '   ' }).ok, false)
  assert.equal(planReviewAction('edit', { ...ctx, statement: 'Old  wording.' }).ok, false)
  assert.equal(planReviewAction('edit', { ...ctx, statement: 'x'.repeat(2001) }).ok, false)
  assert.equal(planReviewAction('burn', ctx).ok, false)
})

test('a claim the gate did not hide keeps its status whatever the choice', () => {
  const p = planReviewAction('approve', { currentStatus: 'active', rule: 'extraction_fidelity', currentStatement: 'x' })
  assert.ok(p.ok && p.claimStatus === null)
})
