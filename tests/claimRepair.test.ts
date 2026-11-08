/** Repair of quarantined claims (lib/claimRepair.ts, lib/repairRules.ts, lib/repairFlags.ts). Pure: no database, no model. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  repairClaim, stakesTier, orderCandidates, stratifiedSample, lostNumbers, splitUnits, joinUnits, passagesOf, rankPassages,
  searchGroups, accountedShare, guardUnitEdit, coverageGap, assignMembers,
  type MemberPassage, type RepairDeps, type RepairInput, type Candidate,
} from '../lib/claimRepair'
import { parseUnitRewrite, buildUnitUser, UNIT_REPAIR_SYSTEM, REPAIR_RULES, KEEP_RULE, parseDecompose, parseGroups, DECOMPOSE_SYSTEM, GROUP_SYSTEM } from '../lib/repairRules'
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

type Raw = Parameters<typeof parseUnitRewrite>[0]
type JudgeRule = (statement: string, chunk: string) => FidelityResult | undefined

/** Deps whose judge asks `rule` (default: ADDED_DETAIL) and whose rewrite replays a script. */
function deps(rule: JudgeRule, rewrites: Raw[] = []) {
  const d = {
    judged: [] as Array<{ statement: string; chunk: string }>, requests: [] as Array<Parameters<RepairDeps['rewrite']>[0]>, rewriteCalls: 0,
    judge: async (statement: string, chunk: string) => { d.judged.push({ statement, chunk }); return rule(statement, chunk) ?? ADDED },
    rewrite: async (req: Parameters<RepairDeps['rewrite']>[0]) => { d.requests.push(req); return parseUnitRewrite(rewrites[d.rewriteCalls++]) },
  }
  return d
}
const faithfulWhen = (...statements: string[]): JudgeRule => st => (statements.includes(st) ? FAITHFUL : undefined)

test('splitUnits is lossless, keeps abbreviations and decimals together, and splits a very long sentence at semicolons', () => {
  const claim = 'Dose was 0.5 g, e.g. in athletes. Dr. Lee reported it (n = 12). Second ok? Yes.'
  const units = splitUnits(claim)
  assert.equal(joinUnits(units), claim)
  assert.deepEqual(units.map(u => u.text), ['Dose was 0.5 g, e.g. in athletes.', 'Dr. Lee reported it (n = 12).', 'Second ok?', 'Yes.'])
  const long = `${'First clause is long and goes on. '.repeat(1).trim()} ${'alpha beta gamma '.repeat(15)}; ${'delta epsilon zeta '.repeat(15)}; short end.`
  const parts = splitUnits(long)
  assert.equal(joinUnits(parts), long.trim())
  assert.equal(parts.length, 3)
  assert.deepEqual(splitUnits('  '), [])
})

test('passages: members sharing a chunk share a passage; the most relevant passage ranks first', () => {
  const ms = [member('b', 'Squats build legs.', 'Squats build leg strength a lot.'), member('a', 'Squats help.', 'Squats build leg strength a lot.'), member('c', 'Sleep matters.', 'Seven hours of sleep matters.')]
  const ps = passagesOf(ms)
  assert.equal(ps.length, 2)
  assert.equal(ps[0].members.length, 2)
  assert.equal(rankPassages('Seven hours of sleep helps recovery.', ps)[0].text, 'Seven hours of sleep matters.')
  assert.deepEqual(searchGroups(Array.from({ length: 30 }, (_, i) => ({ index: i, text: `p${i}`, members: [] }))).map(g => g.length), [2, 3, 3, 3, 3, 3])
})

test('a claim whose every sentence is supported by some member passage is a false alarm and is not rewritten', async () => {
  const claim = 'Zone 2 builds aerobic base. It may lower insulin.'
  const ms = [member('m1', claim, 'Zone 2 builds aerobic base.', 'seed'), member('m2', 'Zone 2 may lower insulin.', 'He said it may lower insulin.')]
  const d = deps(faithfulWhen('Zone 2 builds aerobic base.', 'It may lower insulin.'))
  const r = await repairClaim(input(claim, ms), d)
  assert.equal(r.outcome, 'canonical_ok')
  assert.equal(r.source, 'unchanged')
  assert.equal(r.newStatement, null)
  assert.equal(d.rewriteCalls, 0)
  assert.deepEqual(r.ledger.map(l => l.status), ['kept', 'kept'])
})

