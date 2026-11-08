/** Repair of quarantined claims (lib/claimRepair.ts, lib/repairRules.ts, lib/repairFlags.ts). Pure: no database, no model. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  repairClaim, stakesTier, orderCandidates, stratifiedSample, guardRewrite, memberCandidates, pickSeed, lostNumbers, tooNarrowToAdopt, narrowMembersSkipped, MIN_ADOPT_LENGTH_RATIO,
  type MemberPassage, type RepairDeps, type RepairInput, type Candidate,
} from '../lib/claimRepair'
import { parseRewrite, buildRepairUser, REPAIR_SYSTEM, REPAIR_RULES } from '../lib/repairRules'
import { flagFacts, flagNote, resolutionFor, originalDetail } from '../lib/repairFlags'
import { statusAfterResolution } from '../lib/claimGate'
import type { FidelityResult } from '../lib/extractionFidelity'

const FAITHFUL: FidelityResult = { verdict: 'FAITHFUL', offending: '', reasoning: 'ok' }
const ADDED: FidelityResult = { verdict: 'ADDED_DETAIL', offending: 'x', reasoning: 'adds a thing' }

const member = (id: string, statement: string, chunk: string, matchedBy = 'auto'): MemberPassage => ({
  rawInsightId: id, matchedBy, statement, contextNote: null, directQuote: null, chunk,
})
const input = (claim: string, members: MemberPassage[]): RepairInput => ({
  claimId: 'c1', claim, claimContextNote: null,
  flag: { verdict: 'ADDED_DETAIL', offending: 'x', reasoning: 'adds a thing' }, members,
})

/** Deps whose judge answers by looking the statement up, and whose rewrite replays a script. */
function deps(judged: Record<string, FidelityResult>, rewrites: Array<Parameters<typeof parseRewrite>[0]> = []): RepairDeps & { judgeCalls: string[]; rewriteCalls: number } {
  const d = {
    judgeCalls: [] as string[], rewriteCalls: 0,
    judge: async (s: string) => { d.judgeCalls.push(s); return judged[s] ?? ADDED },
    rewrite: async () => parseRewrite(rewrites[d.rewriteCalls++]),
  }
  return d
}

test('a rewrite that passes the judge repairs the claim', async () => {
  const chunk = 'I think magnesium may help some people sleep a bit better.'
  const d = deps({ 'Magnesium may help some people sleep better.': FAITHFUL }, [
    { action: 'rewrite', statement: 'Magnesium may help some people sleep better.', changes: 'kept the hedge' },
  ])
  const r = await repairClaim(input('Magnesium glycinate improves sleep.', [member('m1', 'Magnesium glycinate improves sleep.', chunk, 'seed')]), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.source, 'rewrite')
  assert.equal(r.newStatement, 'Magnesium may help some people sleep better.')
})

test('another member that is faithful to its own passage is adopted verbatim, with no rewrite call', async () => {
  const seed = member('m1', 'Zone 2 for 200 minutes a week.', 'Zone 2 is useful.', 'seed')
  const other = member('m2', 'Zone 2 training is useful.', 'Zone 2 is useful, I would do some.')
  const d = deps({ 'Zone 2 training is useful.': FAITHFUL })
  const r = await repairClaim(input('Zone 2 for 200 minutes a week.', [seed, other]), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.source, 'member')
  assert.equal(r.newStatement, 'Zone 2 training is useful.')
  assert.equal(r.memberRawInsightId, 'm2')
  assert.equal(d.rewriteCalls, 0)
})

