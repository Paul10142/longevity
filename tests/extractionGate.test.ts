/**
 * Unit tests for the deterministic post-extraction gate (lib/extractionGate.ts)
 * and the prompt/gate switch (extractionConfig). No model calls, no database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { numbersIn, numbersNotInChunk, hedgesDropped, gateInsight, applyGate } from '../lib/extractionGate'
import { extractionConfig } from '../lib/extraction'

const CHUNK =
  "So I think the dose is probably about forty milligrams, twice a day, if you tolerate it. " +
  "It's very high in people over fifty. In 2019 there were two hundred fifty patients, and 1,200 controls."

test('numbersIn reads digits, words, compounds, years and ignores glued identifiers', () => {
  const n = numbersIn('thirty five, two hundred fifty, a hundred and fifty, twenty nineteen, 1,200, 10k, twice, B12, VO2')
  for (const want of [35, 250, 150, 2019, 1200, 10000, 2]) assert.ok(n.has(want), `missing ${want}`)
  assert.ok(!n.has(12), 'B12 is not a count')
  assert.ok(!numbersIn('two, three').has(5), '"two, three" must not compose to 5')
})

test('numbers: spelled-out chunk numbers support digit statements, invented ones are caught', () => {
  assert.deepEqual(numbersNotInChunk(CHUNK, { statement: 'Take 40 mg twice daily.' }), [])
  assert.deepEqual(numbersNotInChunk(CHUNK, { statement: 'Take 40 mg three times daily.' }), [3])
  assert.deepEqual(numbersNotInChunk(CHUNK, { statement: 'In people over 65, 80 mg.' }), [65, 80])
})

test('numbers: 0, 1 and "one" never count against an insight; qualifiers are checked', () => {
  assert.deepEqual(numbersNotInChunk(CHUNK, { statement: 'About 1 in 3 respond, one at a time.' }), [3])
  assert.deepEqual(
    numbersNotInChunk(CHUNK, { statement: 'Dose guidance.', qualifiers: { dose: '40 mg', duration: '12 weeks' } }),
    [12]
  )
})

test('hedges: a dropped "probably", "very", "if" or "I think" is reported', () => {
  const quote = "I think the dose is probably about forty milligrams if you tolerate it, very high"
  const dropped = hedgesDropped(quote, { statement: 'The dose is 40 milligrams.' })
  for (const w of ['probably', 'very', 'if', 'about']) assert.ok(dropped.some(d => d.startsWith(w)), `missing ${w}`)
})

test('hedges: kept hedges or equivalents pass; speaker attribution keeps a personal guess', () => {
  assert.deepEqual(
    hedgesDropped('it is probably very high if you do that', { statement: 'It is likely very high when you do that.' }),
    []
  )
  assert.deepEqual(
    hedgesDropped('I think this is rare', { statement: 'Attia believes this is rare.', speaker: 'Peter Attia' }),
    []
  )
  assert.deepEqual(
    hedgesDropped('I think this is rare', { statement: 'This is rare.', speaker: 'Peter Attia' }),
    ['i think']
  )
})

test('hedges: nothing to check without a quote', () => {
  assert.deepEqual(hedgesDropped('', { statement: 'anything' }), [])
})

test('gate: faithful insight passes with its quote intact', () => {
  const g = gateInsight(CHUNK, {
    statement: 'The dose is probably about 40 mg twice a day, if tolerated.',
    direct_quote: 'the dose is probably about forty milligrams, twice a day, if you tolerate it',
  })
  assert.equal(g.ok, true, JSON.stringify(g.violations))
  assert.equal(g.quoteRepaired, false)
})

test('gate: rejects a quote that is not in the chunk, and repairs a quote whose tail is invented', () => {
  const bad = gateInsight(CHUNK, { statement: 'Something.', direct_quote: 'this sentence is nowhere in the chunk at all' })
  assert.equal(bad.ok, false)
  assert.equal(bad.violations[0].rule, 'quote_not_in_chunk')

  const real = "I think the dose is probably about forty milligrams, twice a day, if you tolerate it."
  const g = gateInsight(CHUNK, {
    statement: 'I think the dose is probably about 40 mg twice a day if tolerated.',
    direct_quote: real + ' And then it cures everything in the body forever.',
  })
  assert.equal(g.quoteRepaired, true)
  assert.ok(g.quote && CHUNK.includes(g.quote))
})

test('gate: a null quote skips the hedge check but numbers are still checked', () => {
  assert.equal(gateInsight(CHUNK, { statement: 'The dose is 40 mg.', direct_quote: null }).ok, true)
  const g = gateInsight(CHUNK, { statement: 'The dose is 90 mg.', direct_quote: null })
  assert.equal(g.ok, false)
  assert.equal(g.violations[0].rule, 'number_not_in_chunk')
})

test('applyGate splits kept from rejected and carries the repaired quote', () => {
  const out = applyGate(CHUNK, [
    { statement: 'It is very high in people over 50.', direct_quote: "It's very high in people over fifty." },
    { statement: 'It is high in people over 50.', direct_quote: "It's very high in people over fifty." },
  ])
  assert.equal(out.kept.length, 1)
  assert.equal(out.rejected.length, 1)
  assert.equal(out.rejected[0].violations[0].rule, 'hedge_dropped')
})

test('extractionConfig: v2 + gate + Opus 5.5 by default, v1 restores the old behaviour, overrides win', () => {
  const saved = { ...process.env }
  try {
    for (const k of ['EXTRACTION_PROMPT_VERSION', 'EXTRACTION_GATE', 'EXTRACTION_REPAIR', 'EXTRACTION_MODEL']) delete process.env[k]
    const d = extractionConfig()
    assert.equal(d.promptVersion, 'v2'); assert.equal(d.gate, true); assert.equal(d.repair, true)
    assert.equal(d.model, 'claude-opus-5-5')
    process.env.EXTRACTION_PROMPT_VERSION = 'v1'
    const old = extractionConfig()
    assert.equal(old.promptVersion, 'v1'); assert.equal(old.gate, false); assert.equal(old.repair, false)
    assert.equal(old.model, 'claude-haiku-4-5', 'v1 alone restores the old model too')
    process.env.EXTRACTION_MODEL = 'claude-sonnet-5-5'
    assert.equal(extractionConfig().model, 'claude-sonnet-5-5')
    assert.equal(extractionConfig({ model: 'claude-opus-5-5' }).model, 'claude-opus-5-5')
    process.env.EXTRACTION_PROMPT_VERSION = 'v2'; process.env.EXTRACTION_GATE = 'off'
    assert.equal(extractionConfig().gate, false)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})
