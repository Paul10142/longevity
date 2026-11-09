/**
 * The split writer's TypeScript side (lib/claimSplit.ts): building and validating a plan, the exact rows it writes,
 * the order of embedding -> database call, a failed write that leaves the plan on disk, and a re-run of a claim
 * that was already repaired. Pure: no database (tests/claimSplitSql.test.ts runs the SQL function for real), no model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildSplitPlan, planRows, describeSplit, applySplit, writeSplit, retryPendingSplits, splitWriterInstalled,
  loadPlans, SplitPlanError, type SplitDeps, type SplitPlan, type RpcResult,
} from '../lib/claimSplit'
import type { RepairResult } from '../lib/claimRepair'

const ORIGINAL = '11111111-1111-4111-8111-111111111111'
const FLAG = '22222222-2222-4222-8222-222222222222'
const insight = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FLAG_FACTS = { verdict: 'ADDED_DETAIL', offending: 'x', reasoning: 'adds a thing' }

/** A repaired RepairResult whose pieces hold the given statements and member insights. */
function repaired(pieces: Array<{ statement: string; members: string[] }>): RepairResult {
  return {
    outcome: 'repaired', source: 'rewrite', newStatement: pieces[0].statement, memberRawInsightId: null, droppedNumbers: [],
    note: `becomes ${pieces.length} claims`, attempts: [{ kind: 'group', unit: -1, statement: 'groups' }], ledger: [], passageCount: 3,
    claims: pieces.map((p, i) => ({ statement: p.statement, units: [i], memberRawInsightIds: p.members })),
    alsoBacks: [{ rawInsightId: insight(1), groups: [1] }], cutAt: 'facts', charsBefore: 300, charsAfter: 320, charsRemoved: 0,
  }
}

function plan(pieces: Array<{ statement: string; members: string[] }>, extra: Partial<Parameters<typeof buildSplitPlan>[0]> = {}): SplitPlan {
  let n = 100
  return buildSplitPlan({
    runId: 'repair-test', claimId: ORIGINAL, flagId: FLAG, originalStatement: 'Original merged wording.', contextNote: 'In adults.',
    flag: FLAG_FACTS, currentMemberIds: pieces.flatMap(p => p.members), result: repaired(pieces), model: 'test-model',
    newId: () => `99999999-9999-4999-8999-${String(n++).padStart(12, '0')}`, now: () => new Date('2026-11-09T12:00:00Z'), ...extra,
  })
}

const TWO = [
  { statement: 'Creatine raises muscle phosphocreatine.', members: [insight(1), insight(2)] },
  { statement: 'Creatine may help memory in sleep-deprived adults.', members: [insight(3)] },
]
const FIVE = [
  { statement: 'Fact A is true.', members: [insight(1), insight(2), insight(3)] },
  { statement: 'Fact B is true.', members: [insight(4)] },
  { statement: 'Fact C is true.', members: [insight(5), insight(6)] },
  { statement: 'Fact D is true.', members: [insight(7)] },
  { statement: 'Fact E is true.', members: [insight(8)] },
]

// ── Building the plan ───────────────────────────────────────────

test('a 2-way split keeps the original id for claim 0, gives the other piece a new id, and keeps every member exactly once', () => {
  const p = plan(TWO)
  assert.equal(p.claims.length, 2)
  assert.equal(p.claims[0].id, ORIGINAL)
  assert.notEqual(p.claims[1].id, ORIGINAL)
  assert.deepEqual(p.claims[0].memberIds, [insight(1), insight(2)])
  assert.deepEqual(p.claims[1].memberIds, [insight(3)])
  assert.equal(p.statusAfter, 'active')
  assert.equal(p.expectedStatement, 'Original merged wording.')
  assert.deepEqual(p.flagRepair.split_into, p.claims.map(c => c.id))
  // the audit trail names every new id and every member, so a split can be undone from it
  const split = p.audit.attempts.find(a => (a as { kind?: string }).kind === 'split') as { claims: Array<{ claim_id: string; member_raw_insight_ids: string[] }> }
  assert.deepEqual(split.claims.map(c => c.claim_id), p.claims.map(c => c.id))
  assert.deepEqual(split.claims.flatMap(c => c.member_raw_insight_ids).sort(), [insight(1), insight(2), insight(3)])
})

test('a 5-way split gives four new claims, all different ids, and loses and duplicates no member', () => {
  const p = plan(FIVE)
  assert.equal(p.claims.length, 5)
  assert.equal(new Set(p.claims.map(c => c.id)).size, 5)
  assert.equal(p.claims[0].id, ORIGINAL)
  const all = p.claims.flatMap(c => c.memberIds)
  assert.equal(all.length, 8)
  assert.equal(new Set(all).size, 8)
})