test('a sentence supported only by ANOTHER member\'s passage is kept word for word', async () => {
  const claim = 'The study followed people for 35 years. Yeast was part of it.'
  const ms = [member('m1', claim, 'Seed passage about something else entirely.', 'seed'), member('m2', 'The 35 year study.', 'A study followed people for 35 years. Yeast was included.')]
  const d = deps((st, chunk) => (chunk.includes('Yeast was included') ? FAITHFUL : undefined))
  const r = await repairClaim(input(claim, ms), d)
  assert.equal(r.outcome, 'canonical_ok')
  assert.equal(d.rewriteCalls, 0)
})

test('only the unsupported sentence is edited; supported sentences stay exactly as they were', async () => {
  const claim = 'Zone 2 builds aerobic base. It also lowers insulin by 40 percent. Walk daily.'
  const chunk = 'Zone 2 builds aerobic base. He said it may help insulin. Walk daily.'
  const d = deps(faithfulWhen('Zone 2 builds aerobic base.', 'Walk daily.', 'It also may lower insulin.'), [
    { action: 'rewrite', statement: 'It also may lower insulin.', removed: [{ fact: 'insulin falls by 40 percent', reason: 'no number was said' }], changes: 'hedged and dropped the number' },
  ])
  const r = await repairClaim(input(claim, [member('m1', claim, chunk, 'seed')]), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.source, 'rewrite')
  assert.equal(r.newStatement, 'Zone 2 builds aerobic base. It also may lower insulin. Walk daily.')
  assert.deepEqual(r.ledger.map(l => l.status), ['kept', 'edited', 'kept'])
  assert.equal(r.ledger[1].removed[0].searchedPassages, 1)
  assert.match(r.note, /2 of 3 facts kept as judged, 1 edited, 1 unsupported fact removed/)
  assert.equal(d.requests[0].unit, 'It also lowers insulin by 40 percent.')
  assert.equal(d.requests[0].claim, claim)
})

test('a removal is rejected when ANY passage supports the removed fact, and the second try keeps it', async () => {
  const claim = 'Walk daily. Yeast lengthened life in the study.'
  const ms = [member('m1', claim, 'Walk daily. He said yeast did something.', 'seed'), member('m2', 'Yeast lengthened life.', 'In the study yeast lengthened life clearly.')]
  const fact = 'yeast lengthened life in the study'
  const d = deps((st, chunk) => {
    if (st === 'Walk daily.') return FAITHFUL
    if (st === fact && chunk.includes('lengthened life clearly')) return FAITHFUL
    if (st === 'Yeast lengthened life in the study.') return undefined
    if (st === 'Yeast lengthened life in the study, as one speaker described.') return FAITHFUL
    return undefined
  }, [
    { action: 'remove', removed: [{ fact, reason: 'not in the seed passage' }], changes: 'removed it' },
    { action: 'rewrite', statement: 'Yeast lengthened life in the study, as one speaker described.', removed: [], changes: 'attributed' },
  ])
  const r = await repairClaim(input(claim, ms), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.newStatement, 'Walk daily. Yeast lengthened life in the study, as one speaker described.')
  assert.equal(d.requests.length, 2)
  assert.match(d.requests[1].priorRejection?.why ?? '', /a passage supports it/)
})

test('a removal is accepted only after every passage was searched and none supports the fact', async () => {
  const claim = 'Walk daily. It cures cancer.'
  const ms = [member('m1', claim, 'Walk daily.', 'seed'), member('m2', 'Walk.', 'Walking is good.'), member('m3', 'Steps.', 'Steps count.')]
  const d = deps(faithfulWhen('Walk daily.'), [{ action: 'remove', removed: [{ fact: 'it cures cancer', reason: 'never said' }], changes: 'removed' }])
  const r = await repairClaim(input(claim, ms), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.newStatement, 'Walk daily.')
  assert.equal(r.ledger[1].status, 'removed')
  assert.equal(r.ledger[1].removed[0].searchedPassages, 3)
  const removalChecks = r.attempts.filter(a => a.kind === 'removal_check')
  assert.equal(removalChecks.length, 2) // groups of 2 then 1: all three passages searched
})

