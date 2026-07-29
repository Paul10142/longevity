/**
 * Unit tests for the YouTube URL helpers.
 *
 * extractYouTubeVideoId is the front door of ingest — every episode is added by
 * its video id, and a mis-parse silently skips or mis-registers a source.
 * youtubeTimestampUrl builds the Evidence "jump to this moment" deep-link, so a
 * bug there sends a clinician to the wrong second (or a broken link).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractYouTubeVideoId, isValidYouTubeUrl, youtubeTimestampUrl } from '../lib/youtubeUtils'

const ID = 'dQw4w9WgXcQ' // canonical 11-char id

test('extractYouTubeVideoId: accepts every supported URL shape', () => {
  const urls = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=42s&list=abc`, // extra params
    `  https://youtu.be/${ID}  `,                            // surrounding whitespace
    ID,                                                       // bare id
  ]
  for (const u of urls) assert.equal(extractYouTubeVideoId(u), ID, `failed on: ${u}`)
})

test('extractYouTubeVideoId: rejects non-URLs and malformed input', () => {
  for (const bad of ['', '   ', 'not a url', 'https://vimeo.com/12345', 'abc', 'x'.repeat(11) + '!']) {
    assert.equal(extractYouTubeVideoId(bad), null, `should reject: ${bad}`)
  }
  // @ts-expect-error — guarding the non-string runtime path
  assert.equal(extractYouTubeVideoId(null), null)
})

test('isValidYouTubeUrl mirrors extractYouTubeVideoId', () => {
  assert.equal(isValidYouTubeUrl(`https://youtu.be/${ID}`), true)
  assert.equal(isValidYouTubeUrl('https://example.com'), false)
})

test('youtubeTimestampUrl: appends floored seconds with the right separator', () => {
  assert.equal(
    youtubeTimestampUrl(`https://www.youtube.com/watch?v=${ID}`, 65_000),
    `https://www.youtube.com/watch?v=${ID}&t=65`,               // already has ?query → &
  )
  assert.equal(
    youtubeTimestampUrl(`https://youtu.be/${ID}`, 65_999),
    `https://youtu.be/${ID}?t=65`,                              // no query → ? ; ms floored to 65s
  )
})

test('youtubeTimestampUrl: returns null when it cannot build a real deep-link', () => {
  assert.equal(youtubeTimestampUrl(null, 1000), null)
  assert.equal(youtubeTimestampUrl(`https://youtu.be/${ID}`, null), null)
  assert.equal(youtubeTimestampUrl(`https://youtu.be/${ID}`, NaN), null)
  assert.equal(youtubeTimestampUrl('https://example.com/not-youtube', 1000), null)
})
