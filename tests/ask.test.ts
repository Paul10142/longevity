/**
 * Unit tests for "Ask the Library" (lib/ask/*). No model calls, no database: fake
 * candidates, a fake Supabase chain for the cache.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePhrasings, MAX_PHRASINGS } from '../lib/ask/expand'
import {
  collapseTwins,
  evidenceBonus,
  evidenceTier,
  rankHits,
  rankScore,
  recencyBonus,
  unionHits,
  type RawHit,
  type TwinPair,
} from '../lib/ask/retrieve'
import {
  BriefStream,
  newMarkerState,
  parseBrief,
  rewriteMarkers,
  splitSentences,
} from '../lib/ask/parse'
import { buildUserPrompt, candidateLine, candidateMap, COMPOSER_SYSTEM } from '../lib/ask/compose'
import { findCached, isStale, normalizeQuestion, type Db } from '../lib/ask/store'
import { buildAuditItems, scoreFromUngrounded } from '../lib/ask/audit'
import { chunk, pickRepresentative, rankEpisodes, type ClaimEvidence } from '../lib/ask/provenance'
import { checkQuestion } from '../lib/ask/ask'
import { costUsd } from '../lib/ask/cost'
import type { Candidate } from '../lib/ask/types'

const NOW = new Date('2026-10-25T00:00:00Z')

function hit(id: string, similarity: number, over: Partial<RawHit> = {}): RawHit {
  return {
    id,
    canonical_statement: `claim ${id}`,
    context_note: null,
    best_evidence_type: null,
    max_importance: null,
    source_count: 1,
    insight_type: null,
    latest_source_date: null,
    similarity,
    ...over,
  }
}

function cand(id: string, similarity: number, over: Partial<Candidate> = {}): Candidate {
  return {
    id,
    statement: `claim ${id}`,
    context: null,
    evidenceType: null,
    importance: null,
    sourceCount: 1,
    insightType: null,
    latestDate: null,
    similarity,
    score: similarity,
    ...over,
  }
}

// --- expand -----------------------------------------------------------------

test('normalizePhrasings puts the question first, dedupes, trims and caps', () => {
  const out = normalizePhrasings('VO2 max training', [
    '  vo2 max training ', 'zone 2 versus intervals', 'zone 2 versus intervals', 'a', 'x'.repeat(400), 'maximal aerobic capacity', 'extra one',
  ])
  assert.equal(out[0], 'VO2 max training')
  assert.deepEqual(out.slice(1), ['zone 2 versus intervals', 'maximal aerobic capacity', 'extra one'].slice(0, MAX_PHRASINGS - 1))
  assert.ok(out.length <= MAX_PHRASINGS)
})

test('normalizePhrasings falls back to the bare question on junk', () => {
  assert.deepEqual(normalizePhrasings('why sleep?', null), ['why sleep?'])
  assert.deepEqual(normalizePhrasings('why sleep?', 'nope'), ['why sleep?'])
})

// --- retrieve: rank, union, collapse, floor ---------------------------------

test('evidence and recency bonuses', () => {
  assert.equal(evidenceBonus('RCT'), 0.04)
  assert.equal(evidenceBonus('MetaAnalysis'), 0.04)
  assert.equal(evidenceBonus('Cohort'), 0.02)
  assert.equal(evidenceBonus('ExpertOpinion'), 0)
  assert.equal(recencyBonus(null, NOW), 0)
  assert.ok(Math.abs(recencyBonus('2026-10-25', NOW) - 0.03) < 1e-6)
  assert.equal(recencyBonus('2015-01-01', NOW), 0)
  assert.equal(recencyBonus('not a date', NOW), 0)
})

test('rankScore adds source count (capped at 5), evidence and recency to similarity', () => {
  const base = hit('a', 0.7, { source_count: 9, best_evidence_type: 'RCT', latest_source_date: '2026-10-25' })
  assert.ok(Math.abs(rankScore(base, NOW) - (0.7 + 0.1 + 0.04 + 0.03)) < 1e-6)
})

test('unionHits keeps each claim once with its best similarity', () => {
  const merged = unionHits([[hit('a', 0.6), hit('b', 0.5)], [hit('a', 0.8), hit('c', 0.4)]])
  assert.equal(merged.length, 3)
  assert.equal(merged.find(h => h.id === 'a')!.similarity, 0.8)
})

test('rankHits sorts by score, ties by id', () => {
  const ranked = rankHits([hit('b', 0.6), hit('a', 0.6), hit('c', 0.55, { best_evidence_type: 'MetaAnalysis', source_count: 5 })], NOW)
  assert.deepEqual(ranked.map(c => c.id), ['c', 'a', 'b'])
})

test('collapseTwins drops the lower-ranked twin and records what it collapsed into', () => {
  const ranked = [cand('a', 0.9), cand('b', 0.89), cand('c', 0.7)]
  const pairs: TwinPair[] = [{ claim_id: 'a', twin_id: 'b', similarity: 0.97 }]
  const { kept, collapsed } = collapseTwins(ranked, pairs)
  assert.deepEqual(kept.map(c => c.id), ['a', 'c'])
  assert.deepEqual(collapsed, [{ id: 'b', into: 'a', similarity: 0.97 }])
})

test('collapseTwins: a twin of a dropped claim is kept (A~B~C chain)', () => {
  const ranked = [cand('a', 0.9), cand('b', 0.88), cand('c', 0.86)]
  const pairs: TwinPair[] = [
    { claim_id: 'a', twin_id: 'b', similarity: 0.96 },
    { claim_id: 'b', twin_id: 'c', similarity: 0.96 },
  ]
  const { kept } = collapseTwins(ranked, pairs)
  assert.deepEqual(kept.map(c => c.id), ['a', 'c'])
})

test('collapseTwins caps the kept set', () => {
  const ranked = Array.from({ length: 10 }, (_, i) => cand(`c${i}`, 0.9 - i * 0.01))
  const { kept } = collapseTwins(ranked, [], 4)
  assert.equal(kept.length, 4)
  assert.equal(kept[0].id, 'c0')
})

test('evidenceTier: <5 strong is none, 5-15 thin, more ok (design 6.3)', () => {
  const at = (n: number, sim = 0.6) => Array.from({ length: n }, () => ({ similarity: sim }))
  assert.equal(evidenceTier(at(4)), 'none')
  assert.equal(evidenceTier(at(5)), 'thin')
  assert.equal(evidenceTier(at(15)), 'thin')
  assert.equal(evidenceTier(at(16)), 'ok')
  // Weak hits do not count toward the floor, however many there are.
  assert.equal(evidenceTier(at(100, 0.5)), 'none')
  assert.equal(evidenceTier([...at(4, 0.6), ...at(100, 0.5)]), 'none')
})

// --- parse: markers ---------------------------------------------------------

const resolveUpTo = (max: number) => (n: number) => n >= 1 && n <= max

test('rewriteMarkers renumbers by first appearance and splits multi-markers', () => {
  const st = newMarkerState()
  const out = rewriteMarkers('Zone 2 helps [47]. VO2 max matters more [3, 47].', resolveUpTo(150), st)
  assert.equal(out, 'Zone 2 helps [1]. VO2 max matters more [2][1].')
  assert.deepEqual(st.order, [47, 3])
})

test('rewriteMarkers drops unresolvable markers (and their leading space) and counts them', () => {
  const st = newMarkerState()
  const out = rewriteMarkers('Fact one [2] and fact two [999].', resolveUpTo(10), st)
  assert.equal(out, 'Fact one [1] and fact two.')
  assert.equal(st.dangling, 1)
})

test('BriefStream output equals the finished body, whatever the chunking', () => {
  const raw =
    'Bottom line first [12].\n\n### Key Points\n\nZone 2 raises mitochondrial density [5, 12]. Intervals raise VO2 max [7].\n\nFOLLOW_UPS:\n- What dose?\n- Who benefits?\n- Any risks?'
  const byNumber = new Map<number, string>([[5, 'c5'], [7, 'c7'], [12, 'c12']])
  const resolve = (n: number) => byNumber.has(n)
  const expected = parseBrief(raw, byNumber).body

  for (const size of [1, 2, 3, 7, 13, 1000]) {
    let out = ''
    const stream = new BriefStream(resolve, t => (out += t))
    for (let i = 0; i < raw.length; i += size) stream.push(raw.slice(i, i + size))
    stream.finish()
    assert.equal(out, expected, `chunk size ${size}`)
    assert.equal(stream.received, raw)
    assert.ok(!out.includes('FOLLOW_UPS'), 'the follow-ups tail is never streamed')
  }
})

test('BriefStream never emits half a marker', () => {
  const pieces: string[] = []
  const stream = new BriefStream(n => n === 12, t => pieces.push(t))
  stream.push('Claim stated [1')
  assert.deepEqual(pieces.join(''), 'Claim stated')
  stream.push('2].')
  stream.finish()
  assert.equal(pieces.join(''), 'Claim stated [1].')
})

// --- parse: sentences -------------------------------------------------------

test('splitSentences keeps markers with their sentence and ignores decimals and abbreviations', () => {
  assert.deepEqual(splitSentences('Protein at 1.6 g/kg is typical [4]. Higher doses are debated, e.g. in older adults [5].'), [
    'Protein at 1.6 g/kg is typical [4].',
    'Higher doses are debated, e.g. in older adults [5].',
  ])
})

test('parseBrief types sentences: sourced, synthesis, connective', () => {
  const map = new Map<number, string>([[1, 'c1'], [2, 'c2'], [3, 'c3']])
  const raw = [
    'Interval work improves VO2 max [1].',
    '',
    '### Key Points',
    '',
    'Two points follow.',
    '',
    '- Zone 2 builds the aerobic base [2].',
    '- Together these suggest both modes matter [1, 2].',
    '',
    'FOLLOW_UPS:',
    '- How many sessions a week?',
    '- Which populations benefit most?',
    '- What are the risks?',
  ].join('\n')
  const p = parseBrief(raw, map)
  assert.deepEqual(p.sentences, [
    { kind: 'sourced', text: 'Interval work improves VO2 max.', claim_ids: ['c1'] },
    { kind: 'connective', text: 'Two points follow.' },
    { kind: 'sourced', text: 'Zone 2 builds the aerobic base.', claim_ids: ['c2'] },
    { kind: 'synthesis', text: 'Together these suggest both modes matter.', claim_ids: ['c1', 'c2'] },
  ])
  assert.deepEqual(p.followUps, ['How many sessions a week?', 'Which populations benefit most?', 'What are the risks?'])
  assert.deepEqual(p.cited, [{ n: 1, claim_id: 'c1' }, { n: 2, claim_id: 'c2' }])
  assert.ok(!p.body.includes('FOLLOW_UPS'))
  assert.ok(!p.body.includes('Which populations'))
})

test('parseBrief: cited numbers follow first appearance, not the candidate numbers', () => {
  const map = new Map<number, string>([[47, 'c47'], [3, 'c3']])
  const p = parseBrief('Late-ranked claim first [47]. Then an early one [3].', map)
  assert.equal(p.body, 'Late-ranked claim first [1]. Then an early one [2].')
  assert.deepEqual(p.cited.map(c => c.claim_id), ['c47', 'c3'])
})

test('parseBrief strips dangling markers, counts them, and flags sentences left unsupported', () => {
  const map = new Map<number, string>([[1, 'c1']])
  const p = parseBrief('Real fact [1]. Invented fact [88]. Mixed [1, 77].', map)
  assert.equal(p.danglingMarkers, 2)
  assert.equal(p.unsupportedSentences, 1)
  assert.equal(p.body, 'Real fact [1]. Invented fact. Mixed [1].')
  assert.deepEqual(p.sentences[1], { kind: 'connective', text: 'Invented fact.' })
  assert.deepEqual(p.sentences[2], { kind: 'sourced', text: 'Mixed.', claim_ids: ['c1'] })
})

test('parseBrief with no follow-ups tag', () => {
  const p = parseBrief('Just a line [1].', new Map([[1, 'c1']]))
  assert.deepEqual(p.followUps, [])
})

// --- compose ----------------------------------------------------------------

test('candidateLine shows evidence type, source count, month and context', () => {
  const line = candidateLine(cand('a', 0.8, { evidenceType: 'RCT', sourceCount: 3, latestDate: '2026-03-14', context: 'in adults over 65' }), 12)
  assert.equal(line, '[12] (RCT, 3 sources, 2026-03) claim a — in adults over 65')
  assert.equal(candidateLine(cand('b', 0.8, { sourceCount: 1 }), 1), '[1] (unlabelled, 1 source) claim b')
})

test('buildUserPrompt numbers candidates from 1 and notes known conflicts and thin evidence', () => {
  const cands = [cand('a', 0.9), cand('b', 0.8), cand('c', 0.7)]
  const prompt = buildUserPrompt({ question: 'How much protein?', candidates: cands, contradictions: [['a', 'c'], ['a', 'zzz']], thin: true })
  assert.match(prompt, /^QUESTION: How much protein\?/)
  assert.match(prompt, /\[1\] \(unlabelled, 1 source\) claim a/)
  assert.match(prompt, /\[3\] \(unlabelled, 1 source\) claim c/)
  assert.match(prompt, /\[1\] and \[3\] are linked as conflicting/)
  assert.doesNotMatch(prompt, /zzz/)
  assert.match(prompt, /Few claims bear on this question/)
  assert.deepEqual([...candidateMap(cands)], [[1, 'a'], [2, 'b'], [3, 'c']])
})

test('the composer prompt states the trust rules', () => {
  assert.match(COMPOSER_SYSTEM, /only source/i)
  assert.match(COMPOSER_SYSTEM, /Where Experts Differ/)
  assert.match(COMPOSER_SYSTEM, /FOLLOW_UPS:/)
  assert.match(COMPOSER_SYSTEM, /300 to 500 words/)
})

// --- store: cache -----------------------------------------------------------

test('normalizeQuestion lowercases, trims and collapses whitespace', () => {
  assert.equal(normalizeQuestion('  How MUCH   protein\n after  training? '), 'how much protein after training?')
})

test('isStale: only when the corpus grew by more than 10%', () => {
  assert.equal(isStale(1000, 1100), false)
  assert.equal(isStale(1000, 1101), true)
  assert.equal(isStale(null, 5000), false)
})

/** A chainable fake of the PostgREST calls findCached makes. */
function fakeDb(opts: { exact?: unknown[]; near?: { id: string }[]; byId?: Record<string, unknown> }) {
  const calls: string[] = []
  const db = {
    from: () => {
      let id: string | null = null
      const chain: Record<string, unknown> = {
        select: () => chain,
        in: () => { calls.push('exact'); return chain },
        order: () => chain,
        limit: () => Promise.resolve({ data: opts.exact ?? [], error: null }),
        eq: (col: string, val: string) => { if (col === 'id') id = val; return chain },
        maybeSingle: async () => ({ data: id ? opts.byId?.[id] ?? null : null, error: null }),
      }
      return chain
    },
    rpc: async () => { calls.push('near'); return { data: opts.near ?? [], error: null } },
  }
  return { db: db as unknown as Db, calls }
}

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'ans1', question: 'q', question_norm: 'q', status: 'answered', candidates: [], cited_claim_ids: ['c1'],
  body_markdown: 'Body [1].', sentences: [], follow_ups: [], related_topics: [], thin: false, dangling_markers: 0,
  model: null, effort: null, latency_ms: 1, first_token_ms: 1, input_tokens: 1, output_tokens: 1, stage_stats: null,
  groundedness_score: null, corpus_claims: 1000, asked_by: 'admin', error: null, created_at: '2026-10-20T00:00:00Z',
  ...over,
})

