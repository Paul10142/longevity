/**
 * Unit tests for components/ask/askLib.ts: the pure half of the Ask the
 * Library page. The one that matters most is the marker-to-chip rewrite;
 * the rest keep the stream reader and the reducer honest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  askReducer,
  citeNumber,
  createLineParser,
  extractMarkers,
  hideTrailingPartialMarker,
  initialAskState,
  markersToLinks,
  normalizeStored,
  prepareBody,
  rankEpisodes,
  relatedFromSearch,
} from '../components/ask/askLib'
import type { AskEvent, ClaimMember, MembersState } from '../components/ask/types'

// ── markers → chips ─────────────────────────────────────────────────────────

test('a single marker becomes a cite link', () => {
  assert.equal(markersToLinks('Zone 2 raises VO2 max [3].'), 'Zone 2 raises VO2 max [3](#cite-3).')
})

test('comma lists and back-to-back markers become one chip each', () => {
  assert.equal(markersToLinks('Both agree [3, 5].'), 'Both agree [3](#cite-3)[5](#cite-5).')
  assert.equal(markersToLinks('Both agree [3][5].'), 'Both agree [3](#cite-3)[5](#cite-5).')
})

test('real markdown links and non-numeric brackets are left alone', () => {
  assert.equal(markersToLinks('See [3](https://example.com) and [note].'), 'See [3](https://example.com) and [note].')
  assert.equal(markersToLinks('No markers here.'), 'No markers here.')
})

test('extractMarkers lists every number in order, repeats kept', () => {
  assert.deepEqual(extractMarkers('A [2]. B [1, 3]. C [2].'), [2, 1, 3, 2])
  assert.deepEqual(extractMarkers('nothing'), [])
})

test('citeNumber only accepts cite anchors', () => {
  assert.equal(citeNumber('#cite-4'), 4)
  assert.equal(citeNumber('#cite-0'), null)
  assert.equal(citeNumber('#cite-x'), null)
  assert.equal(citeNumber('https://example.com'), null)
  assert.equal(citeNumber(undefined), null)
})

test('a half-arrived marker is hidden while streaming, a finished one is kept', () => {
  assert.equal(hideTrailingPartialMarker('Zone 2 helps ['), 'Zone 2 helps ')
  assert.equal(hideTrailingPartialMarker('Zone 2 helps [1'), 'Zone 2 helps ')
  assert.equal(hideTrailingPartialMarker('Zone 2 helps [1, '), 'Zone 2 helps ')
  assert.equal(hideTrailingPartialMarker('Zone 2 helps [1]'), 'Zone 2 helps [1]')
  assert.equal(prepareBody('Zone 2 helps [1', true), 'Zone 2 helps ')
  assert.equal(prepareBody('Zone 2 helps [1]', true), 'Zone 2 helps [1](#cite-1)')
  assert.equal(prepareBody('Zone 2 helps [1', false), 'Zone 2 helps [1')
})

// ── NDJSON ──────────────────────────────────────────────────────────────────

test('the line parser handles split chunks, blank lines and junk', () => {
  const seen: AskEvent[] = []
  const p = createLineParser((e) => seen.push(e))
  p.push('{"type":"retrieval","count":12,"thin":false}\n{"type":"del')
  p.push('ta","text":"Hello"}\n\nnot json\n{"type":"delta","text":" world"}')
  assert.equal(seen.length, 2)
  p.flush()
  assert.deepEqual(
    seen.map((e) => e.type),
    ['retrieval', 'delta', 'delta']
  )
  assert.equal((seen[2] as { text: string }).text, ' world')
})

// ── reducer ─────────────────────────────────────────────────────────────────

test('a live answer streams then settles with its citations', () => {
  const events: AskEvent[] = [
    { type: 'retrieval', count: 22, thin: true },
    { type: 'delta', text: 'Zone 2 ' },
    { type: 'delta', text: 'works [1].' },
    { type: 'done', answer_id: 'a1', cited: [{ n: 1, claim_id: 'c1' }], follow_ups: ['Why?'], latency_ms: 4100 },
  ]
  let s = askReducer(initialAskState, { type: 'start', question: 'q?' })
  assert.equal(s.phase, 'retrieving')
  for (const e of events) s = askReducer(s, e)
  assert.equal(s.phase, 'done')
  assert.equal(s.body, 'Zone 2 works [1].')
  assert.equal(s.thin, true)
  assert.equal(s.answerId, 'a1')
  assert.deepEqual(s.followUps, ['Why?'])
})

test('a cached answer carries its date; not_covered keeps the nearest topics', () => {
  let s = askReducer(initialAskState, { type: 'start', question: 'q?' })
  s = askReducer(s, { type: 'retrieval', count: 9, thin: false, cached: true, answered_at: '2026-10-20T10:00:00Z' })
  s = askReducer(s, { type: 'delta', text: 'Body [1].' })
  s = askReducer(s, { type: 'done', answer_id: 'a2', cited: [], follow_ups: [], latency_ms: 80 })
  assert.equal(s.cached, true)
  assert.equal(s.answeredAt, '2026-10-20T10:00:00Z')

  let n = askReducer(initialAskState, { type: 'start', question: 'bitcoin?' })
  n = askReducer(n, { type: 'not_covered', nearest_topics: [{ name: 'Sleep', slug: 'sleep' }] })
  assert.equal(n.phase, 'not_covered')
  assert.deepEqual(n.nearestTopics, [{ name: 'Sleep', slug: 'sleep' }])
})

test('stored answers accept the table shape and the event shape', () => {
  const row = normalizeStored({
    id: 'a3', question: 'q', status: 'answered', body_markdown: 'B [1]',
    cited_claim_ids: ['c1', 'c2'], follow_ups: ['f'], created_at: '2026-10-25T00:00:00Z',
  })
  assert.deepEqual(row?.cited, [{ n: 1, claim_id: 'c1' }, { n: 2, claim_id: 'c2' }])
  assert.equal(row?.body, 'B [1]')

  const ev = normalizeStored({ answer: { id: 'a4', question: 'q', status: 'not_covered', cited: [{ n: 2, claim_id: 'c9' }], nearest_topics: [{ title: 'Sleep', slug: 'sleep' }] } })
  assert.equal(ev?.status, 'not_covered')
  assert.deepEqual(ev?.cited, [{ n: 2, claim_id: 'c9', statement: null }])
  assert.deepEqual(ev?.nearestTopics, [{ name: 'Sleep', slug: 'sleep' }])

  assert.equal(normalizeStored({ nope: true }), null)
})

// ── Go deeper / related pages ───────────────────────────────────────────────

const member = (sourceId: string, title: string, date?: string): ClaimMember => ({
  raw_insight_id: `${sourceId}-i`,
  source: { id: sourceId, title, date: date ?? null, links: [{ kind: 'video', label: 'YouTube', href: `https://www.youtube.com/watch?v=${sourceId}` }] },
})
const ok = (...members: ClaimMember[]): MembersState => ({ status: 'ok', members, statement: null })

test('episodes rank by how many different citations they support', () => {
  const eps = rankEpisodes(
    [{ n: 1, claim_id: 'c1' }, { n: 2, claim_id: 'c2' }, { n: 3, claim_id: 'c3' }],
    {
      c1: ok(member('s1', 'Episode One', '2024-03-04'), member('s2', 'Episode Two', '2025-01-01')),
      c2: ok(member('s2', 'Episode Two', '2025-01-01'), member('s2', 'Episode Two', '2025-01-01')),
      c3: { status: 'loading' },
    }
  )
  assert.deepEqual(eps.map((e) => [e.id, e.citations]), [['s2', 2], ['s1', 1]])
  assert.match(eps[0].href ?? '', /^https:\/\/www\.youtube\.com/)
})

test('related pages are the most frequent topics, ties by first appearance', () => {
  const a = { name: 'Exercise', slug: 'exercise' }
  const b = { name: 'Sleep', slug: 'sleep' }
  const c = { name: 'Nutrition', slug: 'nutrition' }
  assert.deepEqual(
    relatedFromSearch([{ topic: b }, { topic: a }, { topic: null }, { topic: a }, { topic: c }], 2),
    [a, b]
  )
})
