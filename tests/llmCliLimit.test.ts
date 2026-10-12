/**
 * lib/llm.ts against a FAKE `claude` binary on PATH: proves the CLI wrapper
 * reads the stream-json reply, turns the real usage-limit message into a
 * UsageLimitError (no retry, no attempt-burning failure), refuses to spawn
 * while the window is known to be full, and pauses before the limit when the
 * rate_limit_event says the window is nearly full. No network, no real CLI.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
const oldPath = process.env.PATH
const count = () => (existsSync(join(dir, 'count')) ? readFileSync(join(dir, 'count'), 'utf8').length : 0)

const rate = (util: number, resetsAt: number, status = 'allowed') =>
  `{"type":"rate_limit_event","rate_limit_info":{"status":"${status}","resetsAt":${resetsAt},"unifiedWindows":{"five_hour":{"utilization":${util},"resetsAt":${resetsAt}}}}}`
const result = (text: string, isError = false) =>
  `{"type":"result","subtype":"${isError ? 'error' : 'success'}","is_error":${isError},"result":${JSON.stringify(text)}}`

function fake(lines: string[], exit = 0) {
  writeFileSync(join(dir, 'out'), lines.join('\n') + '\n')
  process.env.FAKE_EXIT = String(exit)
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  writeFileSync(
    join(dir, 'claude'),
    `#!/bin/sh\ncat >/dev/null\nprintf x >> "${dir}/count"\ncat "${dir}/out"\nexit "$FAKE_EXIT"\n`
  )
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.PATH = `${dir}:${oldPath}`
  process.env.LLM_BACKEND = 'claude-code'
  delete process.env.LLM_FALLBACK_TO_API
})
after(() => {
  process.env.PATH = oldPath
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  rmSync(join(dir, 'count'), { force: true })
  const { resetUsageState } = await import('../lib/usageLimit')
  resetUsageState()
})

const future = () => Math.floor(Date.now() / 1000) + 3600

test('normal call: JSON comes out of the stream-json result event', async () => {
  const { claudeJson } = await import('../lib/llm')
  fake([`{"type":"system","subtype":"init"}`, rate(0.2, future()), result('{"ok":true}')])
  assert.deepEqual(await claudeJson('sys', 'user'), { ok: true })
  assert.equal(count(), 1)
})

test('the real limit message → UsageLimitError with the parsed reset; later calls do not spawn', async () => {
  const { claudeJson } = await import('../lib/llm')
  const { UsageLimitError } = await import('../lib/usageLimit')
  fake([result("You've hit your session limit · resets 12:40am (America/Detroit)", true)], 1)
  await assert.rejects(claudeJson('sys', 'user'), (e: unknown) => {
    assert.ok(e instanceof UsageLimitError)
    assert.equal(e.kind, 'reached')
    assert.ok(e.resetAt && e.resetAt > Date.now() - 1000, 'reset is in the future')
    return true
  })
  assert.equal(count(), 1)
  // The window is now known to be full: the next calls are refused WITHOUT spawning.
  for (let i = 0; i < 5; i++) await assert.rejects(claudeJson('sys', 'user'), UsageLimitError)
  assert.equal(count(), 1, 'no further CLI processes were started')
})

test('limit message as plain text (not stream-json, exit 1) is recognised too', async () => {
  const { claudeJson } = await import('../lib/llm')
  const { UsageLimitError } = await import('../lib/usageLimit')
  fake([`You've hit your session limit · resets 3pm (America/Detroit)`], 1)
  await assert.rejects(claudeJson('sys', 'user'), UsageLimitError)
})

test('a model refusal is not a usage-limit pause, and keeps its readable reason', async () => {
  const { claudeJson } = await import('../lib/llm')
  const { UsageLimitError } = await import('../lib/usageLimit')
  fake([result("API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup).", true)], 1)
  await assert.rejects(claudeJson('sys', 'user'), (e: unknown) => {
    assert.ok(!(e instanceof UsageLimitError))
    assert.match((e as Error).message, /API Error: Opus 5's safeguards flagged/)
    return true
  })
})

test('pauses BEFORE the limit: a reply that reports the window 96% full gates the next call', async () => {
  const { claudeJson } = await import('../lib/llm')
  const { UsageLimitError } = await import('../lib/usageLimit')
  fake([rate(0.96, future()), result('{"n":1}')])
  assert.deepEqual(await claudeJson('sys', 'user'), { n: 1 }, 'the call that reported it still succeeds')
  await assert.rejects(claudeJson('sys', 'user'), (e: unknown) => {
    assert.ok(e instanceof UsageLimitError)
    assert.equal(e.kind, 'approaching')
    return true
  })
  assert.equal(count(), 1)
})

test('a usage-limit pause never falls back to the paid API', async () => {
  const { claudeJson } = await import('../lib/llm')
  const { UsageLimitError } = await import('../lib/usageLimit')
  process.env.LLM_FALLBACK_TO_API = '1'
  process.env.ANTHROPIC_API_KEY = 'sk-test-never-used'
  try {
    fake([result("You've hit your session limit · resets 12:40am (America/Detroit)", true)], 1)
    await assert.rejects(claudeJson('sys', 'user'), UsageLimitError)
  } finally {
    delete process.env.LLM_FALLBACK_TO_API
    delete process.env.ANTHROPIC_API_KEY
  }
})

test('a CLI that prints plain text (no stream-json) still works: the raw output is the reply', async () => {
  const { claudeJson } = await import('../lib/llm')
  fake(['{"plain":true}'])
  assert.deepEqual(await claudeJson('sys', 'user'), { plain: true })
})

test('stream events without a result are a failure, not a silent empty reply', async () => {
  const { claudeJson } = await import('../lib/llm')
  fake([`{"type":"system","subtype":"init"}`])
  await assert.rejects(claudeJson('sys', 'user'), /no result event/)
})