test('option B: a member much shorter than the claim is not judged or adopted; the rewrite runs and the skip is recorded', async () => {
  const long = 'Protein quality is measured by DIAAS, which reflects amino acid content and digestibility; animal sources score above 100 and many plant sources score lower, so mixing plant proteins can close the gap.'
  const seed = member('m1', 'Seed wording adds a thing.', 'Protein quality passage.', 'seed')
  const short = member('m2', 'Plant foods are less digestible.', 'Plant foods are less digestible, he said.')
  const d = deps({ 'Protein quality is measured by DIAAS, which reflects digestibility.': FAITHFUL }, [
    { action: 'rewrite', statement: 'Protein quality is measured by DIAAS, which reflects digestibility.', changes: 'kept the measure' },
  ])
  const r = await repairClaim(input(long, [seed, short]), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.source, 'rewrite')
  assert.ok(!d.judgeCalls.includes('Plant foods are less digestible.'))
  const skipped = r.attempts.filter(a => a.kind === 'member_skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].rawInsightId, 'm2')
  assert.match(skipped[0].guard ?? '', /narrow/)
})

test('option B: a member close in length to the claim is still adopted', () => {
  const claim = 'Zone 2 training is useful for building aerobic base.'
  assert.equal(tooNarrowToAdopt('Zone 2 training builds aerobic base.', claim), false)
  assert.equal(tooNarrowToAdopt('Zone 2 helps.', claim), true)
  // the cutoff is inclusive of exactly the ratio
  assert.equal(tooNarrowToAdopt('x'.repeat(MIN_ADOPT_LENGTH_RATIO * 100), 'y'.repeat(100)), false)
})

test('option B: narrow members do not use up the tries and are listed separately', () => {
  const seed = member('s', 'Sleep needs seven hours and good light exposure each morning.', 'c', 'seed')
  const claim = 'Sleep needs seven hours and good light exposure each morning.'
  const ms = [seed, member('n', 'Sleep matters.', 'c'), member('a', 'Sleep needs about seven hours and morning light exposure.', 'c')]
  assert.deepEqual(memberCandidates(input(claim, ms), seed).map(m => m.rawInsightId), ['a'])
  assert.deepEqual(narrowMembersSkipped(input(claim, ms), seed).map(m => m.rawInsightId), ['n'])
})

test('a canonical that already passes against the seed passage is left alone', async () => {
  const seed = member('m1', 'Seed wording adds a dose of 500 mg.', 'He said take some.', 'seed')
  const d = deps({ 'Take some.': FAITHFUL })
  const r = await repairClaim(input('Take some.', [seed, member('m2', 'Other', 'chunk 2')]), d)
  assert.equal(r.outcome, 'canonical_ok')
  assert.equal(r.newStatement, null)
  assert.equal(d.rewriteCalls, 0)
})

test('a single-member claim whose wording equals the seed skips the canonical check', async () => {
  const d = deps({}, [{ action: 'cannot_repair', reason: 'nothing supportable' }])
  await repairClaim(input('Same words.', [member('m1', 'Same words.', 'chunk', 'seed')]), d)
  assert.deepEqual(d.judgeCalls, [])
})

test('two rewrites that fail the judge leave the claim hidden', async () => {
  const chunk = 'Some people do better with it.'
  const d = deps({}, [
    { action: 'rewrite', statement: 'Everyone does better with it.' },
    { action: 'rewrite', statement: 'Most people do better with it.' },
  ])
  const r = await repairClaim(input('All people do better with it.', [member('m1', 'All people do better with it.', chunk, 'seed')]), d)
  assert.equal(r.outcome, 'failed')
  assert.equal(d.rewriteCalls, 2)
  assert.equal(r.newStatement, null)
})

test('the second rewrite is told why the first one was rejected', async () => {
  const seen: string[] = []
  const rewriteSeen: RepairDeps['rewrite'] = async req => { seen.push(req.priorRejection?.why ?? '(none)'); return { action: 'rewrite', statement: `try number ${['one','two'][seen.length-1]}`, changes: '', reason: '' } }
  await repairClaim(input('Old wording.', [member('m1', 'Old wording.', 'chunk', 'seed')]), { judge: async () => ADDED, rewrite: rewriteSeen })
  assert.equal(seen[0], '(none)')
  assert.match(seen[1], /ADDED_DETAIL/)
})

test('a rewrite that invents a number is rejected before the judge sees it', async () => {
  const chunk = 'Take some magnesium before bed.'
  const d = deps({ 'Take magnesium before bed.': FAITHFUL }, [
    { action: 'rewrite', statement: 'Take 400 mg of magnesium before bed.' },
    { action: 'rewrite', statement: 'Take magnesium before bed.' },
  ])
  const r = await repairClaim(input('Take 400 mg of magnesium glycinate before bed.', [member('m1', 'Take 400 mg of magnesium glycinate before bed.', chunk, 'seed')]), d)
  assert.equal(r.outcome, 'repaired')
  assert.ok(!d.judgeCalls.includes('Take 400 mg of magnesium before bed.'))
  assert.match(r.attempts[0].guard ?? '', /400/)
})

test('needs_video and cannot_repair stop the claim without a judge call on a rewrite', async () => {
  const m = [member('m1', 'As shown, it works.', 'as you can see on this slide', 'seed')]
  const v = await repairClaim(input('As shown, it works.', m), deps({}, [{ action: 'needs_video', reason: 'depends on the slide' }]))
  assert.equal(v.outcome, 'needs_video')
  assert.match(v.note, /slide/)
  const c = await repairClaim(input('As shown, it works.', m), deps({}, [{ action: 'cannot_repair', reason: 'nothing' }]))
  assert.equal(c.outcome, 'cannot_repair')
})

test('a model refusal becomes an outcome on that claim; a usage limit still stops the run', async () => {
  const refusal = Object.assign(new Error('declined'), { name: 'ModelRefusalError' })
  const m = [member('m1', 'A claim.', 'chunk', 'seed')]
  const r = await repairClaim(input('A claim.', m), { judge: async () => ADDED, rewrite: async () => { throw refusal } })
  assert.equal(r.outcome, 'refused')
  await assert.rejects(repairClaim(input('A claim.', m), { judge: async () => ADDED, rewrite: async () => { throw new Error('usage limit reached') } }), /usage limit/)
})

test('a judge transport failure is an error outcome, not a verdict', async () => {
  const bad: FidelityResult = { verdict: 'UNSURE', offending: '', reasoning: 'error: timeout' }
  const r = await repairClaim(input('A claim.', [member('m1', 'A claim.', 'chunk', 'seed'), member('m2', 'Other wording.', 'c2')]), {
    judge: async () => bad, rewrite: async () => parseRewrite({ action: 'cannot_repair' }),
  })
  assert.equal(r.outcome, 'error')
})

test('a claim with no passage cannot be repaired', async () => {
  const r = await repairClaim(input('A claim.', [member('m1', 'A claim.', '', 'seed')]), deps({}))
  assert.equal(r.outcome, 'cannot_repair')
})

test('UNSURE does not pass: only FAITHFUL does', async () => {
  const unsure: FidelityResult = { verdict: 'UNSURE', offending: '', reasoning: 'close call' }
  const r = await repairClaim(input('Old.', [member('m1', 'Old.', 'chunk', 'seed')]), {
    judge: async () => unsure,
    rewrite: async () => parseRewrite({ action: 'rewrite', statement: 'New wording.' }),
  })
  assert.equal(r.outcome, 'failed')
})

test('member candidates: closest first, capped, never the seed or a copy of the claim', () => {
  const seed = member('s', 'Sleep needs seven hours.', 'c', 'seed')
  const ms = [
    seed,
    member('a', 'Sleep needs seven hours.', 'c'),
    member('b', 'People need sleep.', 'c'),
    member('c', 'Seven hours of sleep is needed by adults.', 'c'),
    member('d', 'Unrelated text about squats.', 'c'),
    member('e', 'Sleep needs about seven hours a night.', 'c'),
    member('f', 'No passage here.', ''),
  ]
  const got = memberCandidates(input('Sleep needs seven hours.', ms), seed).map(m => m.rawInsightId)
  assert.equal(got.length, 3)
  assert.ok(!got.includes('s') && !got.includes('a') && !got.includes('f'))
  assert.equal(got[0], 'e')
})

test('pickSeed prefers the seed member and ignores members with no passage', () => {
  assert.equal(pickSeed([member('a', 's', 'c'), member('b', 's', 'c', 'seed')])?.rawInsightId, 'b')
  assert.equal(pickSeed([member('a', 's', ''), member('b', 's', 'c')])?.rawInsightId, 'b')
  assert.equal(pickSeed([member('a', 's', '')]), null)
})

test('guardRewrite: empty, unchanged, over-long and invented numbers are rejected', () => {
  const chunk = 'about ten minutes of walking'
  assert.match(guardRewrite('', 'x', [chunk]) ?? '', /empty/)
  assert.match(guardRewrite('Walk ten minutes.', 'walk ten minutes', [chunk]) ?? '', /same wording/)
  assert.match(guardRewrite('x'.repeat(800), 'y', [chunk]) ?? '', /limit/)
  assert.match(guardRewrite('Walk 30 minutes.', 'y', [chunk]) ?? '', /30/)
  assert.equal(guardRewrite('Walk about ten minutes.', 'y', [chunk]), null)
})

test('lostNumbers reports a number the passage and the old wording had that the rewrite dropped', () => {
  assert.deepEqual(lostNumbers('Take 5 mg at night.', 'take 5 mg before bed', 'Take it at night.'), ['5'])
  assert.deepEqual(lostNumbers('Take 5 mg at night.', 'take some before bed', 'Take it at night.'), [])
})

test('stakes: numbers and doses first, then cause-and-effect, then the rest', () => {
  assert.equal(stakesTier('Take 400 mg nightly.'), 0)
  assert.equal(stakesTier('It cuts risk by half.'), 0)
  assert.equal(stakesTier('Statins reduce cardiovascular events.'), 1)
  assert.equal(stakesTier('Sleep matters.', 'raises cortisol'), 1)
  assert.equal(stakesTier('Sleep matters to athletes.'), 2)
})

const cand = (id: string, claim: string, verdict: string, members: number, at = '2026-01-01'): Candidate => ({
  claimId: id, claim, verdict, offending: '', memberCount: members, createdAt: at,
})

test('orderCandidates: high stakes first, ties by created time then id, input untouched', () => {
  const input = [cand('d', 'Plain.', 'ADDED_DETAIL', 1), cand('c', 'Causes harm.', 'ADDED_DETAIL', 1), cand('b', 'Take 5 mg.', 'ADDED_DETAIL', 1, '2026-02-01'), cand('a', 'Take 9 mg.', 'ADDED_DETAIL', 1)]
  const copy = input.slice()
  assert.deepEqual(orderCandidates(input).map(c => c.claimId), ['a', 'b', 'c', 'd'])
  assert.deepEqual(input, copy)
})

test('stratifiedSample: a small sample covers both verdicts and both member shapes', () => {
  const all: Candidate[] = []
  for (let i = 0; i < 30; i++) all.push(cand(`ad${i}`, 'Take 5 mg.', 'ADDED_DETAIL', 1))
  for (let i = 0; i < 10; i++) all.push(cand(`adm${i}`, 'Take 5 mg.', 'ADDED_DETAIL', 3))
  for (let i = 0; i < 10; i++) all.push(cand(`dq${i}`, 'Plain.', 'DROPPED_QUALIFIER', 1))
  for (let i = 0; i < 2; i++) all.push(cand(`dqm${i}`, 'Plain.', 'DROPPED_QUALIFIER', 2))
  const got = stratifiedSample(orderCandidates(all), 20)
  assert.equal(got.length, 20)
  assert.equal(new Set(got.map(g => g.claimId)).size, 20)
  assert.ok(got.some(g => g.verdict === 'ADDED_DETAIL' && g.memberCount > 1))
  assert.ok(got.some(g => g.verdict === 'DROPPED_QUALIFIER' && g.memberCount === 1))
  assert.ok(got.some(g => g.verdict === 'DROPPED_QUALIFIER' && g.memberCount > 1))
  assert.equal(stratifiedSample(all, 100).length, all.length)
  assert.deepEqual(stratifiedSample(all, 0), [])
})

test('parseRewrite: unknown action or empty rewrite is cannot_repair, never a guess', () => {
  assert.equal(parseRewrite({ action: 'rewrite', statement: ' New. ' }).statement, 'New.')
  assert.equal(parseRewrite({ action: 'rewrite', statement: '' }).action, 'cannot_repair')
  assert.equal(parseRewrite({ action: 'delete' }).action, 'cannot_repair')
  assert.equal(parseRewrite(null).action, 'cannot_repair')
  assert.equal(parseRewrite({ action: 'needs_video', statement: 'ignored', reason: 'slide' }).statement, '')
})

test('the prompt carries Paul\'s rules, the verdict, and the prior rejection', () => {
  for (const phrase of ['very high', 'if ... then', 'more common outside the US', 'half-said sentence', 'one drug', 'only visible on screen']) {
    assert.ok(REPAIR_RULES.includes(phrase), phrase)
  }
  assert.ok(REPAIR_SYSTEM.includes(REPAIR_RULES))
  const u = buildRepairUser({
    passage: 'PASSAGE-TEXT', claim: 'CLAIM-TEXT', claimContextNote: null,
    insight: { statement: 'INSIGHT-TEXT', contextNote: null, directQuote: null },
    verdict: { verdict: 'DROPPED_QUALIFIER', offending: 'OFFENDING', reasoning: 'REASON' },
    priorRejection: { statement: 'PRIOR', why: 'WHY' },
  })
  for (const s of ['PASSAGE-TEXT', 'CLAIM-TEXT', 'INSIGHT-TEXT', 'DROPPED_QUALIFIER', 'OFFENDING', 'REASON', 'PRIOR', 'WHY']) assert.ok(u.includes(s), s)
})

test('flag facts come from evidence and detail, even after the tool annotated the flag', () => {
  const flag = { detail: 'ADDED_DETAIL: invents a dose', evidence: { verdict: 'ADDED_DETAIL', offending: '500 mg', statement: 's' } }
  assert.deepEqual(flagFacts(flag), { verdict: 'ADDED_DETAIL', offending: '500 mg', reasoning: 'invents a dose' })
  const note = flagNote('needs_video', 'depends on a slide', flag)!
  assert.match(note.detail, /^NEEDS VIDEO CHECK: depends on a slide \(flagged as ADDED_DETAIL: invents a dose\)$/)
  const annotated = { detail: note.detail, evidence: { ...flag.evidence, repair: { original_detail: flag.detail } } }
  assert.equal(originalDetail(annotated), 'ADDED_DETAIL: invents a dose')
  assert.deepEqual(flagFacts(annotated), flagFacts(flag))
})

test('only the two put-back outcomes resolve a flag, and the gate then restores the claim', () => {
  assert.equal(resolutionFor('repaired'), 'reworded')
  assert.equal(resolutionFor('canonical_ok'), 'false_positive')
  for (const o of ['failed', 'needs_video', 'cannot_repair', 'refused', 'error'] as const) assert.equal(resolutionFor(o), null)
  assert.equal(statusAfterResolution('flagged', 'extraction_fidelity', resolutionFor('repaired')!), 'active')
  assert.equal(statusAfterResolution('flagged', 'extraction_fidelity', resolutionFor('canonical_ok')!), 'active')
  assert.equal(flagNote('repaired', 'x', { detail: null, evidence: null }), null)
})