test('a claim with a sentence nobody supports and nothing else supported has no repair', async () => {
  const claim = 'It cures cancer.'
  const d = deps(() => undefined, [{ action: 'remove', removed: [{ fact: 'it cures cancer', reason: 'never said' }], changes: 'removed' }])
  const r = await repairClaim(input(claim, [member('m1', claim, 'He talked about walking.', 'seed')]), d)
  assert.equal(r.outcome, 'cannot_repair')
})

test('guards: unaccounted wording, an invented number, an unchanged rewrite and an unlisted removal are rejected', () => {
  const unit = 'Statins lower LDL by 40 percent in adults over fifty.'
  assert.match(guardUnitEdit(parseUnitRewrite({ action: 'rewrite', statement: 'Statins lower LDL.' }), unit, ['statins lower ldl']) ?? '', /listed under "removed"/)
  assert.match(guardUnitEdit(parseUnitRewrite({ action: 'rewrite', statement: 'Statins lower LDL by 55 percent in adults over fifty.' }), unit, ['statins lower ldl by 40 percent in adults over fifty']) ?? '', /55/)
  assert.match(guardUnitEdit(parseUnitRewrite({ action: 'rewrite', statement: unit }), unit, [unit]) ?? '', /same wording/)
  assert.match(guardUnitEdit(parseUnitRewrite({ action: 'remove' }), unit, [unit]) ?? '', /without listing/)
  assert.equal(guardUnitEdit(parseUnitRewrite({ action: 'rewrite', statement: 'Statins may lower LDL in adults over fifty.', removed: [{ fact: 'by 40 percent', reason: 'not said' }] }), unit, ['statins may lower ldl in adults over fifty']), null)
  assert.ok(accountedShare('Statins lower cholesterol.', 'Statin lowers cholesterol.', []) === 1)
})

test('the safety net: a number that a passage and the old claim both state cannot be lost', async () => {
  const claim = 'Walk daily. It cut risk by 35 percent in the trial.'
  const chunk = 'Walk daily. The trial reported 35 percent.'
  const d = deps(faithfulWhen('Walk daily.'), [{ action: 'remove', removed: [{ fact: 'it cut risk by 35 percent in the trial', reason: 'wrongly judged unsupported' }], changes: 'removed' }])
  const r = await repairClaim(input(claim, [member('m1', claim, chunk, 'seed')]), d)
  assert.equal(r.outcome, 'failed')
  assert.deepEqual(r.droppedNumbers, ['35'])
  assert.equal(r.newStatement, null)
})

test('two failed attempts on a sentence leave the claim hidden, with the sentence marked unresolved', async () => {
  const claim = 'Walk daily. All people do better with it.'
  const d = deps(faithfulWhen('Walk daily.'), [
    { action: 'rewrite', statement: 'Everyone does better with it.', removed: [{ fact: 'all', reason: 'x' }], changes: '' },
    { action: 'rewrite', statement: 'Most people do better with it.', removed: [{ fact: 'all', reason: 'x' }], changes: '' },
  ])
  const r = await repairClaim(input(claim, [member('m1', claim, 'Walk daily. Some people do better.', 'seed')]), d)
  assert.equal(r.outcome, 'failed')
  assert.equal(d.rewriteCalls, 2)
  assert.equal(r.ledger.at(-1)?.status, 'unresolved')
  assert.match(r.note, /sentence 2 of 2/)
})

test('the second attempt is told why the first one was rejected', async () => {
  const claim = 'Old wording here.'
  const d = deps(() => undefined, [
    { action: 'rewrite', statement: 'Take number one wording here.', removed: [{ fact: 'old', reason: 'x' }] },
    { action: 'rewrite', statement: 'Take number two wording here.', removed: [{ fact: 'old', reason: 'x' }] },
  ])
  await repairClaim(input(claim, [member('m1', claim, 'chunk', 'seed')]), d)
  assert.equal(d.requests[0].priorRejection, null)
  assert.match(d.requests[1].priorRejection?.why ?? '', /ADDED_DETAIL/)
})

