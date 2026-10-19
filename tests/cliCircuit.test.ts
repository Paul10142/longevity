/**
 * The call-level circuit breaker in lib/llm.ts: 5 consecutive CLI failures that are not a
 * usage limit or a safety refusal throw PipelineHaltError, which the worker turns into
 * "put the job back, spend no attempt" and the supervisors turn into a STOP.
 *
 *   npm test
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeJson, cliCircuit, resetCliCircuit, CLI_FAILURES_TO_HALT, CLAUDE_BULK_MODEL, ModelRefusalError } from '../lib/llm'
import { PipelineHaltError, UsageLimitError, formatHalt, rethrowIfUsageLimit, resetUsageState } from '../lib/usageLimit'
import { appleScriptString } from '../lib/haltNotice'

let dir = ''
const saved = { PATH: process.env.PATH, LLM_BACKEND: process.env.LLM_BACKEND, MODE: process.env.FAKE_CLAUDE_MODE, DIR: process.env.LA_EMPTY_MCP_DIR }
const REFUSAL = "API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."
const LIMIT = "You've hit your session limit · resets 12:40am (America/Detroit)"

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-cb-'))
  writeFileSync(
    join(dir, 'claude'),
    `#!/bin/sh
cat > /dev/null
case "$FAKE_CLAUDE_MODE" in
  fail) echo "Not logged in · Please run /login"; exit 1 ;;
  limit) echo "${LIMIT}"; exit 1 ;;
  refuse) echo "${REFUSAL}"; exit 1 ;;
esac
echo '{"ok":true}'
`
  )
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.LLM_BACKEND = 'claude-code'
  process.env.LA_EMPTY_MCP_DIR = join(dir, 'cfg')
})
after(() => {
  process.env.PATH = saved.PATH
  for (const [k, v] of [['LLM_BACKEND', saved.LLM_BACKEND], ['FAKE_CLAUDE_MODE', saved.MODE], ['LA_EMPTY_MCP_DIR', saved.DIR]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  resetCliCircuit()
  resetUsageState() // a limit message opens a pause window that would gate later calls
})

const call = () => claudeJson('sys', 'user', 100, CLAUDE_BULK_MODEL)

test('four failures in a row are ordinary errors; the fifth halts the run', async () => {
  process.env.FAKE_CLAUDE_MODE = 'fail'
  for (let i = 1; i < CLI_FAILURES_TO_HALT; i++) {
    await assert.rejects(call(), (e: Error) => !(e instanceof PipelineHaltError) && /Not logged in/.test(e.message))
  }
  await assert.rejects(call(), (e: Error) => e instanceof PipelineHaltError && e.consecutiveFailures === CLI_FAILURES_TO_HALT && /Not logged in/.test(e.lastError))
  assert.ok(cliCircuit.halted)
})

test('a success resets the count', async () => {
  process.env.FAKE_CLAUDE_MODE = 'fail'
  for (let i = 0; i < CLI_FAILURES_TO_HALT - 1; i++) await assert.rejects(call())
  process.env.FAKE_CLAUDE_MODE = 'ok'
  await call()
  assert.equal(cliCircuit.consecutive, 0)
  process.env.FAKE_CLAUDE_MODE = 'fail'
  for (let i = 0; i < CLI_FAILURES_TO_HALT - 1; i++) await assert.rejects(call(), (e: Error) => !(e instanceof PipelineHaltError))
  assert.equal(cliCircuit.halted, null)
})

test('usage-limit and safety-refusal failures are not counted', async () => {
  process.env.FAKE_CLAUDE_MODE = 'limit'
  for (let i = 0; i < CLI_FAILURES_TO_HALT + 2; i++) await assert.rejects(call(), UsageLimitError)
  resetUsageState()
  process.env.FAKE_CLAUDE_MODE = 'refuse'
  for (let i = 0; i < CLI_FAILURES_TO_HALT + 2; i++) await assert.rejects(call(), ModelRefusalError)
  assert.equal(cliCircuit.consecutive, 0)
  assert.equal(cliCircuit.halted, null)
})

test('an invalid MCP config message counts (it is not a limit or a refusal)', async () => {
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\ncat > /dev/null\necho "Invalid MCP configuration: MCP config file not found: /x.json"; exit 1\n')
  for (let i = 0; i < CLI_FAILURES_TO_HALT; i++) await assert.rejects(call())
  assert.ok(cliCircuit.halted)
  assert.match(cliCircuit.halted!.lastError, /MCP config file not found/)
})

test('once tripped, later calls fail at once with the same error and never start the CLI', async () => {
  process.env.FAKE_CLAUDE_MODE = 'fail'
  for (let i = 0; i < CLI_FAILURES_TO_HALT; i++) await assert.rejects(call())
  const halted = cliCircuit.halted
  process.env.FAKE_CLAUDE_MODE = 'ok' // even a healthy CLI is not consulted after the trip
  await assert.rejects(call(), (e: unknown) => e === halted)
})

test('16 concurrent failing calls: the breaker trips once; every call after the 5th completion rejects with the halt', async () => {
  process.env.FAKE_CLAUDE_MODE = 'fail'
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => call()))
  const halts = results.filter(r => r.status === 'rejected' && r.reason instanceof PipelineHaltError)
  const plain = results.filter(r => r.status === 'rejected' && !(r.reason instanceof PipelineHaltError))
  assert.equal(plain.length, CLI_FAILURES_TO_HALT - 1)
  assert.equal(halts.length, 16 - (CLI_FAILURES_TO_HALT - 1))
  const one = new Set(halts.map(r => (r as PromiseRejectedResult).reason))
  assert.equal(one.size, 1, 'one shared halt error, not one per call')
})

test('a halt is rethrown by the catch helpers that would otherwise swallow errors', () => {
  assert.throws(() => rethrowIfUsageLimit(new PipelineHaltError(5, 'x')), PipelineHaltError)
  assert.doesNotThrow(() => rethrowIfUsageLimit(new Error('ordinary')))
})

test('the STOP text names the count and the last error; the notification is osascript-safe', () => {
  const { block, notification } = formatHalt(new PipelineHaltError(5, 'Invalid MCP configuration:\nMCP config file not found'))
  assert.match(block, /^STOP: 5 CLI calls failed in a row: Invalid MCP configuration: MCP config file not found/)
  assert.match(notification, /5 CLI calls failed in a row/)
  assert.equal(appleScriptString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"')
})
