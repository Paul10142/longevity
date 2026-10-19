/**
 * Extract / consolidate lanes (lib/pipelineLanes.ts + the lane-aware parts of
 * lib/runnableWork.ts). Pure functions: no database, no clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLane, laneJobTypes, laneHealTypes, laneEnqueuesExtractions, laneLabel, consolidateShouldWait,
} from '../lib/pipelineLanes'
import { classifyOpenJobs, runIsFinished, runnableJobTypes, type OpenJob } from '../lib/runnableWork'

const DEADLINE = Date.parse('2026-10-18T20:00:00Z')
const job = (id: string, type: string, status = 'queued'): OpenJob => ({ id, type, status, run_after: null })

test('parseLane: no flag = all, one flag = that lane, both or a typo = error', () => {
  assert.equal(parseLane(['--hours', '9']), 'all')
  assert.equal(parseLane(['--extract-only', '--hours', '9']), 'extract')
  assert.equal(parseLane(['--consolidate-only']), 'consolidate')
  assert.throws(() => parseLane(['--extract-only', '--consolidate-only']), /two separate runs/)
  assert.throws(() => parseLane(['--extractonly']), /unknown lane flag/)
})

test('each lane claims only its own job type; the plain run claims anything', () => {
  assert.deepEqual(laneJobTypes('extract'), ['extract_source'])
  assert.deepEqual(laneJobTypes('consolidate'), ['consolidate_source'])
  assert.equal(laneJobTypes('all'), null)
})

test('a lane heals only its own failed jobs, and only the extract side starts extractions', () => {
  assert.deepEqual(laneHealTypes('extract'), ['extract_source'])
  assert.deepEqual(laneHealTypes('consolidate'), ['consolidate_source'])
  assert.deepEqual(laneHealTypes('all'), ['extract_source', 'consolidate_source'])
  assert.equal(laneEnqueuesExtractions('extract'), true)
  assert.equal(laneEnqueuesExtractions('all'), true)
  assert.equal(laneEnqueuesExtractions('consolidate'), false)
  assert.equal(laneLabel('all'), 'extractDeepgram')
  assert.match(laneLabel('extract'), /extract-only/)
})

test('extract-only: queued consolidate jobs are not runnable work, so the run ends instead of idling', () => {
  const types = runnableJobTypes({ SKIP_TAGGING: '1', SKIP_REFERENCES: '1' }, 'extract')
  assert.deepEqual([...types], ['extract_source'])
  const jobs = [job('a', 'consolidate_source'), job('b', 'consolidate_source'), job('c', 'consolidate_source', 'running')]
  const w = classifyOpenJobs(jobs, DEADLINE, { types })
  assert.equal(w.open, 3)
  assert.equal(w.runnable, 0)
  assert.equal(w.skippedType, 3)
  assert.equal(runIsFinished(0, w), true)
})

test('extract-only keeps going while an extraction is open or still being enqueued', () => {
  const types = runnableJobTypes({}, 'extract')
  const w = classifyOpenJobs([job('a', 'consolidate_source'), job('x', 'extract_source')], DEADLINE, { types })
  assert.equal(w.runnable, 1)
  assert.equal(runIsFinished(0, w), false)
  assert.equal(runIsFinished(2, classifyOpenJobs([], DEADLINE, { types })), false)
})

test('consolidate-only: queued extractions are not its work; consolidate jobs are', () => {
  const types = runnableJobTypes({}, 'consolidate')
  assert.deepEqual([...types], ['consolidate_source'])
  const w = classifyOpenJobs([job('x', 'extract_source'), job('c', 'consolidate_source')], DEADLINE, { types })
  assert.equal(w.runnable, 1)
  assert.equal(w.skippedType, 1)
  assert.equal(runIsFinished(0, classifyOpenJobs([job('x', 'extract_source')], DEADLINE, { types })), true)
})

test('the plain run is unchanged: both types runnable', () => {
  assert.deepEqual([...runnableJobTypes({ SKIP_TAGGING: '1', SKIP_REFERENCES: '1' })].sort(), ['consolidate_source', 'extract_source'])
})

test('the consolidate lane waits for a live extract lane only when its own queue is empty', () => {
  assert.equal(consolidateShouldWait('consolidate', true, 0), true)
  assert.equal(consolidateShouldWait('consolidate', true, 2), false)
  assert.equal(consolidateShouldWait('consolidate', false, 0), false)
  assert.equal(consolidateShouldWait('extract', true, 0), false)
  assert.equal(consolidateShouldWait('all', true, 0), false)
})
