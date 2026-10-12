/**
 * The `claude-code` backend against a fake `claude` binary on PATH — no real
 * model call. Pins two 2026-10-12 fixes in lib/llm.ts:
 *   - the CLI is asked for the exact model id (claude-opus-5-5), not the
 *     `opus` alias that answered as Opus 5 overnight;
 *   - a safety-filter refusal surfaces as ModelRefusalError, and adjudicate()
 *     gives up after ONE call instead of re-sending the pair four times.
 *
 *   npm test
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeJson, ModelRefusalError, CLAUDE_JUDGMENT_MODEL, CLAUDE_BULK_MODEL } from '../lib/llm'
import { adjudicate } from '../lib/consolidation'

const REFUSAL =
  "API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). " +
  'Our intentionally broad safeguards allow us to deliver more capabilities faster, but can ' +
  "sometimes flag legitimate biology tasks. Claude Code can't respond to this message with Opus 5."

let dir = ''
const saved = { PATH: process.env.PATH, LLM_BACKEND: process.env.LLM_BACKEND, MODE: process.env.FAKE_CLAUDE_MODE }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  // Appends its argv to calls.log as ONE line (the system prompt it is handed
  // spans many), then answers per FAKE_CLAUDE_MODE.
  const script = `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "${dir}/calls.log"
echo >> "${dir}/calls.log"
cat > /dev/null
if [ "$FAKE_CLAUDE_MODE" = refuse ]; then echo "${REFUSAL.replace(/"/g, '\\"')}"; exit 1; fi
echo '{"verdict":"SAME","candidate_index":1,"confidence":0.9,"enrich":false,"reasoning":"ok"}'
`
  writeFileSync(join(dir, 'claude'), script)
  chmodSync(join(dir, 'claude'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.LLM_BACKEND = 'claude-code'
})

after(() => {
  process.env.PATH = saved.PATH
  if (saved.LLM_BACKEND === undefined) delete process.env.LLM_BACKEND
  else process.env.LLM_BACKEND = saved.LLM_BACKEND
  if (saved.MODE === undefined) delete process.env.FAKE_CLAUDE_MODE
  else process.env.FAKE_CLAUDE_MODE = saved.MODE
  rmSync(dir, { recursive: true, force: true })
})

function calls(): string[] {
  const p = join(dir, 'calls.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
}
function resetCalls() {
  rmSync(join(dir, 'calls.log'), { force: true })
}

test('the judge tier is Opus 5.5 and the bulk tier is still Haiku 4.5', () => {
  assert.equal(CLAUDE_JUDGMENT_MODEL, 'claude-opus-5-5')
  assert.equal(CLAUDE_BULK_MODEL, 'claude-haiku-4-5')
})

test('the CLI is asked for the exact model id, never an alias', async () => {
  resetCalls()
  process.env.FAKE_CLAUDE_MODE = 'ok'
  await claudeJson('sys', 'user', 100, CLAUDE_JUDGMENT_MODEL)
  await claudeJson('sys', 'user', 100, CLAUDE_BULK_MODEL)
  const [judge, bulk] = calls()
  assert.match(judge, /--model claude-opus-5-5 /)
  assert.match(bulk, /--model claude-haiku-4-5 /)
  assert.doesNotMatch(judge, /--model opus /)
})

test('a safety-filter refusal surfaces as ModelRefusalError', async () => {
  process.env.FAKE_CLAUDE_MODE = 'refuse'
  await assert.rejects(claudeJson('sys', 'user', 100, CLAUDE_JUDGMENT_MODEL), ModelRefusalError)
})

test('adjudicate() does not retry a refusal', async () => {
  resetCalls()
  process.env.FAKE_CLAUDE_MODE = 'refuse'
  await assert.rejects(
    adjudicate('new insight', [{ id: 'c1', canonical_statement: 'existing claim', context_note: null, similarity: 0.75 }]),
    ModelRefusalError
  )
  assert.equal(calls().length, 1)
})
