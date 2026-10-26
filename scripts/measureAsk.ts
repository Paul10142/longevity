/**
 * Measure the Ask the Library question path on real questions (design §7).
 *
 *   npx tsx --env-file=.env.local scripts/measureAsk.ts [--refresh] ["a question" ...]
 *
 * Runs `ask()` in-process (no HTTP), times the first streamed word and the full
 * answer from the caller's side, waits for the async audit, then reads each
 * stored row back and prints a markdown table: candidates returned, first-token
 * and total latency, tokens and cost per stage. Answers are written to
 * `ask_answers` with asked_by = 'measure' (they ARE real answers and will serve
 * as cache hits, hence --refresh to force a fresh run).
 *
 * Bills the API (about $0.10 per question): the API backend is forced.
 */
process.env.LLM_BACKEND = 'api'

import { ask } from '../lib/ask/ask'
import { loadAnswer } from '../lib/ask/store'
import type { AskEvent } from '../lib/ask/types'

const DEFAULT_QUESTIONS = [
  'What is the evidence that VO2 max predicts mortality, and how should I train to improve it?',
  'How much protein per day should an older adult eat to preserve muscle?',
  'When should a statin or other ApoB-lowering therapy be started in a patient with a normal LDL?',
  'What are the risks and benefits of GLP-1 agonists for weight loss in people without diabetes?',
  'Which sleep interventions have the best evidence for improving deep sleep?',
]

type Stats = Record<string, any>

async function main() {
  const args = process.argv.slice(2)
  const refresh = args.includes('--refresh')
  const given = args.filter(a => !a.startsWith('--'))
  const questions = given.length ? given : DEFAULT_QUESTIONS

  const rows: string[] = []
  const details: unknown[] = []
  for (const q of questions) {
    const events: AskEvent[] = []
    const later: (() => Promise<void>)[] = []
    const t0 = Date.now()
    let firstDeltaMs: number | null = null
    let doneMs: number | null = null
    await ask(q, {
      refresh,
      askedBy: 'measure',
      schedule: fn => { later.push(fn) },
      emit: e => {
        events.push(e)
        if (e.type === 'delta' && firstDeltaMs === null) firstDeltaMs = Date.now() - t0
        if (e.type === 'done' || e.type === 'not_covered' || e.type === 'error') doneMs = Date.now() - t0
      },
    })
    await Promise.all(later.map(fn => fn()))

    const last = events[events.length - 1]
    const id = last && 'answer_id' in last ? last.answer_id : null
    const row = id ? await loadAnswer(id) : null
    const s: Stats = row?.stage_stats ?? {}
    const opus = s.tokens?.['claude-opus-5-5']
    const haiku = s.tokens?.['claude-haiku-5-5']
    const audit = s.audit ?? {}
    const auditCost = ((audit.input_tokens ?? 0) * 0.1 + (audit.output_tokens ?? 0) * 0.5) / 1e6
    const cost = (s.cost_usd ?? 0) + auditCost
    const f = (n: unknown, d = 1) => (typeof n === 'number' ? (n / 1000).toFixed(d) : '–')

    console.log(`\n## ${q}\nstatus: ${row?.status ?? last?.type}   cited: ${row?.cited_claim_ids.length ?? 0}   groundedness: ${row?.groundedness_score ?? '–'}   dangling: ${row?.dangling_markers ?? 0}`)
    console.log(`stages (s): embed ${f(s.embed_ms)}  expand ${f(s.expand_ms)}  embed-phrasings ${f(s.embed_phrasings_ms)}  retrieve ${f(s.retrieve_ms)}  provenance ${f(s.provenance_ms)}  compose ${f(s.compose_ms)}  audit ${f(audit.ms)}`)
    rows.push(
      `| ${q.slice(0, 60)}${q.length > 60 ? '…' : ''} | ${s.candidates ?? '–'} (union ${s.union_size ?? '–'}) | ${f(firstDeltaMs)} | ${f(doneMs)} | ` +
        `${haiku ? `${haiku.input_tokens}/${haiku.output_tokens}` : '–'} | ${opus ? `${opus.input_tokens}/${opus.output_tokens}` : '–'} | ` +
        `${audit.input_tokens != null ? `${audit.input_tokens}/${audit.output_tokens}` : '–'} | $${cost.toFixed(3)} |`
    )
    details.push({ question: q, events: events.filter(e => e.type !== 'delta'), stage_stats: s, groundedness: row?.groundedness_score, body: row?.body_markdown })
  }

  console.log('\n| Question | Candidates | First Word (s) | Total (s) | Expand Tokens In/Out | Compose Tokens In/Out | Audit Tokens In/Out | Cost |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const r of rows) console.log(r)
  if (process.env.MEASURE_JSON) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.MEASURE_JSON, JSON.stringify(details, null, 2))
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
