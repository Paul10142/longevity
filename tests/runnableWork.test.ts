/**
 * Unit tests for lib/runnableWork.ts — when the extraction supervisor decides it
 * is finished. Pure functions: no database, no clock.
 *
 * The first case replays the real 2026-10-12 situation: 94 episodes done, and
 * the only open job the August tag_claims job parked to 2027-01-01.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOpenJobs, describeWork, runIsFinished, runnableJobTypes, type OpenJob } from '../lib/runnableWork'

const NOW = Date.parse('2026-10-12T17:33:51Z')
const DEADLINE = NOW + 5 * 3_600_000
const SKIP_ALL = { SKIP_TAGGING: '1', SKIP_SYNTHESIS_FANOUT: '1', SKIP_REFERENCES: '1' }
const TYPES = runnableJobTypes(SKIP_ALL)

const job = (id: string, type: string, status = 'queued', run_after: string | null = null): OpenJob => ({ id, type, status, run_after })
const classify = (jobs: OpenJob[], opts = {}) => classifyOpenJobs(jobs, DEADLINE, { types: TYPES, ...opts })

test('with the supervisor flags, only extract and consolidate are runnable', () => {
  assert.deepEqual([...TYPES].sort(), ['consolidate_source', 'extract_source'])
})

test('a skipped stage becomes runnable when its flag is off; claim_sweep/discover/generate never are', () => {
  const all = runnableJobTypes({})
  for (const t of ['extract_source', 'consolidate_source', 'tag_claims', 'update_topic', 'extract_references', 'resolve_references']) {
    assert.ok(all.has(t), t)
  }
  for (const t of ['claim_sweep', 'discover_topics', 'generate_topic']) assert.ok(!all.has(t), t)
  assert.ok(runnableJobTypes({ SKIP_TAGGING: '1' }).has('extract_references'))
  assert.ok(!runnableJobTypes({ SKIP_REFERENCES: '1' }).has('resolve_references'))
  // update_topic only follows tagging; fan-out alone cannot produce it.
  assert.ok(!runnableJobTypes({ SKIP_TAGGING: '1' }).has('update_topic'))
  assert.ok(!runnableJobTypes({ SKIP_SYNTHESIS_FANOUT: '1' }).has('update_topic'))
  // Only the exact value '1' skips a stage, matching lib/worker.ts.
  assert.ok(runnableJobTypes({ SKIP_TAGGING: '0' }).has('tag_claims'))
})

test('2026-10-12: the parked August tag_claims job alone does not keep the run alive', () => {
  const w = classify([job('f0e7998d', 'tag_claims', 'queued', '2027-01-01T00:00:00Z')])
  assert.equal(w.open, 1)
  assert.equal(w.runnable, 0)
  assert.equal(runIsFinished(0, w), true)
})

test('a queued extract or consolidate job keeps the run going', () => {
  assert.equal(runIsFinished(0, classify([job('a', 'consolidate_source')])), false)
  assert.equal(runIsFinished(0, classify([job('a', 'extract_source', 'running')])), false)
  // The parked job beside real work changes nothing.
  const w = classify([job('p', 'tag_claims', 'queued', '2027-01-01T00:00:00Z'), job('a', 'extract_source')])
  assert.equal(w.runnable, 1)
  assert.equal(runIsFinished(0, w), false)
})

test('freshly enqueued sources keep the run going even with no open jobs counted', () => {
  assert.equal(runIsFinished(3, classify([])), false)
  assert.equal(runIsFinished(0, classify([])), true)
})

test('a retry backing off for minutes is still work; one due after the deadline is not', () => {
  const soon = new Date(NOW + 20 * 60_000).toISOString()
  const late = new Date(DEADLINE + 60_000).toISOString()
  assert.equal(classify([job('a', 'consolidate_source', 'queued', soon)]).runnable, 1)
  assert.equal(classify([job('a', 'consolidate_source', 'queued', late)]).futureDated, 1)
  assert.equal(runIsFinished(0, classify([job('a', 'consolidate_source', 'queued', late)])), true)
  // A run_after in the past (an overdue job) is due now.
  assert.equal(classify([job('a', 'extract_source', 'queued', '2026-10-01T00:00:00Z')]).runnable, 1)
})

test('a running job is never "parked", whatever its run_after says', () => {
  assert.equal(classify([job('a', 'extract_source', 'running', '2027-01-01T00:00:00Z')]).runnable, 1)
})

test('a quarantined job is ignored; an unparseable run_after counts as due', () => {
  const w = classify([job('q', 'consolidate_source'), job('b', 'extract_source', 'queued', 'not a date')], {
    quarantinedIds: new Set(['q']),
  })
  assert.equal(w.quarantined, 1)
  assert.equal(w.runnable, 1)
})

test('skipped-type jobs that are due now are still not waited for', () => {
  const w = classify([job('t', 'tag_claims'), job('r', 'extract_references'), job('s', 'claim_sweep')])
  assert.equal(w.skippedType, 3)
  assert.equal(w.runnable, 0)
})

test('with tagging enabled, a queued tag_claims job is work', () => {
  const w = classifyOpenJobs([job('t', 'tag_claims')], DEADLINE, { types: runnableJobTypes({}) })
  assert.equal(w.runnable, 1)
})

test('describeWork reads cleanly for the round log', () => {
  assert.equal(describeWork(classify([])), '0 runnable job(s)')
  assert.equal(
    describeWork(classify([job('p', 'consolidate_source', 'queued', '2027-01-01T00:00:00Z'), job('t', 'tag_claims')])),
    '0 runnable job(s) (ignoring 1 of a skipped type, 1 parked past the deadline)'
  )
})