test('the rows a split writes are exactly the audit row, the original update, the new claims, one move per moved insight, one vector per claim, the aggregates and the flag', () => {
  const rows = planRows(plan(FIVE))
  const count = (table: string, op: string) => rows.filter(r => r.table === table && r.op === op).length
  assert.equal(count('claim_repairs', 'INSERT'), 1)
  assert.equal(count('claims', 'INSERT'), 4)
  assert.equal(count('claims', 'UPDATE'), 2) // the original's wording + the aggregates/status update
  assert.equal(count('claim_members', 'MOVE'), 5) // members of pieces 2-5 move; claim 0's three stay
  assert.equal(count('claim_embeddings', 'UPSERT'), 5)
  assert.equal(count('claim_flags', 'UPDATE'), 1)
  const moves = rows.filter(r => r.op === 'MOVE').map(r => r.values.raw_insight_id)
  assert.ok(![insight(1), insight(2), insight(3)].some(i => moves.includes(i)), "claim 0's own members are not moved")
  const audit = rows[0].values
  assert.equal(audit.original_statement, 'Original merged wording.', 'the old wording is saved')
  assert.equal(describeSplit(plan(TWO))[0].includes('apply_claim_split'), true)
})

test('a plan that would lose, duplicate or invent a member insight is refused', () => {
  // insight 3 left behind
  assert.throws(() => plan(TWO, { currentMemberIds: [insight(1), insight(2), insight(3), insight(4)] }), /left behind/)
  // an insight the claim does not have
  assert.throws(() => plan(TWO, { currentMemberIds: [insight(1), insight(2)] }), /not a member/)
  // an insight in two pieces
  assert.throws(() => plan([{ statement: 'A one.', members: [insight(1)] }, { statement: 'B two.', members: [insight(1), insight(2)] }], { currentMemberIds: [insight(1), insight(2)] }), /two resulting claims/)
  // a piece with no member
  assert.throws(() => plan([{ statement: 'A one.', members: [insight(1)] }, { statement: 'B two.', members: [] }], { currentMemberIds: [insight(1)] }), /no member insight/)
})

test('a plan with an empty or repeated wording, a single claim, or a non-repaired outcome is refused', () => {
  assert.throws(() => plan([{ statement: '  ', members: [insight(1)] }, { statement: 'B two.', members: [insight(2)] }]), /no statement/)
  assert.throws(() => plan([{ statement: 'Same wording.', members: [insight(1)] }, { statement: 'same   WORDING.', members: [insight(2)] }]), /same wording/)
  assert.throws(() => plan([{ statement: 'Only one.', members: [insight(1)] }]), /at least two/)
  const failed = { ...repaired(TWO), outcome: 'failed' as const }
  assert.throws(() => buildSplitPlan({ runId: 'r', claimId: ORIGINAL, flagId: FLAG, originalStatement: 'x', contextNote: null, flag: FLAG_FACTS, currentMemberIds: [insight(1), insight(2), insight(3)], result: failed, model: 'm' }), SplitPlanError)
})

// ── Writing it ──────────────────────────────────────────────────

type Call = { fn: string; args: Record<string, unknown> }
function fakeDeps(answer: (call: Call, n: number) => RpcResult | Error, embedFails = false) {
  const log: string[] = []
  const calls: Call[] = []
  const deps: SplitDeps = {
    embedBatch: async texts => {
      log.push(`embed ${texts.length}`)
      if (embedFails) throw new Error('OpenAI is down')
      return texts.map((_, i) => [i + 0.5, 1, 2])
    },
    rpc: async (fn, args) => {
      log.push('rpc')
      const call = { fn, args }
      calls.push(call)
      const a = answer(call, calls.length)
      if (a instanceof Error) throw a
      return a
    },
  }
  return { deps, log, calls }
}
const ok = (claimIds: string[]): RpcResult => ({ data: { status: 'applied', claim_ids: claimIds }, error: null })

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'split-plans-'))
  return { dir: path.join(dir, 'pending'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the vectors are computed first, then ONE database call carries the whole split', async () => {
  const p = plan(FIVE)
  const { deps, log, calls } = fakeDeps(() => ok(p.claims.map(c => c.id)))
  const out = await applySplit(p, deps)
  assert.deepEqual(log, ['embed 5', 'rpc'])
  assert.equal(out.status, 'applied')
  assert.equal(calls.length, 1)
  const a = calls[0].args as { p_claim_id: string; p_flag_id: string; p_expected_statement: string; p_plan: { claims: Array<{ id: string; embedding: string; member_ids: string[] }>; status_after: string } }
  assert.equal(calls[0].fn, 'apply_claim_split')
  assert.equal(a.p_claim_id, ORIGINAL)
  assert.equal(a.p_flag_id, FLAG)
  assert.equal(a.p_expected_statement, 'Original merged wording.')
  assert.equal(a.p_plan.status_after, 'active')
  assert.equal(a.p_plan.claims.length, 5)
  assert.equal(a.p_plan.claims[0].id, ORIGINAL)
  assert.equal(a.p_plan.claims[1].embedding, '[1.5,1,2]')
  assert.deepEqual(a.p_plan.claims.flatMap(c => c.member_ids).length, 8)
})

