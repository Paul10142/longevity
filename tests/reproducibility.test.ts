/**
 * Unit tests for the reproducibility helpers (lib/reproducibility.ts): matcher tiers, offset maps,
 * speaker-turn chunking, context windows, coverage and boundary metrics. No model calls, no database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  foldQuote, quoteTokens, containment, tier1, lexicalSim, buildAnchorMap, mapOffset, IDENTITY_MAP,
  matchOneWay, summariseDirection, withinPassDuplicates, inEdgeZone, fixedBins, turnBins, coverage, disagreement,
  applyRemovals, docToRaw, identityDoc, segmentUnits, keepUnits, docFromUnits, chunkTurns, contextWindow,
  type MatchInsight, type Unit,
} from '../lib/reproducibility'

const ins = (id: string, o: Partial<MatchInsight> & { statement: string }): MatchInsight => ({
  chunk: 0, quote: null, span: null, relStart: null, relEnd: null, chunkLen: 2400, ...o, id,
})

test('foldQuote ignores case, punctuation and smart apostrophes; ellipsis quotes are fragments', () => {
  assert.equal(foldQuote('It’s a “Big” Deal — really!'), 'its a big deal really')
  const t = quoteTokens('the first part ... and the second part')
  assert.ok(t.has('first') && t.has('second') && t.has('part'))
})

test('tier 1: contained quote with six shared words matches; a short or unrelated quote does not', () => {
  const a = ins('a', { statement: 's', quote: 'Habits are the compound interest of self-improvement, and small changes add up over time.' })
  const b = ins('b', { statement: 's', quote: 'habits are the compound interest of self improvement' })
  assert.ok(tier1(a, b).hit)
  const short = ins('c', { statement: 's', quote: 'habits are the' })
  assert.ok(!tier1(a, short).hit, 'only 3 shared tokens')
  const other = ins('d', { statement: 's', quote: 'Magnesium glycinate before bed seems to help some people sleep.' })
  assert.ok(!tier1(a, other).hit)
  assert.equal(containment(quoteTokens(null), quoteTokens('x y')).ratio, 0)
})

test('anchor map follows an insertion between two copies; identical texts map to themselves', () => {
  const filler = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i * 7919 % 1000}`).join(' ')
  const x = filler(400, 'alpha') + ' THE MIDDLE MARKER PHRASE IS HERE ' + filler(400, 'beta')
  const y = filler(400, 'alpha') + ' EXTRA WORDS INSERTED ' + ' THE MIDDLE MARKER PHRASE IS HERE ' + filler(400, 'beta')
  const m = buildAnchorMap(x, y)
  const xi = x.indexOf('THE MIDDLE MARKER'), yi = y.indexOf('THE MIDDLE MARKER')
  // Within one anchor step (100 characters) of the insertion the map may lag; further on it is exact.
  assert.ok(Math.abs(mapOffset(m, xi + 5) - (yi + 5)) <= 25)
  assert.equal(mapOffset(m, xi + 400), yi + 400)
  assert.equal(mapOffset(m, 10), 10)
  assert.equal(buildAnchorMap(x, x), IDENTITY_MAP)
  assert.equal(mapOffset(IDENTITY_MAP, 1234), 1234)
})

test('matchOneWay: tier 1 by quote, tier 2 by passage plus meaning, same-passage miss, far-away unmatched', () => {
  const P = [
    ins('p1', { statement: 'Small habits compound over time.', quote: 'small habits compound into remarkable results over a long stretch of time', span: [100, 175] }),
    ins('p2', { statement: 'Identity drives lasting behavior change.', quote: 'identity first then the behavior follows', span: [1000, 1040] }),
    ins('p3', { statement: 'Sleep needs a consistent wake time.', quote: 'a consistent wake time anchors the body clock', span: [2000, 2045] }),
    ins('p4', { statement: 'Caffeine delays adenosine clearance.', quote: 'caffeine blocks adenosine receptors', span: [5000, 5036] }),
  ]
  const Q = [
    ins('q1', { statement: 'Habits compound.', quote: 'Small habits compound into remarkable results over a long stretch', span: [90, 160] }), // tier 1 with p1
    ins('q2', { statement: 'Identity drives lasting behavior change in people.', quote: 'you decide who you want to be first', span: [1200, 1235] }), // same passage as p2 (gap 160), similar statement
    ins('q3', { statement: 'Cold exposure raises dopamine.', quote: 'a long cold plunge raises dopamine for hours afterwards', span: [2100, 2150] }), // same passage as p3, different meaning
  ]
  const rows = matchOneWay(P, Q, { qToP: n => n, sim: (x, y) => lexicalSim(x.statement, y.statement), simThreshold: 0.5 })
  assert.deepEqual(rows.map(r => [r.matched, r.tier]), [[true, 1], [true, 2], [false, 0], [false, 0]])
  assert.equal(rows[0].partner, 'q1')
  assert.equal(rows[1].partner, 'q2')
  assert.ok(rows[2].samePassage && !rows[3].samePassage, 'p3 has a same-passage miss, p4 has no counterpart passage at all')
  const d = summariseDirection(P, rows)
  assert.equal(d.passSpecific, 2)
  assert.equal(d.passSpecificRate, 0.5)
  assert.equal(d.samePassageMiss, 1)
  assert.equal(d.tier1, 1)
  assert.equal(d.tier2, 1)
})

test('matchOneWay maps the other copy through the offset map before the passage test', () => {
  const P = [ins('p', { statement: 'Protein timing matters little.', quote: null, span: [1000, 1050] })]
  const Q = [ins('q', { statement: 'Protein timing matters little overall.', quote: null, span: [1040, 1090] })]
  const shifted = matchOneWay(P, Q, { qToP: n => n + 5000, sim: (x, y) => lexicalSim(x.statement, y.statement), simThreshold: 0.5 })
  assert.equal(shifted[0].matched, false, 'after mapping, the spans are 5,000 characters apart')
  const aligned = matchOneWay(P, Q, { qToP: n => n, sim: (x, y) => lexicalSim(x.statement, y.statement), simThreshold: 0.5 })
  assert.equal(aligned[0].matched, true)
})

test('boundary share: edge zone is the first or last 300 characters; an unlocated quote is skipped', () => {
  assert.equal(inEdgeZone({ relStart: 10, relEnd: 80, chunkLen: 2400 }), true)
  assert.equal(inEdgeZone({ relStart: 1000, relEnd: 1100, chunkLen: 2400 }), false)
  assert.equal(inEdgeZone({ relStart: 2200, relEnd: 2300, chunkLen: 2400 }), true)
  assert.equal(inEdgeZone({ relStart: -50, relEnd: 40, chunkLen: 2400 }), true, 'a quote that starts in the context counts as at the edge')
  assert.equal(inEdgeZone({ relStart: null, relEnd: null, chunkLen: 2400 }), null)
  const P = [
    ins('a', { statement: 's', relStart: 10, relEnd: 50 }), ins('b', { statement: 's', relStart: 900, relEnd: 950 }),
    ins('c', { statement: 's', relStart: 5, relEnd: 40 }), ins('d', { statement: 's', relStart: 1000, relEnd: 1100 }),
  ]
  const rows = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, matched: i % 2 === 1, tier: 0 as const, partner: null, samePassage: false, bestSim: null, passagePartner: null }))
  const d = summariseDirection(P, rows)
  assert.equal(d.boundary.unmatched, 1) // a and c are unmatched and both at an edge
  assert.equal(d.boundary.matched, 0)
})

test('within-pass duplicates: a later insight that repeats an earlier quote is counted, split by chunk', () => {
  const q = 'the most important thing about habits is that they compound over time'
  const P = [
    ins('a', { statement: 's', chunk: 0, quote: q }),
    ins('b', { statement: 's', chunk: 0, quote: q + ' for everyone' }),
    ins('c', { statement: 's', chunk: 1, quote: q }),
    ins('d', { statement: 's', chunk: 1, quote: 'completely different words about sleep and the circadian clock here' }),
  ]
  assert.deepEqual(withinPassDuplicates(P), { total: 2, sameChunk: 1, crossChunk: 1, identical: 1 })
})

test('coverage and disagreement over bins', () => {
  const bins = fixedBins(2000, 500)
  const a = coverage([[10, 20], [600, 620], [1500, 1520]], bins)
  const b = coverage([[30, 40], [1100, 1110], [1510, 1530]], bins)
  assert.deepEqual([...a].sort(), [0, 1, 3])
  assert.deepEqual([...b].sort(), [0, 2, 3])
  const d = disagreement(a, b)
  assert.deepEqual([d.onlyA, d.onlyB, d.union], [1, 1, 4])
  assert.equal(d.rate, 0.5)
  assert.deepEqual(coverage([[480, 520]], bins), new Set([0, 1]))
})

test('applyRemovals matches the hygiene result and docToRaw lands back on the raw text', () => {
  const raw = 'Intro text here. This episode is brought to you by Acme, use code X. Back to the science: sleep matters a lot.'
  const s = raw.indexOf('This episode'), e = raw.indexOf('use code X.') + 'use code X.'.length
  const doc = applyRemovals(raw, [{ start: s, end: e }])
  assert.equal(doc.text, 'Intro text here. Back to the science: sleep matters a lot.')
  const at = doc.text.indexOf('sleep matters')
  assert.equal(raw.slice(docToRaw(doc, at), docToRaw(doc, at) + 13), 'sleep matters')
  const first = doc.text.indexOf('text here')
  assert.equal(raw.slice(docToRaw(doc, first), docToRaw(doc, first) + 9), 'text here')
  assert.equal(docToRaw(identityDoc(raw), 17), 17)
})

const SEG = (text: string) => ({ text })
function fixture() {
  const segs = [
    SEG('Peter Attia: Welcome to the show today.'), SEG('Thanks for having me on the show.'),
    SEG('Peter Attia: Tell me about habits.'),
    // a long turn of ten ~300-character utterances (some end in a sentence, some do not)
    ...Array.from({ length: 10 }, (_, i) => SEG(`${i === 0 ? 'James Clear: ' : ''}${'word '.repeat(55).trim()} number${i}${i % 2 ? '' : '.'}`)),
    SEG('Peter Attia: Great. Thank you.'),
  ]
  const raw = segs.map(s => s.text).join(' ')
  return { segs, raw, units: segmentUnits(segs, raw) }
}

test('segmentUnits places utterances in the transcript and marks turn starts', () => {
  const { raw, units } = fixture()
  assert.ok(units.every(u => raw.slice(u.rawStart, u.rawEnd) === u.text))
  assert.deepEqual(units.filter(u => u.turnStart).map(u => u.text.slice(0, 11)), ['Peter Attia', 'Peter Attia', 'James Clear', 'Peter Attia'])
  assert.throws(() => segmentUnits([SEG('a')], 'b'))
})

test('chunkTurns: every utterance lands in exactly one chunk, in order, none over the target, long turns split at sentence ends', () => {
  const { units } = fixture()
  const chunks = chunkTurns(units, 1000, 400)
  assert.equal(chunks[0].first, 0)
  assert.equal(chunks[chunks.length - 1].last, units.length - 1)
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].first, chunks[i - 1].last + 1, 'no gap, no overlap')
  const size = (c: { first: number; last: number }) => units.slice(c.first, c.last + 1).reduce((n, u) => n + u.text.length, 0) + (c.last - c.first)
  for (const c of chunks) assert.ok(size(c) <= 1000, `chunk too long: ${size(c)}`)
  // Each chunk that ends inside a long turn ends on a sentence end where one was available in the window.
  const mid = chunks.slice(0, -1).filter(c => !units[c.last + 1].turnStart)
  assert.ok(mid.length > 0)
  assert.ok(mid.every(c => /\.$/.test(units[c.last].text)), 'cuts inside a turn land after a sentence end')
  // Deterministic: the same input gives the same chunks.
  assert.deepEqual(chunkTurns(units, 1000, 400), chunks)
})

test('chunkTurns packs short whole turns together, and a roomy target keeps the long turn whole', () => {
  const { units } = fixture()
  const chunks = chunkTurns(units, 2400, 600)
  assert.equal(chunks[0].first, 0)
  assert.ok(chunks[0].last >= 2, 'the three short opening utterances share a chunk')
  assert.deepEqual(chunkTurns(units, 5000, 600), [{ first: 0, last: units.length - 1 }])
})

test('keepUnits drops utterances mostly inside a removed range; docFromUnits maps back exactly', () => {
  const { units } = fixture()
  const drop = [{ start: units[1].rawStart - 3, end: units[1].rawEnd + 2 }]
  const kept = keepUnits(units, drop)
  assert.equal(kept.length, units.length - 1)
  const { doc, unitDocStart } = docFromUnits(kept)
  kept.forEach((u, i) => assert.equal(docToRaw(doc, unitDocStart[i] + 3), u.rawStart + 3))
})

test('contextWindow trims to word boundaries and never moves inside the chunk', () => {
  const doc = 'one two three four five six seven eight nine ten eleven twelve'
  const start = doc.indexOf('five'), end = doc.indexOf('eight')
  const w = contextWindow(doc, start, end, 10)
  assert.equal(doc.slice(w.from, w.to), 'four five six seven eight nine')
  assert.deepEqual(contextWindow(doc, start, end, 0), { from: start, to: end })
  const edge = contextWindow(doc, 0, 7, 400)
  assert.deepEqual(edge, { from: 0, to: doc.length })
})

test('lexicalSim: paraphrases score above unrelated statements', () => {
  assert.ok(lexicalSim('Identity drives lasting behavior change.', 'Lasting behavior change is driven by identity.') > 0.5)
  assert.ok(lexicalSim('Identity drives lasting behavior change.', 'Cold exposure raises dopamine.') < 0.2)
  const u: Unit[] = []
  assert.deepEqual(turnBins(u, 100), fixedBins(100))
})
