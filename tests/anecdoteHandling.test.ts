/**
 * Anecdote handling (Paul, 2026-11-08; plan docs/plans/extraction-reproducibility.md section 4b, option A).
 * Anecdotes are extracted and labelled `Anecdote`, stored with `corpus_excluded = true`, and never
 * become claims. These tests lock in each piece that can be checked without a database or a model.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeInsights, isCorpusExcluded, corpusExclusionFields } from '../lib/extraction'
import { pendingInsights } from '../lib/consolidation'
import { applyGate } from '../lib/extractionGate'
import { EXTRACTION_SYSTEM_PROMPT_V2 } from '../lib/extractionPromptV2'
import { EXTRACTION_SYSTEM_PROMPT_EXHAUSTIVE } from '../lib/extractionPromptExhaustive'
import { matchOneWay, summariseDirection, lexicalSim, type MatchInsight } from '../lib/reproducibility'

const CHUNK = 'Host: What do you take? Guest: I take magnesium at night and I sleep better for it.'

test('an Anecdote insight survives normalisation with its label', () => {
  const out = normalizeInsights([
    { statement: 'The guest reports taking magnesium at night.', insight_type: 'Anecdote', direct_quote: 'I take magnesium at night' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].insight_type, 'Anecdote')
})

test('only the Anecdote kind sets the corpus-exclusion flag', () => {
  assert.equal(isCorpusExcluded('Anecdote'), true)
  for (const k of ['Protocol', 'Explanation', 'Mechanism', 'Warning', 'Controversy', 'Other', null, undefined] as const) {
    assert.equal(isCorpusExcluded(k), false, String(k))
  }
  assert.deepEqual(corpusExclusionFields('Anecdote'), { corpus_excluded: true })
  // Every other row is written exactly as before (no new column in the insert).
  assert.deepEqual(corpusExclusionFields('Protocol'), {})
  assert.deepEqual(corpusExclusionFields(null), {})
})

test('the gate keeps a faithful anecdote and still rejects an unresolvable quote', () => {
  const kept = { statement: 'The guest reports taking magnesium at night.', direct_quote: 'I take magnesium at night', insight_type: 'Anecdote' as const }
  const bad = { statement: 'The guest reports taking zinc at night.', direct_quote: 'I take zinc every morning', insight_type: 'Anecdote' as const }
  const r = applyGate(CHUNK, [kept, bad] as never)
  assert.equal(r.kept.length, 1)
  assert.equal(r.kept[0].direct_quote, 'I take magnesium at night')
  assert.equal(r.rejected.length, 1)
  assert.ok(r.rejected[0].violations.some(v => v.rule === 'quote_not_in_chunk'))
})

test('consolidation pending list drops corpus_excluded rows and rows that already have a member', () => {
  const rows = [
    { id: 'a' },
    { id: 'b', corpus_excluded: false },
    { id: 'c', corpus_excluded: true },
    { id: 'd', corpus_excluded: null },
    { id: 'e' },
  ]
  const pending = pendingInsights(rows, new Set(['e']))
  assert.deepEqual(pending.map(r => r.id), ['a', 'b', 'd'])
})

test('consolidateSource reads pending through pendingInsights, not a bare membership filter', () => {
  const src = readFileSync(new URL('../lib/consolidation.ts', import.meta.url), 'utf8')
  assert.match(src, /const pending = pendingInsights\(allRows, memberSet\)/)
  assert.doesNotMatch(src, /allRows\.filter\(r => !memberSet\.has\(r\.id\)\)/)
})

test('the extraction insert carries the flag, and membership writes live only in consolidation', () => {
  const ext = readFileSync(new URL('../lib/extraction.ts', import.meta.url), 'utf8')
  assert.match(ext, /\.\.\.corpusExclusionFields\(ins\.insight_type\)/)
})

test('the v2 prompt keeps anecdotes, as reports of what the speaker did or saw, labelled Anecdote', () => {
  for (const prompt of [EXTRACTION_SYSTEM_PROMPT_V2, EXTRACTION_SYSTEM_PROMPT_EXHAUSTIVE]) {
    assert.match(prompt, /Anecdote/)
    assert.match(prompt, /did, saw or experienced/)
    assert.doesNotMatch(prompt, /a bare anecdote with no point/)
  }
  assert.match(EXTRACTION_SYSTEM_PROMPT_V2, /Personal anecdotes are kept/)
})

test('the harness reports the pass-specific rate with and without anecdotes', () => {
  const mk = (id: string, kind: string, q: string, span: [number, number]): MatchInsight => ({
    id, chunk: 0, statement: `statement ${id} about ${kind}`, quote: q, span, relStart: 10, relEnd: 50, chunkLen: 1000, kind,
  })
  const P = [
    mk('p1', 'Protocol', 'alpha beta gamma delta epsilon zeta', [0, 40]),
    mk('p2', 'Anecdote', 'one two three four five six seven', [500, 540]),
    mk('p3', 'Anecdote', 'red green blue yellow orange purple', [900, 940]),
    mk('p4', 'Mechanism', 'cat dog bird fish horse mouse', [1500, 1540]),
  ]
  // The other pass shares only p1's quote.
  const Q = [mk('q1', 'Protocol', 'alpha beta gamma delta epsilon zeta', [0, 40])]
  const rows = matchOneWay(P, Q, { qToP: n => n, sim: (x, y) => lexicalSim(x.statement, y.statement), simThreshold: 0.99 })
  const d = summariseDirection(P, rows)
  assert.equal(d.passSpecificRate, 0.75) // 3 of 4 unmatched, anecdotes included
  assert.equal(d.nExAnecdotes, 2)
  assert.equal(d.passSpecificExAnecdotes, 1) // only p4
  assert.equal(d.passSpecificRateExAnecdotes, 0.5)
})
