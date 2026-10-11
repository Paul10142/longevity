import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWorkerRequestAuthorized } from '../lib/workerAuth'

const prod = { NODE_ENV: 'production' }

test('production with no secret configured fails closed', () => {
  assert.equal(isWorkerRequestAuthorized(null, prod), false)
  assert.equal(isWorkerRequestAuthorized('Bearer anything', prod), false)
  assert.equal(isWorkerRequestAuthorized('Bearer ', { ...prod, WORKER_SECRET: '' }), false)
})

test('development with no secret configured stays open', () => {
  assert.equal(isWorkerRequestAuthorized(null, { NODE_ENV: 'development' }), true)
  assert.equal(isWorkerRequestAuthorized(null, {}), true)
})

test('WORKER_SECRET bearer is accepted, anything else is not', () => {
  const env = { ...prod, WORKER_SECRET: 's3cret' }
  assert.equal(isWorkerRequestAuthorized('Bearer s3cret', env), true)
  assert.equal(isWorkerRequestAuthorized(null, env), false)
  assert.equal(isWorkerRequestAuthorized('Bearer wrong', env), false)
  assert.equal(isWorkerRequestAuthorized('s3cret', env), false)
  assert.equal(isWorkerRequestAuthorized('Bearer s3cret ', env), false)
})

test('a configured secret closes the endpoint even outside production', () => {
  const env = { NODE_ENV: 'development', WORKER_SECRET: 's3cret' }
  assert.equal(isWorkerRequestAuthorized(null, env), false)
  assert.equal(isWorkerRequestAuthorized('Bearer s3cret', env), true)
})

test('CRON_SECRET bearer (Vercel cron) is accepted alongside WORKER_SECRET', () => {
  const env = { ...prod, WORKER_SECRET: 'worker', CRON_SECRET: 'cron' }
  assert.equal(isWorkerRequestAuthorized('Bearer cron', env), true)
  assert.equal(isWorkerRequestAuthorized('Bearer worker', env), true)
  assert.equal(isWorkerRequestAuthorized('Bearer other', env), false)
  assert.equal(isWorkerRequestAuthorized('Bearer cron', { ...prod, CRON_SECRET: 'cron' }), true)
})
