/**
 * The empty MCP config the CLI backend passes with --strict-mcp-config must
 * survive being deleted mid-run (macOS purged it at 03:36 on 2026-10-19 and every
 * call for the next 4 h died with "MCP config file not found"), and a run that
 * keeps hitting that error is stopped by the circuit breaker (tests/cliCircuit.test.ts).
 *
 *   npm test
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeJson, emptyMcpConfig, EMPTY_MCP_FILE, CLAUDE_BULK_MODEL, resetCliCircuit } from '../lib/llm'
import { isMcpConfigError } from '../lib/usageLimit'

let dir = ''
let cfgDir = ''
const saved = { PATH: process.env.PATH, LLM_BACKEND: process.env.LLM_BACKEND, DIR: process.env.LA_EMPTY_MCP_DIR }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-mcp-'))
  cfgDir = join(dir, 'cfg')
  // Behaves like the real CLI: exits 1 with its message when the --mcp-config file is gone.
  const script = `#!/bin/sh
cfg=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then cfg="$2"; fi
  shift
done
cat > /dev/null
if [ ! -f "$cfg" ]; then echo "Error: Invalid MCP configuration: MCP config file not found: $cfg"; exit 1; fi
echo '{"ok":true}'
`
  writeFileSync(join(dir, 'claude'), script)
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.LLM_BACKEND = 'claude-code'
  process.env.LA_EMPTY_MCP_DIR = cfgDir
})

after(() => {
  process.env.PATH = saved.PATH
  for (const [k, v] of [['LLM_BACKEND', saved.LLM_BACKEND], ['LA_EMPTY_MCP_DIR', saved.DIR]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

test('the config file is written, keeps the guarded name, and holds no servers', () => {
  const p = emptyMcpConfig()
  assert.equal(p, join(cfgDir, EMPTY_MCP_FILE))
  assert.match(p, /lifestyle-academy-empty-mcp/) // the usage guard matches this on the command line
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { mcpServers: {} })
})

test('a deleted config file is rewritten on the next call', () => {
  const p = emptyMcpConfig()
  rmSync(p)
  assert.equal(existsSync(p), false)
  assert.equal(emptyMcpConfig(), p)
  assert.equal(existsSync(p), true)
})

test('an existing file is left alone', () => {
  const p = emptyMcpConfig()
  writeFileSync(p, '{"mcpServers":{}} ')
  emptyMcpConfig()
  assert.equal(readFileSync(p, 'utf8'), '{"mcpServers":{}} ')
})

test('a CLI call after the file is deleted still succeeds', async () => {
  rmSync(emptyMcpConfig())
  const out = await claudeJson<{ ok: boolean }>('sys', 'user', 100, CLAUDE_BULK_MODEL)
  assert.deepEqual(out, { ok: true })
})

test('if the file vanishes between the check and the CLI, the file is restored for the next call', async () => {
  // Simulate the race with a CLI that always reports the file missing on its first call.
  const p = emptyMcpConfig()
  resetCliCircuit()
  writeFileSync(
    join(dir, 'claude'),
    `#!/bin/sh\ncat > /dev/null\nrm -f "${p}"\necho "Error: Invalid MCP configuration: MCP config file not found: ${p}"\nexit 1\n`
  )
  await assert.rejects(claudeJson('sys', 'user', 100, CLAUDE_BULK_MODEL), /Invalid MCP configuration/)
  assert.equal(existsSync(p), true, 'the file was restored for the next call')
})

test('isMcpConfigError recognises the CLI message and nothing else', () => {
  assert.ok(isMcpConfigError('Invalid MCP configuration: MCP config file not found: /var/folders/x.json'))
  assert.ok(isMcpConfigError('MCP config file not found'))
  assert.ok(!isMcpConfigError("You've hit your session limit"))
  assert.ok(!isMcpConfigError(null))
})