test('findCached: an exact normalised question wins without touching the vector search', async () => {
  const { db, calls } = fakeDb({ exact: [stored()] })
  const hit = await findCached('q', [0.1], 1000, db)
  assert.equal(hit?.answer.id, 'ans1')
  assert.equal(hit?.info.match, 'exact')
  assert.equal(hit?.info.stale, false)
  assert.deepEqual(calls, ['exact'])
})

test('findCached: falls back to the nearest question at >= 0.95 and labels it', async () => {
  const { db, calls } = fakeDb({ exact: [], near: [{ id: 'ans2' }], byId: { ans2: stored({ id: 'ans2' }) } })
  const hit = await findCached('q', [0.1], 1200, db)
  assert.equal(hit?.answer.id, 'ans2')
  assert.equal(hit?.info.match, 'near')
  assert.equal(hit?.info.stale, true)
  assert.deepEqual(calls, ['exact', 'near'])
})

test('findCached: a miss, and a database error, both return null', async () => {
  assert.equal(await findCached('q', [0.1], 1000, fakeDb({}).db), null)
  assert.equal(await findCached('q', null, 1000, fakeDb({}).db), null)
  const broken = { from: () => { throw new Error('down') }, rpc: async () => ({ data: null, error: null }) } as unknown as Db
  assert.equal(await findCached('q', [0.1], 1000, broken), null)
})

