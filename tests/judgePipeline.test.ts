/**
 * lib/judgePipeline.ts — judging several facts of one source at once must write
 * exactly what the one-at-a-time loop writes. The fake library below has the two
 * ways an earlier write can change what a later fact should be judged against:
 * a new claim appearing in its neighbourhood, and an existing claim's canonical
 * being rewritten (enrich-merge).
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runOrdered, candidateSignature, type CandidateLike } from '../lib/judgePipeline'

type Fact = { id: string; topic: string; text: string; enrich?: boolean }
type Claim = CandidateLike & { topic: string; members: string[] }
type Verdict = { verdict: 'SAME' | 'DIFFERENT'; index: number; enrich: boolean }

class FakeLibrary {
  claims: Claim[] = []
  judgeLog: string[] = []
  constructor(seed: { id: string; topic: string; text: string }[] = []) {
    for (const s of seed) this.claims.push({ id: s.id, topic: s.topic, canonical_statement: s.text, context_note: null, members: [] })
  }
  async search(f: Fact): Promise<Claim[]> {
    await tick(1)
    return this.claims.filter(c => c.topic === f.topic)
  }
  // A deterministic judge that reads only what the real one reads: the statement and
  // the candidate list. SAME when a candidate's canonical contains the fact's text.
  async judge(f: Fact, cands: CandidateLike[], delay: number): Promise<Verdict> {
    this.judgeLog.push(`${f.id}|${candidateSignature(cands)}`) // logged at call start, so the last entry per fact is the call whose verdict was used
    await tick(delay)
    const i = cands.findIndex(c => c.canonical_statement.includes(f.text))
    return i >= 0 ? { verdict: 'SAME', index: i, enrich: !!f.enrich } : { verdict: 'DIFFERENT', index: -1, enrich: false }
  }
  async apply(f: Fact, cands: Claim[] | null, v: Verdict | null): Promise<void> {
    await tick(1)
    if (cands === null) return
    if (v && v.verdict === 'SAME') {
      const c = cands[v.index]
      c.members.push(f.id)
      if (v.enrich) c.canonical_statement += ` +${f.id}`
    } else {
      this.claims.push({ id: `c-${f.id}`, topic: f.topic, canonical_statement: f.text, context_note: null, members: [f.id] })
    }
  }
  state(): string {
    return JSON.stringify(this.claims.map(c => [c.id, c.canonical_statement, c.members]))
  }
}

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

async function run(facts: Fact[], seed: { id: string; topic: string; text: string }[], concurrency: number, delays: (f: Fact) => number) {
  const lib = new FakeLibrary(seed)
  const out = await runOrdered<Fact, Claim, Verdict>(facts, {
    concurrency,
    search: f => (f.text === 'NOVEC' ? Promise.resolve(null) : lib.search(f)),
    judge: (f, c) => lib.judge(f, c, delays(f)),
    apply: (f, c, v) => lib.apply(f, c, v),
  })
  return { lib, ...out }
}

test('a fact with no candidates is applied unjudged; a missing vector is skipped', async () => {
  const { lib, stats, applied } = await run(
    [{ id: 'a', topic: 't', text: 'x' }, { id: 'n', topic: 't', text: 'NOVEC' }],
    [], 4, () => 5
  )
  assert.equal(applied, 2)
  assert.equal(stats.unjudged, 1)
  assert.equal(lib.claims.length, 1)
  assert.equal(lib.judgeLog.length, 0)
})

test('two near-identical facts judged together: the second sees the first one\'s claim', async () => {
  // Sequentially: a1 has no candidates -> new claim; a2 is judged against that claim -> SAME.
  // Naively in parallel a2 would also be judged against an empty library and become a second claim.
  const facts: Fact[] = [{ id: 'a1', topic: 't', text: 'protein' }, { id: 'a2', topic: 't', text: 'protein' }]
  const seq = await run(facts, [], 1, () => 5)
  const par = await run(facts, [], 4, () => 5)
  assert.equal(par.lib.state(), seq.lib.state())
  assert.equal(par.lib.claims.length, 1)
  assert.deepEqual(par.lib.claims[0].members, ['a1', 'a2'])
})

test('a list changed by an earlier new claim makes the early verdict stale and re-judges', async () => {
  const seed = [{ id: 'c0', topic: 't', text: 'unrelated' }]
  const facts: Fact[] = [{ id: 'a1', topic: 't', text: 'zinc' }, { id: 'a2', topic: 't', text: 'zinc' }]
  const seq = await run(facts, seed, 1, () => 5)
  const par = await run(facts, seed, 4, () => 5)
  assert.equal(par.lib.state(), seq.lib.state())
  // a2 was first judged against [c0], then against [c0, c-a1] and merged there.
  assert.equal(par.stats.stale, 1)
  assert.deepEqual(par.lib.claims.find(c => c.id === 'c-a1')!.members, ['a1', 'a2'])
})

test('a canonical rewritten by enrich-merge makes the early verdict stale', async () => {
  const seed = [{ id: 'c0', topic: 't', text: 'base fact' }]
  const facts: Fact[] = [
    { id: 'a1', topic: 't', text: 'base fact', enrich: true }, // merges into c0 and rewrites it
    { id: 'a2', topic: 't', text: 'base fact' },               // judged early against the OLD c0 text
  ]
  const seq = await run(facts, seed, 1, () => 5)
  const par = await run(facts, seed, 4, () => 5)
  assert.equal(par.lib.state(), seq.lib.state())
  assert.equal(par.stats.stale, 1)
  assert.equal(par.stats.reused, 1) // a1's own early verdict was fine
})

test('property: concurrency never changes what is written, nor what the judge is shown', async () => {
  let seedN = 12345
  const rand = () => ((seedN = (seedN * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let trial = 0; trial < 60; trial++) {
    const topics = ['a', 'b', 'c']
    const texts = ['w', 'x', 'y', 'z']
    const seed = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({
      id: `s${i}`, topic: topics[Math.floor(rand() * 3)], text: texts[Math.floor(rand() * 4)],
    }))
    const facts: Fact[] = Array.from({ length: 4 + Math.floor(rand() * 10) }, (_, i) => ({
      id: `f${i}`, topic: topics[Math.floor(rand() * 3)], text: texts[Math.floor(rand() * 4)], enrich: rand() < 0.4,
    }))
    const delays = new Map(facts.map(f => [f.id, 1 + Math.floor(rand() * 20)]))
    const seq = await run(facts, seed, 1, f => delays.get(f.id)!)
    for (const w of [2, 4, 8]) {
      const par = await run(facts, seed, w, f => delays.get(f.id)!)
      assert.equal(par.lib.state(), seq.lib.state(), `trial ${trial}, concurrency ${w}`)
      // Every fact's FINAL judge call (the one whose verdict was used) saw the same list as sequentially.
      const last = (log: string[]) => {
        const m = new Map<string, string>()
        for (const l of log) m.set(l.split('|')[0], l)
        return [...m.values()].sort()
      }
      assert.deepEqual(last(par.lib.judgeLog), last(seq.lib.judgeLog), `trial ${trial}, concurrency ${w}: judge saw a different list`)
    }
  }
})

test('verdicts finish out of order but are still applied in order', async () => {
  const order: string[] = []
  const facts: Fact[] = [0, 1, 2, 3].map(i => ({ id: `f${i}`, topic: String(i), text: 't' }))
  await runOrdered<Fact, Claim, Verdict>(facts, {
    concurrency: 4,
    search: async () => [{ id: 'x', topic: '', canonical_statement: 'q', context_note: null, members: [] }],
    judge: async f => { await tick(f.id === 'f0' ? 40 : 2); return { verdict: 'DIFFERENT', index: -1, enrich: false } },
    apply: async f => { order.push(f.id) },
  })
  assert.deepEqual(order, ['f0', 'f1', 'f2', 'f3'])
})

test('out of time: stops before starting a new fact, but finishes the ones already in flight', async () => {
  const facts: Fact[] = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, topic: String(i), text: 't' }))
  let launched = 0
  const applied: string[] = []
  const r = await runOrdered<Fact, Claim, Verdict>(facts, {
    concurrency: 3,
    outOfTime: () => applied.length >= 4,
    canLaunch: () => applied.length < 2,
    search: async () => [{ id: 'x', topic: '', canonical_statement: 'q', context_note: null, members: [] }],
    judge: async () => { launched++; await tick(3); return { verdict: 'DIFFERENT', index: -1, enrich: false } },
    apply: async f => { applied.push(f.id) },
  })
  assert.equal(r.applied, applied.length)
  assert.ok(r.applied >= 4 && r.applied < 8)
  assert.ok(launched >= r.applied)
})

test('a judge failure surfaces at that fact; earlier facts were already written', async () => {
  const applied: string[] = []
  const facts: Fact[] = ['f0', 'f1', 'f2'].map(id => ({ id, topic: 't', text: 't' }))
  await assert.rejects(
    runOrdered<Fact, Claim, Verdict>(facts, {
      concurrency: 3,
      search: async () => [{ id: 'x', topic: '', canonical_statement: 'q', context_note: null, members: [] }],
      judge: async f => { await tick(2); if (f.id === 'f1') throw new Error('checker down'); return { verdict: 'DIFFERENT', index: -1, enrich: false } },
      apply: async f => { applied.push(f.id) },
    }),
    /checker down/
  )
  assert.deepEqual(applied, ['f0'])
})

test('a failed speculative search is retried fresh, not trusted', async () => {
  let calls = 0
  const applied: string[] = []
  await runOrdered<Fact, Claim, Verdict>([{ id: 'f0', topic: 't', text: 't' }], {
    concurrency: 2,
    search: async () => {
      calls++
      if (calls === 1) throw new Error('timeout')
      return []
    },
    judge: async () => ({ verdict: 'DIFFERENT', index: -1, enrich: false }),
    apply: async f => { applied.push(f.id) },
  }).catch(() => {})
  // The speculative search failed; the fresh one is the one the loop acts on.
  assert.ok(calls >= 2)
  assert.deepEqual(applied, ['f0'])
})