test('UNSURE is not support: a sentence the judge is unsure about goes to repair', async () => {
  const unsure: FidelityResult = { verdict: 'UNSURE', offending: '', reasoning: 'close call' }
  const claim = 'Sleep helps.'
  const d = deps(() => unsure, [{ action: 'rewrite', statement: 'Sleep may help.', removed: [] }])
  const r = await repairClaim(input(claim, [member('m1', claim, 'chunk', 'seed')]), d)
  assert.equal(d.rewriteCalls >= 1, true)
  assert.equal(r.outcome, 'failed')
})

test('needs_video stops the claim; a refusal becomes an outcome; a usage limit still stops the run', async () => {
  const claim = 'As shown, it works.'
  const m = [member('m1', claim, 'as you can see on this slide', 'seed')]
  const v = await repairClaim(input(claim, m), deps(() => undefined, [{ action: 'needs_video', reason: 'depends on the slide' }]))
  assert.equal(v.outcome, 'needs_video')
  assert.match(v.note, /slide/)
  const refusal = Object.assign(new Error('declined'), { name: 'ModelRefusalError' })
  const r = await repairClaim(input(claim, m), { judge: async () => ADDED, rewrite: async () => { throw refusal } })
  assert.equal(r.outcome, 'refused')
  await assert.rejects(repairClaim(input(claim, m), { judge: async () => ADDED, rewrite: async () => { throw new Error('usage limit reached') } }), /usage limit/)
})

test('a judge transport failure is an error outcome, not a verdict; no passage means cannot_repair', async () => {
  const bad: FidelityResult = { verdict: 'UNSURE', offending: '', reasoning: 'error: timeout' }
  const r = await repairClaim(input('A claim.', [member('m1', 'A claim.', 'chunk', 'seed')]), { judge: async () => bad, rewrite: async () => parseUnitRewrite(null) })
  assert.equal(r.outcome, 'error')
  const none = await repairClaim(input('A claim.', [member('m1', 'A claim.', '', 'seed')]), deps(() => undefined))
  assert.equal(none.outcome, 'cannot_repair')
})