test('a failed write throws, leaves the plan on disk and writes nothing; the next run retries it and removes it', async () => {
  const t = tmp()
  try {
    const p = plan(TWO)
    const first = fakeDeps(() => ({ data: null, error: { message: 'connection reset' } }))
    await assert.rejects(writeSplit(p, first.deps, t.dir), /connection reset/)
    assert.deepEqual(readdirSync(t.dir), [`${ORIGINAL}.json`], 'the plan is kept for a retry')

    const second = fakeDeps(() => ok(p.claims.map(c => c.id)))
    const report = await retryPendingSplits(t.dir, second.deps)
    assert.deepEqual(report.applied, [ORIGINAL])
    assert.deepEqual(report.failed, [])
    assert.equal(existsSync(path.join(t.dir, `${ORIGINAL}.json`)), false, 'removed once written')
    // the retried plan has the SAME new ids, so a retry after a lost response cannot create a second set of claims
    const sent = (second.calls[0].args.p_plan as { claims: Array<{ id: string }> }).claims.map(c => c.id)
    assert.deepEqual(sent, p.claims.map(c => c.id))
  } finally { t.done() }
})

test('an embedding failure writes nothing: no database call, plan kept', async () => {
  const t = tmp()
  try {
    const { deps, calls } = fakeDeps(() => ok([]), true)
    await assert.rejects(writeSplit(plan(TWO), deps, t.dir), /OpenAI is down/)
    assert.equal(calls.length, 0)
    assert.equal(loadPlans(t.dir).plans.length, 1)
  } finally { t.done() }
})

test('a failing retry keeps the plan and reports it, so the claim is not repaired a second time meanwhile', async () => {
  const t = tmp()
  try {
    const p = plan(TWO)
    await assert.rejects(writeSplit(p, fakeDeps(() => new Error('timeout')).deps, t.dir), /timeout/)
    const report = await retryPendingSplits(t.dir, fakeDeps(() => ({ data: null, error: { message: 'still down' } })).deps)
    assert.deepEqual(report.failed.map(f => f.claimId), [ORIGINAL])
    assert.match(report.failed[0].error, /still down/)
    assert.equal(loadPlans(t.dir).plans.length, 1)
  } finally { t.done() }
})

test('re-running an already repaired claim writes nothing and removes the saved plan', async () => {
  const t = tmp()
  try {
    const p = plan(FIVE)
    const { deps } = fakeDeps(() => ({ data: { status: 'already_applied' }, error: null }))
    const out = await writeSplit(p, deps, t.dir)
    assert.deepEqual(out, { status: 'already_applied' })
    assert.equal(loadPlans(t.dir).plans.length, 0)
  } finally { t.done() }
})

test('a claim that changed after it was read is reported stale, nothing is written and the saved plan is discarded', async () => {
  const t = tmp()
  try {
    const { deps } = fakeDeps(() => ({ data: { status: 'stale', reason: 'the claim wording changed after it was read' }, error: null }))
    const out = await writeSplit(plan(TWO), deps, t.dir)
    assert.deepEqual(out, { status: 'stale', reason: 'the claim wording changed after it was read' })
    assert.equal(loadPlans(t.dir).plans.length, 0)
    const report = await retryPendingSplits(t.dir, deps)
    assert.deepEqual(report, { applied: [], alreadyApplied: [], stale: [], failed: [], unreadable: [] })
  } finally { t.done() }
})

test('an unreadable saved plan is reported and left alone', () => {
  const t = tmp()
  try {
    writeFileSync(path.join(path.dirname(t.dir), 'x.json'), '{')
    const dir = path.dirname(t.dir)
    const { plans, unreadable } = loadPlans(dir)
    assert.equal(plans.length, 0)
    assert.deepEqual(unreadable, ['x.json'])
    assert.equal(existsSync(path.join(dir, 'x.json')), true)
  } finally { t.done() }
})

test('an answer that is not applied / already_applied / stale is an error, not a success', async () => {
  const { deps } = fakeDeps(() => ({ data: { status: 'weird' }, error: null }))
  await assert.rejects(applySplit(plan(TWO), deps), /unexpected answer/)
})

test('the install probe says yes only when the function answers stale, and writes nothing', async () => {
  assert.equal(await splitWriterInstalled(async () => ({ data: { status: 'stale', reason: 'the claim no longer exists' }, error: null })), true)
  assert.equal(await splitWriterInstalled(async () => ({ data: null, error: { message: 'Could not find the function public.apply_claim_split', code: 'PGRST202' } })), false)
})
