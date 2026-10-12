/**
 * Unit tests for lib/sourceLinks.ts.
 *
 * The property that matters most: a Supercast feed URL (the private member
 * feed) never comes out of `episodeLinks`, whatever column it is in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  episodeLinks,
  episodeSearchUrl,
  isPrivateFeedUrl,
  isPublicUrl,
  isYouTubeUrl,
  primaryEpisodeLink,
  publicArticleUrl,
  publicVideoUrl,
} from '../lib/sourceLinks'

const SUPERCAST = 'https://peterattia.supercast.tech/episodes/abc123?key=MEMBERSHIPKEY'
const ARTICLE = 'https://peterattiamd.com/ama60/'
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

const noSupercast = (links: { href: string }[]) => {
  for (const l of links) assert.doesNotMatch(l.href, /supercast|MEMBERSHIPKEY/i)
}

test('isPrivateFeedUrl: flags Supercast URLs and nothing else', () => {
  assert.equal(isPrivateFeedUrl(SUPERCAST), true)
  assert.equal(isPrivateFeedUrl('https://PeterAttia.SUPERCAST.tech/x'), true)
  assert.equal(isPrivateFeedUrl(ARTICLE), false)
  assert.equal(isPrivateFeedUrl(VIDEO), false)
  assert.equal(isPrivateFeedUrl(null), false)
  assert.equal(isPrivateFeedUrl(undefined), false)
})

test('isPublicUrl: http(s) only, never private', () => {
  assert.equal(isPublicUrl(ARTICLE), true)
  assert.equal(isPublicUrl(SUPERCAST), false)
  assert.equal(isPublicUrl('peterattiamd.com/ama60'), false)
  assert.equal(isPublicUrl(''), false)
  assert.equal(isPublicUrl(null), false)
})

test('isYouTubeUrl: recognises youtube.com and youtu.be, rejects the rest', () => {
  assert.equal(isYouTubeUrl(VIDEO), true)
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true)
  assert.equal(isYouTubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), true)
  assert.equal(isYouTubeUrl(ARTICLE), false)
  assert.equal(isYouTubeUrl('https://notyoutube.com/watch?v=x'), false)
  assert.equal(isYouTubeUrl(null), false)
})

test('both links, in order, when the episode page and the video both exist', () => {
  const links = episodeLinks({ url: SUPERCAST, article_url: ARTICLE, youtube_url: VIDEO, episode_number: 405, title: '#405 - x' })
  assert.deepEqual(links, [
    { kind: 'article', label: 'Episode page', href: ARTICLE },
    { kind: 'video', label: 'YouTube', href: VIDEO },
  ])
  noSupercast(links)
})

test('episode page alone, video alone', () => {
  assert.deepEqual(episodeLinks({ url: SUPERCAST, article_url: ARTICLE }), [
    { kind: 'article', label: 'Episode page', href: ARTICLE },
  ])
  assert.deepEqual(episodeLinks({ url: SUPERCAST, youtube_url: VIDEO }), [
    { kind: 'video', label: 'YouTube', href: VIDEO },
  ])
})

test('a public YouTube `url` stands in for a missing youtube_url', () => {
  // The pre-feed rows ingested straight from YouTube keep the video in `url`.
  assert.equal(publicVideoUrl({ url: VIDEO }), VIDEO)
  assert.deepEqual(episodeLinks({ url: VIDEO, title: 'Old row' }), [
    { kind: 'video', label: 'YouTube', href: VIDEO },
  ])
})

test('a Supercast `url` is never used as the video, the page, or anything else', () => {
  assert.equal(publicVideoUrl({ url: SUPERCAST }), null)
  assert.equal(publicArticleUrl({ url: SUPERCAST }), null)
  // Defensive: even in the wrong column it stays hidden.
  assert.equal(publicVideoUrl({ youtube_url: SUPERCAST }), null)
  assert.equal(publicArticleUrl({ article_url: SUPERCAST }), null)
  const links = episodeLinks({ url: SUPERCAST, youtube_url: SUPERCAST, article_url: SUPERCAST, episode_number: 12 })
  assert.equal(links.length, 1)
  assert.equal(links[0].kind, 'search')
  noSupercast(links)
})

test('falls back to a site search by episode number (#-prefixed, URL-encoded)', () => {
  const links = episodeLinks({ url: SUPERCAST, episode_number: 405, title: '#405 - Something' })
  assert.deepEqual(links, [
    { kind: 'search', label: 'Find on peterattiamd.com', href: 'https://peterattiamd.com/?s=%23405' },
  ])
  noSupercast(links)
})

test('search by title when there is no episode number', () => {
  assert.equal(
    episodeSearchUrl({ title: 'AMA: sleep & recovery' }),
    `https://peterattiamd.com/?s=${encodeURIComponent('AMA: sleep & recovery')}`
  )
  const links = episodeLinks({ url: SUPERCAST, title: 'AMA: sleep & recovery' })
  assert.equal(links.length, 1)
  assert.equal(links[0].label, 'Find on peterattiamd.com')
  assert.equal(links[0].href, 'https://peterattiamd.com/?s=AMA%3A%20sleep%20%26%20recovery')
})

test('episode numbers arriving as strings still search by number', () => {
  assert.equal(episodeSearchUrl({ episode_number: '77', title: 'ignored' }), 'https://peterattiamd.com/?s=%2377')
})

test('nothing to link and nothing to search for yields no links', () => {
  assert.deepEqual(episodeLinks({}), [])
  assert.deepEqual(episodeLinks({ url: SUPERCAST, title: '   ' }), [])
  assert.equal(episodeSearchUrl({}), null)
})

test('primaryEpisodeLink is the first link or null', () => {
  assert.equal(primaryEpisodeLink({ article_url: ARTICLE, youtube_url: VIDEO })?.href, ARTICLE)
  assert.equal(primaryEpisodeLink({ youtube_url: VIDEO })?.href, VIDEO)
  assert.equal(primaryEpisodeLink({}), null)
})

test('surrounding whitespace in stored URLs is trimmed', () => {
  assert.equal(publicArticleUrl({ article_url: `  ${ARTICLE}  ` }), ARTICLE)
  assert.equal(publicVideoUrl({ youtube_url: `${VIDEO} ` }), VIDEO)
})
