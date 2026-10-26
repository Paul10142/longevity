/**
 * Ask the Library on the `claude-code` backend (Paul's subscription, design §5.1):
 * backend choice, the single-delta event sequence, $0 cost, and "never fall back
 * to the API". A fake `claude` binary on PATH stands in for the CLI and the
 * database and embedding calls are injected, so there are no model calls.
 *
 *   npm test
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliUnavailableError, llmBackend, ModelRefusalError } from '../lib/llm'
import { PipelineHaltError, UsageLimitError } from '../lib/usageLimit'
import { ask, failureMessage, type AskDeps } from '../lib/ask/ask'
import { composeBrief } from '../lib/ask/compose'
import { costUsd } from '../lib/ask/cost'
import type { AnswerRow } from '../lib/ask/store'
import type { AskEvent, Candidate } from '../lib/ask/types'

const BRIEF =
  'Higher VO2 max goes with lower all-cause mortality. [2]\n\n' +
  '### What To Do\n- Train at high aerobic intensity a few times a week. [1, 2]\n\n' +
  'FOLLOW_UPS:\n- How is VO2 max measured?\n- Does age change the effect?\n- What about zone 2 work?'

let dir = ''
const saved = {
  PATH: process.env.PATH,
  LLM_BACKEND: process.env.LLM_BACKEND,
  KEY: process.env.ANTHROPIC_API_KEY,
  FALLBACK: process.env.LLM_FALLBACK_TO_API,
  MODE: process.env.FAKE_CLAUDE_MODE,
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-ask-'))
  // Logs its argv (one line per call) and answers per FAKE_CLAUDE_MODE.
  const script = `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "${dir}/calls.log"
echo >> "${dir}/calls.log"
cat > /dev/null
if [ "$FAKE_CLAUDE_MODE" = signedout ]; then echo "Not logged in · Please run /login"; exit 1; fi
cat <<'BRIEF_END'
${BRIEF}
BRIEF_END
`
  writeFileSync(join(dir, 'claude'), script)
  chmodSync(join(dir, 'claude'), 0o755)
})

beforeEach(() => {
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.LLM_BACKEND = 'claude-code'
  process.env.FAKE_CLAUDE_MODE = 'ok'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.LLM_FALLBACK_TO_API
  rmSync(join(dir, 'calls.log'), { force: true })
})

after(() => {
  restore('PATH', saved.PATH)
  restore('LLM_BACKEND', saved.LLM_BACKEND)
  restore('ANTHROPIC_API_KEY', saved.KEY)
  restore('LLM_FALLBACK_TO_API', saved.FALLBACK)
  restore('FAKE_CLAUDE_MODE', saved.MODE)
  rmSync(dir, { recursive: true, force: true })
})

function calls(): string[] {
  const p = join(dir, 'calls.log')
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : []
}

function cand(id: string, statement: string): Candidate {
  return { id, statement, context: null, evidenceType: 'RCT', importance: 3, sourceCount: 2, insightType: 'finding', latestDate: '2026-01-01', similarity: 0.8, score: 0.85 }
}

/** Everything ask() reaches outside itself, faked: three candidates, no models, no database. */
function fakeDeps(over: Partial<AskDeps> = {}): { deps: Partial<AskDeps>; saved: unknown[] } {
  const savedRows: unknown[] = []
  const deps: Partial<AskDeps> = {
    embed: async () => [0.1, 0.2],
    embedMany: async () => [],
    corpusCount: async () => 42_000,
    cacheLookup: async () => null,
    expand: async q => [q],
    retrieve: async () => ({
      candidates: [cand('claim-a', 'First claim.'), cand('claim-b', 'Second claim.'), cand('claim-c', 'Third claim.')],
      collapsed: [],
      tier: 'ok',
      perQueryCounts: [3],
      unionSize: 3,
    }),
    contradictions: async () => [],
    relatedTopics: async () => [],
    save: async row => {
      savedRows.push(row)
      return 'answer-1'
    },
    ...over,
  }
  return { deps, saved: savedRows }
}

async function runAsk(deps: Partial<AskDeps>): Promise<{ events: AskEvent[]; scheduled: number }> {
  const events: AskEvent[] = []
  let scheduled = 0
  await ask('How should I train to raise VO2 max?', { emit: e => events.push(e), schedule: () => void scheduled++, deps })
  return { events, scheduled }
}

// --- backend choice ---------------------------------------------------------

test('llmBackend follows LLM_BACKEND and defaults to the API', () => {
  delete process.env.LLM_BACKEND
  assert.equal(llmBackend(), 'api')
  process.env.LLM_BACKEND = 'api'
  assert.equal(llmBackend(), 'api')
  process.env.LLM_BACKEND = 'claude-code'
  assert.equal(llmBackend(), 'claude-code')
  process.env.LLM_BACKEND = 'something-else'
  assert.equal(llmBackend(), 'api')
})

test('subscription answers cost $0; API answers keep list prices', () => {
  assert.equal(costUsd('claude-opus-5-5', 1_000_000, 1_000_000, 'claude-code'), 0)
  assert.equal(costUsd('claude-opus-5-5', 1_000_000, 1_000_000, 'api'), 24)
  assert.equal(costUsd('claude-opus-5-5', 1_000_000, 1_000_000), 24)
})