// --- audit ------------------------------------------------------------------

test('buildAuditItems lists support per sentence and marks uncited ones', () => {
  const items = buildAuditItems(
    [
      { kind: 'sourced', text: 'Zone 2 builds base.', claim_ids: ['c1', 'cX'] },
      { kind: 'connective', text: 'Two points follow.' },
    ],
    new Map([['c1', 'Zone 2 training raises mitochondrial density']])
  )
  assert.match(items, /\[0\] SENTENCE: Zone 2 builds base\.\nSUPPORTING CLAIMS: Zone 2 training raises mitochondrial density\n/)
  assert.match(items, /\[1\] SENTENCE: Two points follow\.\nSUPPORTING CLAIMS: \(none cited\)/)
})

test('scoreFromUngrounded: share of sentences flagged, junk ignored, never 1 on nothing audited', () => {
  assert.equal(scoreFromUngrounded([], 10), 1)
  assert.equal(scoreFromUngrounded([0, 3], 10), 0.8)
  assert.equal(scoreFromUngrounded([0, 0, 99, -1, 'x'], 10), 0.9)
  assert.equal(scoreFromUngrounded(undefined, 4), 1)
  assert.equal(scoreFromUngrounded([0], 0), null)
})

// --- provenance -------------------------------------------------------------

