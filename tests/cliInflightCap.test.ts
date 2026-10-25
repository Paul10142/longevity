/**
 * The process-wide cap on `claude -p` children (CLI_MAX_INFLIGHT, lib/llm.ts): extra calls wait for a
 * slot, and a call that waited re-checks the circuit breaker before it spawns.
 *
 *   npm test
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
const saved = { PATH: process.env.PATH, LLM_BACKEND: process.env.LLM_BACKEND, CAP: process.env.CLI_MAX_INFLIGHT, DIR: process.env.LA_EMPTY_MCP_DIR }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-cap-'))
  writeFileSync(
    join(dir, 'claude'),
    `#!/bin/sh
cat > /dev/null
sleep 0.15
case "$FAKE_CLAUDE_MODE" in
  fail) echo "Not logged in · Please run /login"; exit 1 ;;
esac
echo '{"ok":true}'
`
  )
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.LLM_BACKEND = 'claude-code'
  process.env.CLI_MAX_INFLIGHT = '2' // read when lib/llm loads
  process.env.LA_EMPTY_MCP_DIR = join(dir, 'cfg')
})
after(() => {
  process.env.PATH = saved.PATH
  for (const [k, v] of [['LLM_BACKEND', saved.LLM_BACKEND], ['CLI_MAX_INFLIGHT', saved.CAP], ['LA_EMPTY_MCP_DIR', saved.DIR]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  delete process.env.FAKE_CLAUDE_MODE
  rmSync(dir, { recursive: true, force: true })
})

test('six simultaneous calls never have more than two children alive', async () => {
  const { claudeJson, cliLimiter, resetCliCircuit, CLAUDE_BULK_MODEL } = await import('../lib/llm')
  resetCliCircuit()
  process.env.FAKE_CLAUDE_MODE = 'ok'
  const out = await Promise.all(Array.from({ length: 6 }, () => claudeJson('sys', 'user', 100, CLAUDE_BULK_MODEL)))
  assert.equal(out.length, 6)
  assert.equal(cliLimiter.max, 2)
  assert.equal(cliLimiter.peak, 2)
  assert.equal(cliLimiter.active, 0)
})

test('calls queued behind a tripped breaker fail without spawning', async () => {
  const { claudeJson, cliStats, resetCliCircuit, CLAUDE_BULK_MODEL, CLI_FAILURES_TO_HALT } = await import('../lib/llm')
  const { PipelineHaltError } = await import('../lib/usageLimit')
  resetCliCircuit()
  process.env.FAKE_CLAUDE_MODE = 'fail'
  const before = cliStats.calls
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => claudeJson('sys', 'user', 100, CLAUDE_BULK_MODEL)))
  assert.equal(results.every(r => r.status === 'rejected'), true)
  assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof PipelineHaltError))
  // With two slots at most CLI_FAILURES_TO_HALT + 1 children can have started before the 5th failure lands.
  assert.ok(cliStats.calls - before <= CLI_FAILURES_TO_HALT + 1, `spawned ${cliStats.calls - before} children`)
})
