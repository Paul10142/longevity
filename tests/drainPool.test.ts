/**
 * lib/drainPool.ts and the --workers parsing in lib/pipelineLanes.ts: several workers drain one
 * queue, refill it from a feed, and all stop on a halt or a usage limit. Fake queue, no database.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drainPool, type DrainTick } from '../lib/drainPool'
import { parseWorkers, freshBatchSize, MAX_WORKERS } from '../lib/pipelineLanes'
import { PipelineHaltError, UsageLimitError } from '../lib/usageLimit'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A queue of jobs, each taking `ms`; a tick claims until empty, like runWorkerTick. */
function fakeQueue(jobs: string[], ms = 10) {
  const queue = [...jobs]
  const running = { now: 0, peak: 0 }
  const done: string[] = []
  const tick = async (): Promise<DrainTick> => {
    let processed = 0
    for (let j = queue.shift(); j !== undefined; j = queue.shift()) {
      running.now++
      running.peak = Math.max(running.peak, running.now)
      await sleep(ms)
      running.now--
      done.push(j)
      processed++
    }
    return { processed, failed: 0 }
  }
  return { queue, running, done, tick }
}

test('one worker, no feed: drains the queue and stops (the old loop)', async () => {
  const q = fakeQueue(['a', 'b', 'c'])
  const r = await drainPool({ workers: 1, tick: q.tick, pastDeadline: () => false })
  assert.deepEqual(q.done, ['a', 'b', 'c'])
  assert.equal(r.processed, 3)
  assert.equal(r.perWorker.length, 1)
  assert.equal(q.running.peak, 1)
})

test('three workers run jobs at the same time and every job runs once', async () => {
  const q = fakeQueue(['a', 'b', 'c', 'd', 'e', 'f'], 20)
  const r = await drainPool({ workers: 3, tick: q.tick, pastDeadline: () => false })
  assert.deepEqual([...q.done].sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(r.processed, 6)
  assert.equal(q.running.peak, 3)
})

test('feed refills the queue, one source per empty observation, until it runs out', async () => {
  const q = fakeQueue(['s0'], 15)
  const pending = ['s1', 's2', 's3', 's4', 's5']
  const r = await drainPool({
    workers: 2,
    tick: q.tick,
    feed: async () => {
      const next = pending.shift()
      if (next === undefined) return false
      q.queue.push(next)
      return true
    },
    pastDeadline: () => false,
  })
  assert.deepEqual([...q.done].sort(), ['s0', 's1', 's2', 's3', 's4', 's5'])
  assert.equal(r.processed, 6)
  assert.ok(q.running.peak <= 2)
})

test('a usage limit seen by one worker stops the others after their tick', async () => {
  const limit = new UsageLimitError('reached', Date.now() + 60_000, null, 'limit')
  let calls = 0
  const r = await drainPool({
    workers: 3,
    tick: async () => {
      const n = ++calls
      await sleep(5)
      return n === 1 ? { processed: 1, failed: 1, usageLimit: limit } : { processed: 1, failed: 0 }
    },
    pastDeadline: () => false,
  })
  assert.equal(r.limitHit, limit)
  assert.equal(r.halted, null)
  assert.ok(calls <= 3, `each worker ticks at most once more, got ${calls}`)
  assert.equal(r.failed, 1)
})

test('a halt wins, including one only visible on the breaker', async () => {
  const halt = new PipelineHaltError(5, 'Not logged in')
  let tripped = false
  const r = await drainPool({
    workers: 2,
    tick: async () => {
      await sleep(5)
      tripped = true
      return { processed: 1, failed: 0 }
    },
    haltedNow: () => (tripped ? halt : null),
    pastDeadline: () => false,
  })
  assert.equal(r.halted, halt)
})

test('failed jobs are not progress; a deadline ends every worker', async () => {
  let n = 0
  const r = await drainPool({
    workers: 2,
    tick: async () => ({ processed: 2, failed: 2 }),
    pastDeadline: () => ++n > 4,
  })
  assert.equal(r.processed, 0)
  assert.ok(r.failed >= 2)
})

test('--workers: default 1, validated, extract-only, capped', () => {
  assert.equal(parseWorkers(['--extract-only'], 'extract'), 1)
  assert.equal(parseWorkers(['--extract-only', '--workers', '3'], 'extract'), 3)
  assert.equal(parseWorkers(['--workers', '1'], 'all'), 1)
  assert.throws(() => parseWorkers(['--extract-only', '--workers', '0'], 'extract'), /whole number/)
  assert.throws(() => parseWorkers(['--extract-only', '--workers', '2.5'], 'extract'), /whole number/)
  assert.throws(() => parseWorkers(['--extract-only', '--workers'], 'extract'), /whole number/)
  assert.throws(() => parseWorkers(['--extract-only', '--workers', String(MAX_WORKERS + 1)], 'extract'), /whole number/)
  assert.throws(() => parseWorkers(['--consolidate-only', '--workers', '2'], 'consolidate'), /only works with --extract-only/)
  assert.throws(() => parseWorkers(['--workers', '2'], 'all'), /only works with --extract-only/)
})

test('the first round queues at least one extraction per worker', () => {
  assert.equal(freshBatchSize(3, 1), 3)
  assert.equal(freshBatchSize(3, 5), 5)
  assert.equal(freshBatchSize(8, 4), 8)
})