test('lostNumbers reports a number the passages and the old wording had that the new wording dropped', () => {
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

test('parseUnitRewrite: an unknown action is a removal with nothing listed, never a guess', () => {
  assert.equal(parseUnitRewrite({ action: 'rewrite', statement: ' New. ' }).statement, 'New.')
  assert.equal(parseUnitRewrite({ action: 'delete' }).removed.length, 0)
  assert.equal(parseUnitRewrite(null).action, 'remove')
  assert.equal(parseUnitRewrite({ action: 'needs_video', statement: 'ignored', reason: 'slide' }).statement, '')
  assert.deepEqual(parseUnitRewrite({ action: 'remove', removed: [{ fact: ' a ', reason: 'b' }, { fact: '' }, 7] }).removed, [{ fact: 'a', reason: 'b' }])
})

test('the prompt carries Paul\'s rules, the keep-everything rule, the verdict and the prior rejection', () => {
  for (const phrase of ['very high', 'if ... then', 'more common outside the US', 'half-said sentence', 'one drug', 'only visible on screen', 'Never merge, shorten or generalise']) {
    assert.ok(REPAIR_RULES.includes(phrase), phrase)
  }
  assert.ok(UNIT_REPAIR_SYSTEM.includes(REPAIR_RULES))
  assert.ok(UNIT_REPAIR_SYSTEM.includes(KEEP_RULE))
  assert.match(KEEP_RULE, /ANY passage supports/)
  const u = buildUnitUser({
    unit: 'UNIT-TEXT', claim: 'CLAIM-TEXT', claimContextNote: null, passages: ['PASSAGE-ONE', 'PASSAGE-TWO'],
    verdict: { verdict: 'DROPPED_QUALIFIER', offending: 'OFFENDING', reasoning: 'REASON' },
    priorRejection: { statement: 'PRIOR', why: 'WHY' },
  })
  for (const s of ['UNIT-TEXT', 'CLAIM-TEXT', 'PASSAGE-ONE', 'PASSAGE-TWO', 'DROPPED_QUALIFIER', 'OFFENDING', 'REASON', 'PRIOR', 'WHY']) assert.ok(u.includes(s), s)
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

// ── Splitting a merged claim into several claims ────────────────

const CLAIM2 = 'Zone 2 builds aerobic base and lowers resting heart rate; sleep under six hours raises appetite, and a study followed 12 people for 35 years.'
const FACTS = ['Zone 2 builds aerobic base.', 'Zone 2 lowers resting heart rate.', 'Sleep under six hours raises appetite.', 'A study followed 12 people for 35 years.']
const splitMembers = () => [
  member('m1', 'Zone 2 builds aerobic base.', 'He said zone 2 builds aerobic base and lowers resting heart rate.'),
  member('m2', 'Zone 2 lowers resting heart rate.', 'zone 2 lowers resting heart rate, he said.'),
  member('m3', 'Sleep under six hours raises appetite.', 'Sleep under six hours raises appetite. A study followed 12 people for 35 years.'),
]

test('coverageGap: every number and 90% of the wording must survive, and nothing new may appear', () => {
  assert.equal(coverageGap(CLAIM2, FACTS), null)
  assert.match(coverageGap(CLAIM2, FACTS.slice(0, 3))!, /12/)
  assert.match(coverageGap(CLAIM2, [...FACTS, 'It also cuts risk by 40 percent.'])!, /40/)
  assert.match(coverageGap(CLAIM2, ['Zone 2 builds aerobic base. A study followed 12 people for 35 years.'])!, /wording/)
  assert.match(coverageGap(CLAIM2, [])!, /no facts/)
})

test('parseDecompose and parseGroups: groups must cover every fact exactly once', () => {
  assert.deepEqual(parseDecompose({ facts: [' a ', '', 3, 'b'] }), ['a', 'b'])
  assert.deepEqual(parseDecompose(null), [])
  assert.deepEqual(parseGroups({ groups: [[1, 0], [2]] }, 3), [[0, 1], [2]])
  assert.equal(parseGroups({ groups: [[0], [0, 1]] }, 2), null)
  assert.equal(parseGroups({ groups: [[0]] }, 2), null)
  assert.equal(parseGroups({ groups: [[0, 5]] }, 2), null)
  assert.equal(parseGroups({}, 2), null)
  assert.match(DECOMPOSE_SYSTEM, /Drop nothing|drop nothing/)
  assert.match(GROUP_SYSTEM, /do not rewrite/i)
})

test('assignMembers: each member goes to the group it fits best, no group is left without one, a spare member is lent', () => {
  const texts = ['Zone 2 builds aerobic base. Zone 2 lowers resting heart rate.', 'Sleep under six hours raises appetite.']
  const a = assignMembers(texts, splitMembers())
  assert.deepEqual(a.merged, [[0], [1]])
  assert.deepEqual(a.owner, [0, 0, 1])
  // second group nobody fits best: it borrows from a group with two members
  const b = assignMembers(['Zone 2 builds aerobic base.', 'Completely unrelated claim about yeast.'], [member('x', 'Zone 2 builds aerobic base.', 'p'), member('y', 'Zone 2 builds aerobic base.', 'p')])
  assert.equal(b.merged.length, 2)
  assert.equal(new Set(b.owner).size, 2)
  // one member, two groups: folded into one claim
  const c = assignMembers(['Zone 2 builds aerobic base.', 'Sleep raises appetite.'], [member('x', 'Zone 2 builds aerobic base.', 'p')])
  assert.deepEqual(c.merged, [[0, 1]])
})

test('a merged claim with distinct facts becomes several claims: facts kept as judged, members placed, characters do not drop', async () => {
  const d = {
    ...deps(st => (FACTS.includes(st) ? FAITHFUL : undefined)),
    decompose: async () => FACTS,
    group: async () => [[0, 1], [2, 3]] as number[][],
  }
  const r = await repairClaim(input(CLAIM2, splitMembers()), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.cutAt, 'facts')
  assert.equal(r.claims.length, 2)
  assert.equal(r.claims[0].statement, 'Zone 2 builds aerobic base. Zone 2 lowers resting heart rate.')
  assert.equal(r.claims[1].statement, 'Sleep under six hours raises appetite. A study followed 12 people for 35 years.')
  assert.deepEqual(r.claims[0].memberRawInsightIds, ['m1', 'm2'])
  assert.deepEqual(r.claims[1].memberRawInsightIds, ['m3'])
  assert.deepEqual(r.ledger.map(l => l.group), [0, 0, 1, 1])
  assert.equal(r.charsRemoved, 0)
  assert.ok(r.charsAfter >= r.charsBefore - 8) // only separators between clauses differ
  assert.ok(new Set(r.claims.flatMap(c => c.memberRawInsightIds)).size === 3) // every member in exactly one claim
  assert.match(r.note, /becomes 2 claims/)
})

test('facts that are all supported and stay in one group leave the claim unchanged (false alarm)', async () => {
  const d = { ...deps(st => (FACTS.includes(st) ? FAITHFUL : undefined)), decompose: async () => FACTS, group: async () => null }
  const r = await repairClaim(input(CLAIM2, splitMembers()), d)
  assert.equal(r.outcome, 'canonical_ok')
  assert.equal(r.claims.length, 0)
})

test('a fact no passage supports is removed from its claim and listed; supported facts are not touched', async () => {
  const facts = [...FACTS.slice(0, 3), 'A study followed 12 people for 35 years.']
  const d = {
    ...deps(st => (st !== facts[3] && facts.includes(st) ? FAITHFUL : undefined), [
      { action: 'remove', removed: [{ fact: 'A study followed 12 people for 35 years.', reason: 'no passage mentions a study' }], changes: 'removed the study' },
    ]),
    decompose: async () => facts, group: async () => [[0, 1], [2]] as number[][],
  }
  const ms = splitMembers()
  ms[2] = member('m3', 'Sleep under six hours raises appetite.', 'Sleep under six hours raises appetite, he said.')
  const r = await repairClaim(input(CLAIM2, ms), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.claims.length, 2)
  assert.equal(r.ledger[3].status, 'removed')
  assert.equal(r.ledger[3].group, null)
  assert.equal(r.charsRemoved, 'A study followed 12 people for 35 years.'.length)
})

test('a split that fails the coverage audit twice falls back to cutting at sentences', async () => {
  let calls = 0
  const claim = 'Zone 2 builds aerobic base. Walk daily.'
  const d = { ...deps(faithfulWhen('Zone 2 builds aerobic base.', 'Walk daily.')), decompose: async () => { calls++; return ['Zone 2 builds aerobic base.'] } }
  const r = await repairClaim(input(claim, [member('m1', claim, 'Zone 2 builds aerobic base. Walk daily.')]), d)
  assert.equal(calls, 2)
  assert.equal(r.cutAt, 'sentences')
  assert.equal(r.outcome, 'canonical_ok')
  assert.ok(r.attempts.some(a => a.kind === 'decompose' && a.guard))
})

test('a "removed" fact whose wording the repaired unit already carries was corrected, not lost: no removal search', async () => {
  const claim = 'Protein at 15 percent of calories equals the RDA of 0.8 g per kg.'
  const fixed = 'Under energy balance, protein at 15 percent of calories is a range of 0.8 to 1.2 g per kg, from the RDA upward.'
  const chunk = 'under energy balance, 15 percent of calories as protein is between point eight and one point two g per kg, from the RDA upward. 0.8 and 1.2 g per kg.'
  const d = deps(faithfulWhen(fixed), [
    { action: 'rewrite', statement: fixed, removed: [{ fact: 'Protein at 15 percent of calories equals the RDA of 0.8 g per kg.', reason: 'it is a range, not one value' }], changes: 'restored the range' },
  ])
  const r = await repairClaim(input(claim, [member('m1', claim, chunk, 'seed')]), d)
  assert.equal(r.outcome, 'repaired')
  assert.equal(r.ledger[0].status, 'edited')
  assert.equal(r.ledger[0].removed.length, 0)
  assert.equal(d.judged.filter(j => j.statement === 'Protein at 15 percent of calories equals the RDA of 0.8 g per kg.').length, 1) // only the first support check
})
