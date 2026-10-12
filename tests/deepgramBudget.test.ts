/**
 * Unit tests for lib/deepgramBudget.ts — the credit arithmetic behind
 * `fetchPodcastFeed.ts --fit-budget` and the transcriber's skip-don't-stop
 * loop. Pure functions, so these run without a feed, a key, or a ledger.
 *
 * The rule under test: walk the items IN ORDER, take each one that still fits
 * the remaining credit less the margin, skip (never stop at) each one that
 * does not, so a shorter episode further down can still use what is left.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSUMED_BITRATE_BPS,
  DEEPGRAM_RATE_PER_HOUR,
  DEFAULT_MARGIN_USD,
  assessItem,
  budgetToCover,
  describeFit,
  estimateHours,
  fitEpisodesToBudget,
  hoursFromBytes,
  resolveSpend,
} from '../lib/deepgramBudget'

const item = (key: string, hours: number) => ({ key, hours })
const keys = (xs: { key: string }[]) => xs.map(x => x.key)

test('constants: the published rate and the default margin', () => {
  assert.equal(DEEPGRAM_RATE_PER_HOUR, 0.34)
  assert.equal(DEFAULT_MARGIN_USD, 0.25)
  assert.equal(ASSUMED_BITRATE_BPS, 128_000)
})

test('fitEpisodesToBudget: everything fits → chosen in input order with running totals', () => {
  const fit = fitEpisodesToBudget([item('a', 1), item('b', 2), item('c', 0.5)], 10, 1, 0)
  assert.deepEqual(keys(fit.chosen), ['a', 'b', 'c'])
  assert.deepEqual(fit.chosen.map(c => c.cumulativeUsd), [1, 3, 3.5])
  assert.deepEqual(fit.chosen.map(c => c.estUsd), [1, 2, 0.5])
  assert.deepEqual(fit.skipped, [])
  assert.equal(fit.spendableUsd, 10)
  assert.equal(fit.chosenUsd, 3.5)
  assert.equal(fit.chosenHours, 3.5)
  assert.equal(fit.overBudgetUsd, 0)
})

test('fitEpisodesToBudget: an unaffordable item is skipped and a later, smaller one is still taken', () => {
  const fit = fitEpisodesToBudget([item('big-first', 2), item('too-big', 5), item('small-later', 1)], 3.5, 1, 0)
  assert.deepEqual(keys(fit.chosen), ['big-first', 'small-later'])
  assert.deepEqual(fit.chosen.map(c => c.cumulativeUsd), [2, 3])
  assert.equal(fit.skipped.length, 1)
  assert.equal(fit.skipped[0].key, 'too-big')
  assert.equal(fit.skipped[0].reason, 'over-budget')
  assert.equal(fit.skipped[0].estUsd, 5)
  assert.equal(fit.overBudgetUsd, 5)
  assert.equal(fit.overBudgetHours, 5)
})

test('fitEpisodesToBudget: the walk keeps going after several skips', () => {
  const fit = fitEpisodesToBudget(
    [item('x1', 4), item('x2', 4), item('ok1', 1), item('x3', 4), item('ok2', 1), item('ok3', 1)],
    3,
    1,
    0
  )
  assert.deepEqual(keys(fit.chosen), ['ok1', 'ok2', 'ok3'])
  assert.deepEqual(keys(fit.skipped), ['x1', 'x2', 'x3'])
  assert.equal(fit.chosenUsd, 3)
})

test('fitEpisodesToBudget: the margin is kept unspent', () => {
  // Exact binary fractions throughout, so equality checks are not at the mercy of 0.1 + 0.2.
  const items = [item('a', 1), item('b', 1), item('c', 1)]
  const withMargin = fitEpisodesToBudget(items, 2.5, 1, 0.75)
  assert.equal(withMargin.spendableUsd, 1.75)
  assert.deepEqual(keys(withMargin.chosen), ['a'])
  assert.deepEqual(keys(withMargin.skipped), ['b', 'c'])

  const noMargin = fitEpisodesToBudget(items, 2.5, 1, 0)
  assert.deepEqual(keys(noMargin.chosen), ['a', 'b'])
  assert.deepEqual(keys(noMargin.skipped), ['c'])

  // The default margin applies when none is passed.
  const dflt = fitEpisodesToBudget([item('a', 1)], 1.125, 1)
  assert.deepEqual(keys(dflt.chosen), [])
  assert.equal(dflt.spendableUsd, 1.125 - DEFAULT_MARGIN_USD)
})

test('fitEpisodesToBudget: an item that exactly uses the spendable amount fits', () => {
  const fit = fitEpisodesToBudget([item('a', 2)], 2.25, 1, 0.25)
  assert.deepEqual(keys(fit.chosen), ['a'])
})

test('fitEpisodesToBudget: zero, negative or unreadable remaining credit chooses nothing', () => {
  for (const remaining of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) {
    const fit = fitEpisodesToBudget([item('a', 0.1), item('b', 0.1)], remaining, 1, 0)
    assert.deepEqual(keys(fit.chosen), [], `remaining=${remaining}`)
    assert.deepEqual(keys(fit.skipped), ['a', 'b'])
    assert.ok(fit.skipped.every(s => s.reason === 'over-budget'))
    assert.equal(fit.spendableUsd, 0)
  }
})

test('fitEpisodesToBudget: credit below the margin chooses nothing', () => {
  const fit = fitEpisodesToBudget([item('a', 0.01)], 0.2, 1, 0.25)
  assert.deepEqual(keys(fit.chosen), [])
  assert.equal(fit.spendableUsd, 0)
})

test('fitEpisodesToBudget: items with no usable duration are skipped as no-estimate and never priced', () => {
  const fit = fitEpisodesToBudget([item('zero', 0), item('nan', Number.NaN), item('neg', -1), item('ok', 1)], 100, 1, 0)
  assert.deepEqual(keys(fit.chosen), ['ok'])
  assert.deepEqual(
    fit.skipped.map(s => [s.key, s.reason, s.estUsd]),
    [
      ['zero', 'no-estimate', 0],
      ['nan', 'no-estimate', 0],
      ['neg', 'no-estimate', 0],
    ]
  )
  assert.equal(fit.overBudgetUsd, 0)
  assert.equal(fit.overBudgetHours, 0)
})

test('fitEpisodesToBudget: prices at the given rate', () => {
  const fit = fitEpisodesToBudget([item('a', 2), item('b', 10)], 1, DEEPGRAM_RATE_PER_HOUR, 0)
  assert.deepEqual(keys(fit.chosen), ['a'])
  assert.equal(fit.chosen[0].estUsd, 2 * DEEPGRAM_RATE_PER_HOUR)
  assert.equal(fit.skipped[0].estUsd, 10 * DEEPGRAM_RATE_PER_HOUR)
})

test('fitEpisodesToBudget: carries extra fields through and leaves the input alone', () => {
  const input = [
    { key: 'a', hours: 1, title: 'A', estimated: true },
    { key: 'b', hours: 9, title: 'B', estimated: false },
  ]
  const snapshot = JSON.stringify(input)
  const fit = fitEpisodesToBudget(input, 2, 1, 0)
  assert.equal(fit.chosen[0].title, 'A')
  assert.equal(fit.chosen[0].estimated, true)
  assert.equal(fit.skipped[0].title, 'B')
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(fitEpisodesToBudget([], 5, 1).chosen.length, 0)
})

test('assessItem: the single-item verdict the transcriber re-asks per file', () => {
  assert.deepEqual(assessItem(item('a', 1), 2, 1, 0.25), { ok: true, estUsd: 1 })
  assert.deepEqual(assessItem(item('a', 1), 1.2, 1, 0.25), { ok: false, estUsd: 1, reason: 'over-budget' })
  assert.deepEqual(assessItem(item('a', 1), 1, 1, 0), { ok: true, estUsd: 1 })
  assert.deepEqual(assessItem(item('a', 0), 100, 1, 0), { ok: false, estUsd: 0, reason: 'no-estimate' })
  // A negative margin never widens the budget.
  assert.equal(assessItem(item('a', 1), 1.5, 1, -10).ok, true)
  assert.equal(assessItem(item('a', 2), 1.5, 1, -10).ok, false)
  // Uses the default margin when none is given.
  assert.equal(assessItem(item('a', 1), 1.2, 1).ok, false)
})

test('hoursFromBytes: 57.6 MB at 128 kbps is one hour; nonsense is zero', () => {
  assert.equal(hoursFromBytes(57_600_000), 1)
  assert.equal(hoursFromBytes(57_600_000, 64_000), 2)
  assert.equal(hoursFromBytes(0), 0)
  assert.equal(hoursFromBytes(-1), 0)
  assert.equal(hoursFromBytes(Number.NaN), 0)
  assert.equal(hoursFromBytes(1000, 0), 0)
})

test('estimateHours: the duration tag wins when present and non-zero', () => {
  assert.deepEqual(estimateHours({ duration_seconds: 3600, audio_bytes: 999_999_999 }), { hours: 1, estimated: false })
  assert.deepEqual(estimateHours({ duration_seconds: 1800, audio_bytes: null }), { hours: 0.5, estimated: false })
})

test('estimateHours: empty or zero duration falls back to bytes at the assumed bitrate, flagged as estimated', () => {
  assert.deepEqual(estimateHours({ duration_seconds: null, audio_bytes: 57_600_000 }), { hours: 1, estimated: true })
  assert.deepEqual(estimateHours({ duration_seconds: 0, audio_bytes: 57_600_000 }), { hours: 1, estimated: true })
  assert.deepEqual(estimateHours({ audio_bytes: 57_600_000 }), { hours: 1, estimated: true })
  assert.deepEqual(estimateHours({ audio_bytes: 57_600_000 }, 64_000), { hours: 2, estimated: true })
})

test('estimateHours: nothing to go on → null (never zero, never guessed)', () => {
  assert.equal(estimateHours({ duration_seconds: null, audio_bytes: null }), null)
  assert.equal(estimateHours({ duration_seconds: 0, audio_bytes: 0 }), null)
  assert.equal(estimateHours({}), null)
})

test('resolveSpend: the real balance wins over the ledger', () => {
  assert.deepEqual(resolveSpend({ budgetUsd: 200, ledgerEstimateUsd: 50, realBalanceUsd: 120 }), {
    spentUsd: 80,
    remainingUsd: 120,
    source: 'deepgram',
  })
})

test('resolveSpend: a balance above the cap reads as nothing spent, remaining = cap', () => {
  assert.deepEqual(resolveSpend({ budgetUsd: 50, ledgerEstimateUsd: 0, realBalanceUsd: 120 }), {
    spentUsd: 0,
    remainingUsd: 50,
    source: 'deepgram',
  })
  assert.deepEqual(resolveSpend({ budgetUsd: 200, ledgerEstimateUsd: 0, realBalanceUsd: 0 }), {
    spentUsd: 200,
    remainingUsd: 0,
    source: 'deepgram',
  })
})

test('resolveSpend: no real balance → budget minus ledger, never below zero', () => {
  assert.deepEqual(resolveSpend({ budgetUsd: 200, ledgerEstimateUsd: 50, realBalanceUsd: null }), {
    spentUsd: 50,
    remainingUsd: 150,
    source: 'ledger',
  })
  assert.deepEqual(resolveSpend({ budgetUsd: 200, ledgerEstimateUsd: 260, realBalanceUsd: null }), {
    spentUsd: 260,
    remainingUsd: 0,
    source: 'ledger',
  })
  assert.deepEqual(resolveSpend({ budgetUsd: 200, ledgerEstimateUsd: Number.NaN, realBalanceUsd: Number.NaN }), {
    spentUsd: 0,
    remainingUsd: 200,
    source: 'ledger',
  })
})

test('budgetToCover: spent + skipped + margin, rounded UP to the cent', () => {
  assert.equal(budgetToCover(10, 1, 0.25), 11.25)
  assert.equal(budgetToCover(10, 1.001, 0), 11.01)
  assert.equal(budgetToCover(10, 1.009, 0), 11.01)
  // Floating-point noise (0.1 + 0.2) must not round up a phantom cent.
  assert.equal(budgetToCover(0.1, 0.2, 0), 0.3)
  assert.equal(budgetToCover(-5, -5, -5), 0)
  assert.equal(budgetToCover(3.14, 0), 3.14 + DEFAULT_MARGIN_USD)
})

test('describeFit: prints every chosen and skipped key, marks estimated hours, applies the label', () => {
  const fit = fitEpisodesToBudget(
    [
      { key: 'attia-0405', hours: 2, estimated: false, title: 'Measured' },
      { key: 'attia-0404', hours: 50, estimated: true, title: 'Skipped' },
      { key: 'attia-0403', hours: 1, estimated: true, title: 'Guessed' },
      { key: 'attia-g1a2b3', hours: 0, estimated: false, title: 'Unpriced' },
    ],
    2,
    0.5,
    0
  )
  const text = describeFit(fit, { ratePerHour: 0.5, label: i => i.title }).join('\n')
  assert.match(text, /attia-0405.*2\.00.*1\.00.*1\.00.*Measured/)
  assert.match(text, /attia-0403.*~1\.00.*0\.50.*1\.50.*Guessed/)
  assert.match(text, /skipped for budget: 1 episode\(s\), 50\.0 h, ~\$25\.00/)
  assert.match(text, /attia-0404.*~50\.00.*25\.00.*Skipped/)
  assert.match(text, /no duration or size to price them: attia-g1a2b3/)
  assert.match(text, /chosen: 2 episode\(s\), 3\.0 h, ~\$1\.50/)
  assert.match(text, /spendable \$2\.00 at \$0\.5\/h/)
  assert.doesNotMatch(text, /https?:/)
})

test('describeFit: says so when nothing fits', () => {
  const text = describeFit(fitEpisodesToBudget([item('a', 1)], 0, 1, 0), { ratePerHour: 1 }).join('\n')
  assert.match(text, /nothing fits/)
  assert.match(text, /skipped for budget: 1 episode/)
})
