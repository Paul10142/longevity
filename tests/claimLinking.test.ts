/**
 * lib/claimLinking.ts — fix 6 of the 2026-11-08 study-linking report: a cited study is attached only to the
 * claims whose wording is about it, not to every claim said in the same few minutes.
 * No model and no database: the model call is a stub that answers by statement text.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectInsightsAboutStudy, buildClaimLinkPrompt, CLAIM_LINK_BATCH,
  type ClaimLinkInput, type InsightCandidate,
} from '../lib/claimLinking'
import { ModelRefusalError } from '../lib/llm'
import { PipelineHaltError } from '../lib/usageLimit'

const STUDY = { title: 'Cardiovascular Risk Reduction with Icosapent Ethyl for Hypertriglyceridemia', authors: ['Deepak Bhatt'], year: 2019, journal: 'N Engl J Med', abstract: 'REDUCE-IT randomized trial of icosapent ethyl.' }

const INSIGHTS: InsightCandidate[] = [
  { id: 'a', statement: 'In REDUCE-IT, high-dose EPA cut major cardiovascular events by about 25%.', quote: 'REDUCE-IT showed a 25 percent reduction' },
  { id: 'b', statement: 'Randomization balances unknown confounders between groups.', quote: null },
  { id: 'c', statement: 'The REDUCE-IT control arm took mineral oil, which may have raised inflammation markers.', quote: 'the placebo was mineral oil' },
  { id: 'd', statement: 'Triglycerides above 150 mg/dL are a risk marker.', quote: null },
]

function input(over: Partial<ClaimLinkInput> = {}): ClaimLinkInput {
  return {
    raw: 'REDUCE-IT', parsed: { context: 'high-dose EPA reduced cardiovascular events by 25% versus placebo' },
    episode: { title: '#200 Omega-3', people: ['Dr. Peter Attia'] }, study: STUDY, insights: INSIGHTS, ...over,
  }
}

test('only the statements the model picks are linked', async () => {
  const r = await selectInsightsAboutStudy(input(), { judge: async () => [0, 2] })
  assert.equal(r.outcome, 'selected')
  assert.deepEqual(r.selectedIds, ['a', 'c'])
  assert.equal(r.considered, 4)
})

test('the model picking nothing links nothing, and that is a normal answer', async () => {
  const r = await selectInsightsAboutStudy(input(), { judge: async () => [] })
  assert.equal(r.outcome, 'selected')
  assert.deepEqual(r.selectedIds, [])
})

test('an answer with invalid numbers cannot link a statement that was not offered', async () => {
  const r = await selectInsightsAboutStudy(input(), { judge: async () => [1, 1, -1, 4, 99, 1.5, '2' as unknown as number, NaN] })
  assert.deepEqual(r.selectedIds, ['b'], 'only index 1 is valid, and only once')
})

test('a chunk with no claimed statements makes no model call', async () => {
  let calls = 0
  const r = await selectInsightsAboutStudy(input({ insights: [] }), { judge: async () => { calls++; return [0] } })
  assert.equal(calls, 0)
  assert.deepEqual(r, { outcome: 'selected', selectedIds: [], considered: 0 })
})

test('a model error is "failed": nothing linked, no throw, the caller retries later', async () => {
  const r = await selectInsightsAboutStudy(input(), { judge: async () => { throw new Error('socket hang up') } })
  assert.equal(r.outcome, 'failed')
  assert.deepEqual(r.selectedIds, [])
})

test('a refusal is final: nothing linked, and it is not "failed" (retrying would not help)', async () => {
  const r = await selectInsightsAboutStudy(input(), { judge: async () => { throw new ModelRefusalError('claude-opus-5-5', 'safety') } })
  assert.equal(r.outcome, 'refused')
  assert.deepEqual(r.selectedIds, [])
})

test('a usage-limit halt stops the whole pass instead of being swallowed', async () => {
  await assert.rejects(
    selectInsightsAboutStudy(input(), { judge: async () => { throw new PipelineHaltError(5, 'not logged in') } }),
    PipelineHaltError,
  )
})

test('a long chunk is judged in batches and numbers map back to the right statements', async () => {
  const many: InsightCandidate[] = Array.from({ length: 95 }, (_, i) => ({ id: `i${i}`, statement: `statement ${i}`, quote: null }))
  const sizes: number[] = []
  const r = await selectInsightsAboutStudy(input({ insights: many }), {
    // pick position 0 of every batch
    judge: async inp => { sizes.push(inp.insights.length); return [0] },
  })
  assert.deepEqual(sizes, [CLAIM_LINK_BATCH, CLAIM_LINK_BATCH, 15])
  assert.deepEqual(r.selectedIds, ['i0', `i${CLAIM_LINK_BATCH}`, `i${CLAIM_LINK_BATCH * 2}`])
  assert.equal(r.considered, 95)
})

test('if any batch fails nothing is linked from the others either (no half-judged chunk)', async () => {
  const many: InsightCandidate[] = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, statement: `s${i}`, quote: null }))
  let n = 0
  const r = await selectInsightsAboutStudy(input({ insights: many }), {
    judge: async () => { if (++n === 2) throw new Error('boom'); return [0] },
  })
  assert.equal(r.outcome, 'failed')
  assert.deepEqual(r.selectedIds, [])
})

test('the model sees the study, the finding the speaker described, and numbered statements with their quotes', () => {
  const p = buildClaimLinkPrompt(input())
  assert.match(p, /Icosapent Ethyl/)
  assert.match(p, /Bhatt/)
  assert.match(p, /REDUCE-IT randomized trial/, 'abstract included when there is one')
  assert.match(p, /high-dose EPA reduced cardiovascular events by 25%/, 'the finding the speaker attributed to the study')
  assert.match(p, /\[0\] In REDUCE-IT, high-dose EPA/)
  assert.match(p, /\[3\] Triglycerides above 150/)
  assert.match(p, /said: "the placebo was mineral oil"/)
  assert.doesNotMatch(p, /\bid\b|"a"|"b"/, 'internal ids are never shown to the model')
})

test('a study with no abstract and a mention with no described finding still build a prompt', () => {
  const p = buildClaimLinkPrompt(input({ parsed: {}, study: { ...STUDY, abstract: null, authors: [], journal: null, year: null } }))
  assert.match(p, /Finding the speaker attributed to the study: n\/a/)
  assert.doesNotMatch(p, /abstract:/)
  assert.match(p, /authors n\/a, journal n\/a, year n\/a/)
})
