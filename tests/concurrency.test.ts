/**
 * lib/concurrency.ts: the counting limiter that caps Claude CLI children and raw_insights writes
 * when several extraction workers share one process.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter, envLimit } from '../lib/concurrency'

const tick = () => new Promise(r => setImmediate(r))

test('never runs more than max at once, and starts waiters in arrival order', async () => {
  const lim = createLimiter(2)
  const started: number[] = []
  const gates: Array<() => void> = []
  const tasks = [0, 1, 2, 3, 4].map(i =>
    lim.run(
      () =>
        new Promise<number>(resolve => {
          started.push(i)
          gates.push(() => resolve(i))
        })
    )
  )
  await tick()
  assert.deepEqual(started, [0, 1], 'only two start')
  assert.equal(lim.active, 2)
  assert.equal(lim.waiting, 3)
  gates[0]()
  await tick()
  assert.deepEqual(started, [0, 1, 2], 'the next in line takes the freed slot')
  gates[1](); gates[2]()
  await tick()
  gates[3](); gates[4]()
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4])
  assert.equal(lim.active, 0)
  assert.equal(lim.peak, 2)
})

test('a task that throws still frees its slot', async () => {
  const lim = createLimiter(1)
  await assert.rejects(lim.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(lim.active, 0)
  assert.equal(await lim.run(async () => 'ok'), 'ok')
})

test('releasing a slot twice frees it once', async () => {
  const lim = createLimiter(1)
  const release = await lim.acquire()
  release(); release()
  assert.equal(lim.active, 0)
  const a = await lim.acquire()
  assert.equal(lim.active, 1)
  a()
})

test('a bad max is clamped to 1; envLimit falls back on junk', () => {
  assert.equal(createLimiter(0).max, 1)
  assert.equal(createLimiter(NaN).max, 1)
  process.env.__LIMIT_T = 'abc'
  assert.equal(envLimit('__LIMIT_T', 7), 7)
  process.env.__LIMIT_T = '0'
  assert.equal(envLimit('__LIMIT_T', 7), 7)
  process.env.__LIMIT_T = '4'
  assert.equal(envLimit('__LIMIT_T', 7), 4)
  delete process.env.__LIMIT_T
})
