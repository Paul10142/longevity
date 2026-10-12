/**
 * lib/enrichMerge.ts — the two-way fidelity guard. A rewrite is rejected when it INVENTS a
 * number no member carried (existing) or DROPS one a member / the prior canonical carried
 * (added 2026-10-12). The wording below is lifted from Paul's gold pairs
 * (eval/dedup-eval-pairs.json) where one exists, so the false-alarm cases are real ones.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { droppedSpecifics, fidelityCheck, numericSpecifics, requiredSpecifics } from '../lib/enrichMerge'

// merge:01c7c180 — a testosterone / polycythemia pair
const HB_A =
  'Polycythemia from testosterone raises thrombotic risk—events begin to increase around hemoglobin ≈17 g/dL or hematocrit ≈50%; risks rise further near hemoglobin ≈18 g/dL and are clear by ≈19 g/dL—so monitor CBC/hematocrit.'
const HB_B =
  'Testosterone replacement commonly causes polycythemia; clinically concerning levels are around hemoglobin 17 g/dL and hematocrit 50%, with events becoming more likely at hemoglobin ≈18 g/dL and certainly by 19 g/dL.'

test('a dropped dose is caught: the rewrite keeps the story but loses 19 g/dL', () => {
  const rewrite =
    'Testosterone-related polycythemia raises thrombotic risk from hemoglobin ≈17 g/dL or hematocrit ≈50%, rising near ≈18 g/dL; monitor CBC.'
  assert.deepEqual(droppedSpecifics(rewrite, [HB_A, HB_B]), ['19'])
})

test('a rewrite that keeps every number passes', () => {
  const rewrite =
    'Testosterone polycythemia raises thrombotic risk: events begin near hemoglobin 17 g/dL or hematocrit 50%, rise further near 18 g/dL and are clear by 19 g/dL; monitor CBC.'
  assert.deepEqual(droppedSpecifics(rewrite, [HB_A, HB_B]), [])
})

test('the prior canonical counts as a source, not only the members', () => {
  assert.deepEqual(droppedSpecifics('Take it daily.', ['Take 5 mg daily.', 'Take it every day.']), ['5'])
  assert.deepEqual(droppedSpecifics('Take 5 mg daily.', ['Take 5 mg daily.', 'Take it every day.']), [])
})

// ---- false alarms: the same figure written another way must NOT read as dropped ----

test('5 mg / 5 milligrams, 30-40 / 30 to 40, 5.0 / 5', () => {
  assert.deepEqual(droppedSpecifics('Take 5 milligrams.', ['Take 5 mg.']), [])
  assert.deepEqual(droppedSpecifics('Walk 30 to 40 minutes.', ['Walk 30-40 minutes.']), [])
  assert.deepEqual(droppedSpecifics('Walk 30–40 minutes.', ['Walk 30 to 40 minutes.']), [])
  assert.deepEqual(droppedSpecifics('Take 5 mg.', ['Take 5.0 mg.']), [])
  assert.deepEqual(numericSpecifics('0.50 and .5'), ['0.5', '5'])
})

test('digits ↔ spelled-out numbers, both directions (merge:2a322129, merge:11ca63fa)', () => {
  // member "~5–6 weeks" vs a rewrite that spells it out
  assert.deepEqual(droppedSpecifics('SRY acts at about five to six weeks.', ['SRY acts around ~5–6 weeks.']), [])
  // member "peak around 3 months" vs "three months"
  assert.deepEqual(droppedSpecifics('A postnatal surge peaks at three months.', ['peak around 3 months']), [])
  // and the other way: a member's "three" grounds the digit the rewrite writes (no false "invented")
  assert.equal(fidelityCheck('Men live about 3 years longer.', ['men live about three years longer']).ok, true)
  assert.equal(fidelityCheck('Men live about 4 years longer.', ['men live about three years longer']).ok, false)
})

test('"one" is not a quantity when grounding, so it cannot excuse an invented 1', () => {
  assert.equal(fidelityCheck('Take 1 g.', ['one of the most studied supplements']).ok, false)
})

test('a percent written as a fraction (merge:b75d7694: 20% / one-fifth)', () => {
  assert.deepEqual(droppedSpecifics('Roughly one-fifth of genes on the inactive X escape.', ['about 20% of genes on the ‘silenced’ X escape']), [])
  assert.equal(fidelityCheck('About 20% of genes escape.', ['Roughly one-fifth of genes escape']).ok, true)
  assert.deepEqual(droppedSpecifics('Half of patients respond.', ['50% of patients respond']), [])
})

test('thousands separators and sub/superscripts (merge:e866d367, merge:75c363aa)', () => {
  assert.deepEqual(droppedSpecifics('A cohort of 74000 men', ['a large Danish cohort (≈74,000 men followed up to 50 years)']), ['50'])
  assert.deepEqual(numericSpecifics('types 1,2,3 and 12,345'), ['1', '2', '3', '12345'])
  assert.deepEqual(droppedSpecifics('VO₂ max', ['VO2 max']), [])
  assert.deepEqual(droppedSpecifics('VO2max', ['VO2‑max']), [])
})

test('a unit exponent is not a number: ml·kg⁻¹·min⁻¹ may become ml/kg/min', () => {
  const member = 'for a 50-year-old that corresponds to roughly 52 ml·kg⁻¹·min⁻¹.'
  assert.deepEqual(requiredSpecifics(member), ['50', '52'])
  assert.deepEqual(droppedSpecifics('A 50-year-old: about 52 ml/kg/min.', [member]), [])
})

test('ranges: a point inside a range the rewrite states is subsumed; the endpoints are not', () => {
  // member A "3–8 minutes", member B "3–4 minute": the rewrite keeps A's range; B's 3 and 4 sit in/at it
  const members = ['use intervals lasting about 3–8 minutes', 'Use 3–4 minute high‑intensity intervals']
  assert.deepEqual(droppedSpecifics('Use 3–8 minute intervals.', members), [])
  // a lone interior point
  assert.deepEqual(droppedSpecifics('Walk between 30 and 60 minutes.', ['Walk 45 minutes.']), [])
  // an endpoint is not interior
  assert.deepEqual(droppedSpecifics('Walk 30-40 minutes.', ['Walk 40 minutes.', 'Walk 30-40 minutes.']), [])
  assert.deepEqual(droppedSpecifics('Walk 30-40 minutes.', ['Walk 45 minutes.']), ['45'])
})

// ---- numbers that are not clinical specifics ----

test('a publication year or citation number may be dropped, a dose of the same size may not', () => {
  assert.deepEqual(droppedSpecifics('Creatine helps.', ['A 2019 meta-analysis found creatine helps [12]. (Smith et al. 2018; PMID 3141592; Table 2)']), [])
  assert.deepEqual(droppedSpecifics('Creatine helps.', ['Take 2000 mg daily']), ['2000'])
  assert.deepEqual(droppedSpecifics('Walk daily.', ['Walk 2000 steps']), ['2000'])
  assert.deepEqual(droppedSpecifics('Eat well.', ['Eat 2,000 calories']), ['2000'])
})

test('a year the rewrite INVENTS is still an invented number', () => {
  assert.equal(fidelityCheck('A 2021 trial found it.', ['A 2019 trial found it.']).ok, false)
})

test('a number that exists only in a member quote is grounding for "invented" but is not required', () => {
  // droppedSpecifics is given statements only (quotes are evidence, not canonical text)
  assert.deepEqual(droppedSpecifics('Magnesium helps sleep.', ['Magnesium helps sleep.']), [])
  assert.equal(fidelityCheck('Magnesium 300 mg helps sleep.', ['Magnesium helps sleep.', '"I take 300 mg"']).ok, true)
})

test('numbers that are part of a name still have to be kept', () => {
  assert.deepEqual(droppedSpecifics('Type diabetes responds to exercise.', ['Type 2 diabetes responds to exercise.']), ['2'])
})