type Member = Parameters<typeof pickRepresentative>[0][number]
const member = (quote: string | null, startMs: number | null, confidence: string, date: string): Member => ({
  claim_id: 'c',
  raw_insights: {
    direct_quote: quote, speaker: null, start_ms: startMs, confidence,
    sources: { id: `s-${date}`, title: 't', type: 'podcast', url: null, youtube_url: null, article_url: null, episode_number: null, date },
  },
})

test('pickRepresentative prefers quote, then timestamp, then confidence, then newest', () => {
  const noQuote = member(null, 5, 'high', '2026-01-01')
  const quoteNoTime = member('q', null, 'high', '2026-01-01')
  const full = member('q', 5, 'low', '2025-01-01')
  const fullHigh = member('q', 5, 'high', '2024-01-01')
  const fullHighNewer = member('q', 5, 'high', '2026-02-02')
  assert.equal(pickRepresentative([noQuote, quoteNoTime, full]), full)
  assert.equal(pickRepresentative([full, fullHigh]), fullHigh)
  assert.equal(pickRepresentative([fullHigh, fullHighNewer]), fullHighNewer)
  assert.equal(pickRepresentative([]), null)
})

test('rankEpisodes orders episodes by citations and records the printed numbers', () => {
  const ep = (id: string, date: string) => ({ source_id: id, title: id, type: 'podcast', episode_number: null, date, links: [], video_url: null })
  const ev = (claim: string, e: ReturnType<typeof ep> | null) => [claim, { claim_id: claim, statement: claim, context: null, evidence_type: null, source_count: 1, quote: null, speaker: null, start_ms: null, episode: e } as ClaimEvidence] as const
  const evidence = new Map([ev('c1', ep('A', '2025-01-01')), ev('c2', ep('B', '2026-01-01')), ev('c3', ep('B', '2026-01-01')), ev('c4', null)])
  const ranked = rankEpisodes(['c1', 'c2', 'c3', 'c4'], evidence)
  assert.deepEqual(ranked.map(e => [e.source_id, e.cited_count, e.cited_numbers]), [['B', 2, [2, 3]], ['A', 1, [1]]])
})

test('chunk splits evenly', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 3), [])
})

// --- ask: input check, cost -------------------------------------------------

test('checkQuestion trims, collapses whitespace and bounds the length', () => {
  assert.deepEqual(checkQuestion('  How   much\nprotein? '), { ok: true, question: 'How much protein?' })
  assert.equal(checkQuestion('hi').ok, false)
  assert.equal(checkQuestion('x'.repeat(601)).ok, false)
  assert.equal(checkQuestion(42).ok, false)
  assert.equal(checkQuestion(undefined).ok, false)
})

test('costUsd uses list prices and ignores unknown models', () => {
  assert.ok(Math.abs(costUsd('claude-opus-5-5', 12_000, 1_500) - (0.048 + 0.03)) < 1e-9)
  assert.ok(Math.abs(costUsd('claude-haiku-5-5', 1_000_000, 1_000_000) - 0.6) < 1e-9)
  assert.equal(costUsd('mystery', 1000, 1000), 0)
})
