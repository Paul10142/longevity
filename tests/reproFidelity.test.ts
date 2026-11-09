/**
 * Unit tests for the fidelity flag-rate helpers (lib/reproFidelity.ts) behind
 * `scripts/evalReproducibility.ts fidelity`. No model calls, no database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIDELITY_BASELINE, wilson, tallyFidelity, poolTallies, compareToBaseline, quoteFitsChunk, quoteFitShare, chunkTextOf,
  speakerAttributionFlags, SPEAKER_ATTRIBUTION_REASON, type JudgedRow,
} from '../lib/reproFidelity'
import { applyRemovals } from '../lib/reproducibility'
import { FIDELITY_JUDGE_SYSTEM, isViolation } from '../lib/extractionFidelity'

const row = (id: string, verdict: JudgedRow['verdict'], o: Partial<JudgedRow> = {}): JudgedRow => ({
  id, chunk: 0, verdict, offending: verdict === 'FAITHFUL' ? '' : 'x', reasoning: 'ok', ms: 1, costUsd: 0, quoteInChunk: true, ...o,
})
const rows = (spec: Record<string, number>): JudgedRow[] =>
  Object.entries(spec).flatMap(([verdict, n]) => Array.from({ length: n }, (_, i) => row(`${verdict}${i}`, verdict as JudgedRow['verdict'])))

test('PR #59 baseline figures reproduce the plan\'s 8.9% and the stored 33.5%', () => {
  const o = FIDELITY_BASELINE.opus55NewSetup, h = FIDELITY_BASELINE.haiku45OldSetup
  assert.equal(o.flagged, 83 + 38 + 17)
  assert.equal(Math.round((1000 * o.flagged) / o.judged), 89)
  assert.equal(o.rate, 0.089)
  assert.equal(h.flagged, 260 + 161 + 0)
  assert.equal(Math.round((1000 * h.flagged) / h.judged), 335)
  assert.equal(FIDELITY_BASELINE.barPoints, 2)
})

test('the three violation verdicts flag; FAITHFUL and UNSURE do not (same rule as PR #59 and the live gate)', () => {
  assert.ok(isViolation('ADDED_DETAIL') && isViolation('DROPPED_QUALIFIER') && isViolation('UNRESOLVED_REFERENCE'))
  assert.ok(!isViolation('FAITHFUL') && !isViolation('UNSURE'))
})

test('the judge being reused is the production one (its prompt is the faithfulness-to-source audit)', () => {
  assert.match(FIDELITY_JUDGE_SYSTEM, /FAITHFULNESS TO WHAT THE SOURCE SAID/)
  assert.match(FIDELITY_JUDGE_SYSTEM, /ADDED_DETAIL/)
})

test('tally: rate is flagged over judged; UNSURE is judged but not flagged', () => {
  const t = tallyFidelity(rows({ FAITHFUL: 85, ADDED_DETAIL: 6, DROPPED_QUALIFIER: 3, UNRESOLVED_REFERENCE: 1, UNSURE: 5 }), 100)
  assert.equal(t.judged, 100)
  assert.equal(t.flagged, 10)
  assert.equal(t.unsure, 5)
  assert.equal(t.faithful, 85)
  assert.equal(t.rate, 0.1)
  assert.deepEqual([t.addedDetail, t.droppedQualifier, t.unresolvedReference], [6, 3, 1])
  assert.equal(t.missing, 0)
})

test('tally: an errored call is a missing measurement, in neither numerator nor denominator', () => {
  const rs = [...rows({ FAITHFUL: 8, ADDED_DETAIL: 2 }), row('e1', 'UNSURE', { reasoning: 'error: CLI timed out' })]
  const t = tallyFidelity(rs, 13)
  assert.equal(t.judged, 10)
  assert.equal(t.errors, 1)
  assert.equal(t.missing, 2, 'two insights have no row at all')
  assert.equal(t.rate, 0.2)
})

test('tally: nothing judged gives a null rate and interval, never 0%', () => {
  const t = tallyFidelity([], 5)
  assert.equal(t.rate, null)
  assert.equal(t.ci, null)
  assert.equal(t.missing, 5)
})

test('wilson interval: contains the estimate, narrows with n, stays inside 0..1, null without data', () => {
  const small = wilson(2, 20)!, big = wilson(200, 2000)!
  assert.ok(small[0] < 0.1 && 0.1 < small[1])
  assert.ok(big[1] - big[0] < small[1] - small[0])
  const zero = wilson(0, 10)!
  assert.equal(zero[0], 0)
  assert.ok(zero[1] > 0 && zero[1] < 0.4)
  assert.equal(wilson(10, 10)![1], 1)
  assert.equal(wilson(0, 0), null)
  // 138 of 1,550 (PR #59) is 8.9% with an interval of about 7.6% to 10.4%.
  const pr59 = wilson(138, 1550)!
  assert.ok(pr59[0] > 0.075 && pr59[1] < 0.105)
})

test('pooling adds counts and recomputes the rate', () => {
  const a = tallyFidelity(rows({ FAITHFUL: 90, ADDED_DETAIL: 10 }), 100)
  const b = tallyFidelity(rows({ FAITHFUL: 70, DROPPED_QUALIFIER: 10 }), 80)
  const p = poolTallies([a, b])
  assert.equal(p.insights, 180)
  assert.equal(p.judged, 180)
  assert.equal(p.flagged, 20)
  assert.equal(p.addedDetail, 10)
  assert.equal(p.droppedQualifier, 10)
  assert.ok(Math.abs(p.rate! - 20 / 180) < 1e-12)
})

test('bar: at most 2 points above 8.9% passes (10.9% is the limit); 11.0% and above fails', () => {
  const at = (flagged: number, n = 1000) => tallyFidelity(rows({ FAITHFUL: n - flagged, ADDED_DETAIL: flagged }), n)
  const base = FIDELITY_BASELINE.opus55NewSetup.rate
  const better = compareToBaseline(at(50), base)
  assert.equal(better.points, -3.9)
  assert.equal(better.meetsBar, true)
  assert.equal(compareToBaseline(at(109), base).meetsBar, true, '10.9% is exactly at the limit')
  assert.equal(compareToBaseline(at(109), base).points, 2)
  const worse = compareToBaseline(at(112), base)
  assert.equal(worse.points, 2.3)
  assert.equal(worse.meetsBar, false)
  assert.ok(Math.abs(worse.limit - 0.109) < 1e-12)
})

test('bar: the interval says whether a single episode can be trusted either way', () => {
  const base = FIDELITY_BASELINE.opus55NewSetup.rate
  const noisy = compareToBaseline(tallyFidelity(rows({ FAITHFUL: 200, ADDED_DETAIL: 20 }), 220), base) // 9.1% of 220
  assert.equal(noisy.meetsBar, true)
  assert.equal(noisy.intervalUnderLimit, false, 'the upper end of the interval is above 10.9%')
  assert.equal(noisy.intervalOverLimit, false)
  const clearlyUnder = compareToBaseline(tallyFidelity(rows({ FAITHFUL: 1900, ADDED_DETAIL: 100 }), 2000), base) // 5%
  assert.equal(clearlyUnder.intervalUnderLimit, true)
  const clearlyOver = compareToBaseline(tallyFidelity(rows({ FAITHFUL: 600, ADDED_DETAIL: 400 }), 1000), base) // 40%
  assert.equal(clearlyOver.intervalOverLimit, true)
  assert.equal(compareToBaseline(tallyFidelity([], 3), base).meetsBar, null)
})

test('quote check: found in the chunk, tolerant of case, punctuation and ellipses; null when none cited', () => {
  const chunk = 'Host: So how big is it?\nGuest: Well, it depends on which study you read, 40-50% I think. Then habits matter.'
  assert.equal(quoteFitsChunk(chunk, 'It depends on which study you read'), true)
  assert.equal(quoteFitsChunk(chunk, 'depends on which study ... habits matter'), true)
  assert.equal(quoteFitsChunk(chunk, 'depends on which study ... sleep matters most'), false)
  assert.equal(quoteFitsChunk(chunk, 'a sentence the speaker never said'), false)
  assert.equal(quoteFitsChunk(chunk, null), null)
  assert.equal(quoteFitsChunk(chunk, '   '), null)
})

test('quote fit share only counts insights that cite a quote', () => {
  assert.equal(quoteFitShare([{ quoteInChunk: true }, { quoteInChunk: false }, { quoteInChunk: null }, { quoteInChunk: true }]), 2 / 3)
  assert.equal(quoteFitShare([{ quoteInChunk: null }]), null)
})

test('chunk text is the hygiene-cleaned document sliced by the pass plan, so removals shift the slice', () => {
  const raw = 'INTRO AD. Real content starts here and goes on. OUTRO AD.'
  const doc = applyRemovals(raw, [{ start: 0, end: 10 }, { start: 47, end: raw.length }])
  assert.equal(doc.text, 'Real content starts here and goes on.')
  assert.equal(chunkTextOf(doc, { start: 0, end: 12 }), 'Real content')
  assert.equal(chunkTextOf(doc, { start: 13, end: doc.text.length }), 'starts here and goes on.')
})

test('speaker-attribution flags are told apart from substantive ones by the judge\'s own reasoning', () => {
  const attr = (id: string, reasoning: string) => row(id, 'ADDED_DETAIL', { reasoning })
  const rs = [
    attr('a', 'The chunk never names this speaker (the only name that appears is Peter Attia), so attributing the claim to James Clear adds a named entity.'),
    attr('b', 'The content is faithful, but the chunk has no speaker label for this passage.'),
    row('c', 'ADDED_DETAIL', { reasoning: "The chunk refers to the man only as 'him' and never says he is her husband, so the insight adds a relationship." }),
    row('d', 'DROPPED_QUALIFIER', { reasoning: 'The chunk adds that the approach requires patience for six months, and the insight drops this duration.' }),
    row('e', 'FAITHFUL', { reasoning: 'Attributes correctly; every element traces to the chunk.', offending: '' }),
    row('f', 'UNSURE', { reasoning: 'The chunk has no speaker labels for this passage.' }),
    row('g', 'ADDED_DETAIL', { reasoning: 'error: attribution lookup failed' }),
  ]
  assert.equal(speakerAttributionFlags(rs), 2, 'only real violations count; FAITHFUL, UNSURE and errored rows never do')
  assert.ok(SPEAKER_ATTRIBUTION_REASON.test('the chunk never names the speaker'))
  assert.ok(!SPEAKER_ATTRIBUTION_REASON.test('the insight drops the six-month duration'))
})