// --- the composer through the CLI -------------------------------------------

test('composeBrief on claude-code hands over the whole brief in ONE piece, via the CLI, with no API key', async () => {
  const pieces: string[] = []
  const res = await composeBrief({ question: 'q', candidates: [cand('a', 'A.'), cand('b', 'B.')], contradictions: [], thin: false }, d => pieces.push(d))
  assert.equal(pieces.length, 1)
  assert.match(pieces[0], /^Higher VO2 max/)
  assert.match(pieces[0], /FOLLOW_UPS:/)
  assert.equal(res.text, pieces[0])
  assert.equal(res.model, 'claude-opus-5-5')
  assert.equal(res.inputTokens, 0)
  assert.equal(res.firstTokenMs, null)
  const [call] = calls()
  assert.equal(calls().length, 1)
  assert.match(call, /--model claude-opus-5-5 /)
  assert.match(call, /--effort low /)
})

test('a signed-out CLI is a clear error, and the API is NOT used even when a fallback is configured', async () => {
  process.env.FAKE_CLAUDE_MODE = 'signedout'
  process.env.LLM_FALLBACK_TO_API = '1'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key'
  await assert.rejects(
    composeBrief({ question: 'q', candidates: [cand('a', 'A.')], contradictions: [], thin: false }, () => {}),
    (e: unknown) => e instanceof CliUnavailableError && /not signed in/.test(e.message)
  )
  assert.equal(calls().length, 1, 'the CLI was tried once; nothing else answered')
})

test('a missing CLI is a clear error', async () => {
  process.env.PATH = join(dir, 'nowhere')
  await assert.rejects(
    composeBrief({ question: 'q', candidates: [cand('a', 'A.')], contradictions: [], thin: false }, () => {}),
    (e: unknown) => e instanceof CliUnavailableError && /not found/.test(e.message)
  )
})

// --- the event sequence -----------------------------------------------------

test('ask on claude-code: retrieval, ONE delta with the finished brief, done; stored as $0 subscription', async () => {
  const { deps, saved: rows } = fakeDeps()
  const { events, scheduled } = await runAsk(deps)

  assert.deepEqual(events.map(e => e.type), ['retrieval', 'delta', 'done'])
  const delta = events[1] as Extract<AskEvent, { type: 'delta' }>
  const done = events[2] as Extract<AskEvent, { type: 'done' }>
  // Markers renumbered by first appearance (candidate 2 -> [1], candidate 1 -> [2]); follow-ups never in the text.
  assert.match(delta.text, /mortality\. \[1\]/)
  assert.match(delta.text, /intensity a few times a week\. \[2\]\[1\]|\[1\]\[2\]/)
  assert.doesNotMatch(delta.text, /FOLLOW_UPS/)
  assert.equal(done.body, delta.text)
  assert.deepEqual(done.cited, [{ n: 1, claim_id: 'claim-b' }, { n: 2, claim_id: 'claim-a' }])
  assert.equal(done.follow_ups.length, 3)
  assert.equal(done.answer_id, 'answer-1')
  assert.equal(scheduled, 1, 'the audit is scheduled after the response')

  const row = rows[0] as Omit<AnswerRow, 'id' | 'created_at'>
  assert.equal(row.backend, 'claude-code')
  assert.equal(row.model, 'claude-opus-5-5')
  assert.equal(row.input_tokens, null)
  assert.equal(row.output_tokens, null)
  assert.ok(row.first_token_ms !== null && row.first_token_ms >= 0)
  const stats = row.stage_stats as Record<string, unknown>
  assert.equal(stats.backend, 'claude-code')
  assert.equal(stats.billing, 'subscription')
  assert.equal(stats.cost_usd, 0)
})

test('ask on claude-code with a signed-out CLI: an error event naming the fix, a failed row, no API call', async () => {
  process.env.FAKE_CLAUDE_MODE = 'signedout'
  const { deps, saved: rows } = fakeDeps()
  const { events, scheduled } = await runAsk(deps)

  assert.deepEqual(events.map(e => e.type), ['retrieval', 'error'])
  const err = events[1] as Extract<AskEvent, { type: 'error' }>
  assert.match(err.message, /LLM_BACKEND=claude-code/)
  assert.match(err.message, /not signed in/)
  assert.equal(scheduled, 0)
  const row = rows[0] as Omit<AnswerRow, 'id' | 'created_at'>
  assert.equal(row.status, 'failed')
  assert.equal(row.backend, 'claude-code')
})

test('failureMessage: plain words for each way the CLI can fail', () => {
  assert.match(failureMessage(new ModelRefusalError('claude-opus-5-5', 'x')), /declined/)
  assert.match(failureMessage(new CliUnavailableError('missing')), /not found/)
  assert.match(failureMessage(new UsageLimitError('reached', Date.now() + 3_600_000)), /usage window is full/)
  assert.match(failureMessage(new PipelineHaltError(5, 'boom')), /restart the dev server/)
  assert.match(failureMessage(new Error('anything else')), /Something went wrong/)
})
