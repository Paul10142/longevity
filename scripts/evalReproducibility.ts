/**
 * Extraction reproducibility harness (2026-11-08). Plan: docs/plans/extraction-reproducibility.md
 * (branch claude/extraction-reproducibility-plan-f7ad7a), section 3.
 *
 *   npx tsx --env-file=/Users/paulclancy/_lifestyleacademy/.env.local scripts/evalReproducibility.ts <command>
 *
 * Does extraction give the same facts twice? Re-extracts one transcript copy (or its near-identical
 * twin) several times with a chosen configuration, matches the passes against each other, and reports
 * the pass-specific rate, passage-coverage disagreement, boundary share and the rest of plan 3.1.
 *
 * It NEVER writes to the database: `fetch` is the only DB access and it only reads (`fidelity` touches no DB at all). Everything else is
 * JSON/Markdown under scratchpad/extraction-compare/reproducibility/ (gitignored except REPORT.md and summary.json).
 *
 * Commands
 *   fetch [id8…]        Read transcript, timed_transcript, stored chunks and stored insights → inputs/<id8>.json.
 *   chunk <id8> [--mode chars|turns] [--context N] [--hygiene off|cached|live]
 *                       Plan the chunks locally (no extraction) → chunks/<id8>.<mode>-c<N>-<hygiene>.json and a size summary.
 *   extract <id8> --pass <n> [--prompt v1|v2|exhaustive] [--model <id>] [--mode chars|turns] [--context N]
 *                [--hygiene off|cached|live] [--gate on|off] [--repair on|off] [--conc N] [--tag <name>] [--allow-draft]
 *                       One pass over the chunk set → passes/<id8>.<tag>.pass<n>.json. Resumable per chunk (rerun the same command).
 *   match <ref> <ref> [--exp <label>] [--lexical]
 *                       <ref> = <id8>:<tag>:<n> or stored:<id8>. Tiers 1–2 → matches/<a>__<b>.json and the headline numbers.
 *                       --lexical = offline statement similarity (no embeddings call). Tier 3 (--judge) is E6's `replay` (later).
 *   fidelity <ref…> [--conc N] [--dry] [--limit N]
 *                       Judge every insight of each pass with the production extraction-fidelity judge
 *                       (lib/extractionFidelity.ts, the one behind \`flagClaims.ts fidelity\` and PR #59's report)
 *                       against the chunk text it was extracted from → fidelity/<id8>.<tag>.pass<n>.json
 *                       (stored:<id8> judges the stored insights → fidelity/stored.<id8>.json). Resumable. --dry writes nothing.
 *   report              REPORT.md + summary.json (matches, passes, fidelity flag rate) from every file on disk.
 *   baseline            Print the plan's section 1 numbers (the "before" column).
 *
 * Needs LLM_BACKEND=claude-code (set here, and refused otherwise). Runs ~/.claude/usage-guard/check.sh before
 * every pass and every chunk and stops when it exits non-zero. Concurrency defaults to 8 and refuses 16.
 * Never run during a pipeline run.
 */

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_BULK_MODEL, CLAUDE_JUDGMENT_MODEL, llmBackend, trackCliCost } from '../lib/llm'
import { judgeFidelity, isRealFidelity, FIDELITY_JUDGE_SYSTEM } from '../lib/extractionFidelity'
import {
  FIDELITY_BASELINE, tallyFidelity, poolTallies, compareToBaseline, quoteFitsChunk, quoteFitShare, chunkTextOf, speakerAttributionFlags,
  type JudgedRow, type FidelityTally, type BaselineComparison,
} from '../lib/reproFidelity'
import {
  extractFromChunkDetailed, callExtractionModel, normalizeInsights, withVideoCheckNote, extractionConfig, resolveQuote,
} from '../lib/extraction'
import { applyGate, describeViolation } from '../lib/extractionGate'
import { EXTRACTION_SYSTEM_PROMPT_V2, EXTRACTION_REPAIR_PROMPT_V2 } from '../lib/extractionPromptV2'
import {
  EXTRACTION_SYSTEM_PROMPT_EXHAUSTIVE, EXHAUSTIVE_PROMPT_STATUS, CONTEXT_ADDENDUM, CONTEXT_HEADERS,
} from '../lib/extractionPromptExhaustive'
import { stripNonContent } from '../lib/transcriptHygiene'
import { rethrowIfUsageLimit, UsageLimitError, PipelineHaltError } from '../lib/usageLimit'
import { createLimiter } from '../lib/concurrency'
import { showForSource, isHostName } from '../lib/shows'
import { bareNames } from '../lib/personName'
import { generateEmbeddingsBatch, insightEmbeddingText } from '../lib/embeddings'
import {
  applyRemovals, chunkChars, chunkTurns, contextWindow, docFromUnits, docToRaw, keepUnits, segmentUnits,
  buildAnchorMap, mapOffset, IDENTITY_MAP, TIER2_COSINE, TIER2_LEXICAL, cosine, lexicalSim, matchOneWay, summariseDirection, withinPassDuplicates,
  fixedBins, turnBins, coverage, disagreement,
  type Doc, type RemovedRange, type MatchInsight, type Unit, type Direction,
} from '../lib/reproducibility'

export const OUT = 'scratchpad/extraction-compare/reproducibility'
export const TWINS: Record<string, string> = {
  '291281d6': '291281d6-1ede-41dc-becd-deba77333d7c',
  '3d6c7c5f': '3d6c7c5f-ba1b-4587-8b7d-30cc8e74cd2c',
}

/** Plan section 1 (the "before" column). */
const BASELINE = {
  passSpecificAfterConsolidation: { A: 0.23, B: 0.16 },
  identicalQuoteSplits: 21,
  boundaryShare: { onlyOne: 0.366, both: 0.29 },
  bar: { passSpecific: 0.05, coverageDisagreement: 0.05, fidelityFlagPoints: 2 },
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
const writeJson = (p: string, v: unknown, pretty = true) => {
  const tmp = `${p}.tmp`
  writeFileSync(tmp, pretty ? JSON.stringify(v, null, 1) : JSON.stringify(v))
  renameSync(tmp, p)
}
const sub = (name: string) => { const d = join(OUT, name); mkdirSync(d, { recursive: true }); return d }
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(d)}%`)

type Tokens = { input: number; output: number; cacheRead: number; cacheCreate: number }
const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreate: a.cacheCreate + b.cacheCreate,
})

function usageOk(): boolean {
  try { execSync('sh ~/.claude/usage-guard/check.sh', { stdio: 'pipe' }); return true } catch (e) {
    console.error(String((e as { stdout?: Buffer }).stdout ?? e).trim())
    return false
  }
}

function usageNow(): { at: string; fiveHour: number | null; sevenDay: number | null } | null {
  try {
    const u = JSON.parse(readFileSync(join(homedir(), '.claude/state/usage.json'), 'utf8'))
    return { at: u.at, fiveHour: u.fiveHour?.utilization ?? null, sevenDay: u.sevenDay?.utilization ?? null }
  } catch { return null }
}

// ── inputs ──────────────────────────────────────────────────

type Input = {
  id: string; title: string; transcript: string
  timed_transcript: { text: string; start_ms: number; end_ms: number }[] | null
  authors: string[] | null; series: string | null; external_id: string | null
  chunks: { id: string; locator: string; content: string; start_ms: number | null; end_ms: number | null }[]
  raw_insights: {
    id: string; chunk_id: string; locator: string; statement: string; context_note: string | null; direct_quote: string | null
    speaker: string | null; insight_type: string | null; quote_char_start: number | null; quote_char_end: number | null
  }[]
}
const loadInput = (id8: string): Input => {
  const f = join(OUT, 'inputs', `${TWINS[id8] ? id8 : id8.slice(0, 8)}.json`)
  if (!existsSync(f)) throw new Error(`no input for ${id8}: run \`fetch\` first`)
  return readJson<Input>(f)
}

/** The participant line production builds (lib/extraction.ts extractSource), from the stored metadata. */
function participantsFor(inp: Input): string {
  const show = showForSource({ series: inp.series, external_id: inp.external_id, authors: inp.authors })
  const guests = bareNames(inp.authors ?? [], name => isHostName(show, name))
  return `Host: ${show.hostLabel} (the interviewer).` +
    (guests.length > 0
      ? ` Guest(s): ${guests.join(', ')}.`
      : ` Guest names are unavailable — attribute a statement ONLY when the dialogue itself makes the speaker unambiguous; otherwise return null. Do not assume the host is speaking.`)
}

// ── fetch (read-only) ───────────────────────────────────────

async function fetchInputs(ids: string[]): Promise<void> {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase admin client not configured')
  for (const raw of ids) {
    const id = TWINS[raw] ?? raw
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`need a full uuid or a known id8, got ${raw}`)
    const { data: s, error } = await db.from('sources')
      .select('id, title, transcript, timed_transcript, authors, series, external_id, processing_status, duplicate_of')
      .eq('id', id).single()
    if (error || !s) throw new Error(`source ${id}: ${error?.message}`)
    const { data: chunkRows, error: ce } = await db.from('chunks')
      .select('id, locator, content, start_ms, end_ms').eq('source_id', id).order('locator', { ascending: true })
    if (ce) throw new Error(`chunks ${id}: ${ce.message}`)
    const insights: Record<string, unknown>[] = []
    for (let from = 0; ; from += 1000) {
      const { data: page, error: ie } = await db.from('raw_insights')
        .select('id, chunk_id, locator, statement, context_note, direct_quote, speaker, qualifiers, insight_type, quote_char_start, quote_char_end, start_ms, end_ms, extraction_model')
        .eq('source_id', id).order('locator', { ascending: true }).order('id', { ascending: true }).range(from, from + 999)
      if (ie) throw new Error(`raw_insights ${id}: ${ie.message}`)
      insights.push(...(page ?? []))
      if (!page || page.length < 1000) break
    }
    const file = join(sub('inputs'), `${id.slice(0, 8)}.json`)
    writeJson(file, { ...s, chunks: chunkRows ?? [], raw_insights: insights, fetchedAt: new Date().toISOString() })
    console.log(`${id.slice(0, 8)}  transcript ${(s.transcript as string).length} chars, ${(chunkRows ?? []).length} chunks, ${insights.length} stored insights, status ${s.processing_status}  ${s.title}`)
  }
}

// ── chunk plan ──────────────────────────────────────────────

type Mode = 'chars' | 'turns'
type Hygiene = 'off' | 'cached' | 'live'
type PlanChunk = { start: number; end: number; from: number; to: number }

function buildPlan(inp: Input, mode: Mode, ctx: number, removed: RemovedRange[]): { doc: Doc; plan: PlanChunk[]; units: Unit[] | null } {
  const raw = inp.transcript
  if (mode === 'chars') {
    const doc = applyRemovals(raw, removed)
    const plan = chunkChars(doc).map(s => ({ ...s, ...contextWindow(doc.text, s.start, s.end, ctx) }))
    return { doc, plan, units: null }
  }
  if (!inp.timed_transcript?.length) throw new Error('turns mode needs timed_transcript')
  const units = keepUnits(segmentUnits(inp.timed_transcript, raw), removed)
  const { doc, unitDocStart } = docFromUnits(units)
  const plan = chunkTurns(units).map(r => {
    const start = unitDocStart[r.first]
    const end = unitDocStart[r.last] + units[r.last].text.length
    return { start, end, ...contextWindow(doc.text, start, end, ctx) }
  })
  return { doc, plan, units }
}

const hygieneCachePath = (id8: string) => join(sub('hygiene'), `${id8}.json`)

type HygieneOutcome = { removed: RemovedRange[]; ms: number; costUsd: number; tokens: Tokens; replicaExact: boolean | null; source: Hygiene }

async function resolveHygiene(inp: Input, id8: string, mode: Hygiene): Promise<HygieneOutcome> {
  const none: HygieneOutcome = { removed: [], ms: 0, costUsd: 0, tokens: zeroTokens(), replicaExact: null, source: mode }
  if (mode === 'off') return none
  const cache = hygieneCachePath(id8)
  if (mode === 'cached' && existsSync(cache)) return { ...none, removed: readJson<{ removed: RemovedRange[] }>(cache).removed }
  const t0 = Date.now()
  const { result, costUsd, tokens } = await trackCliCost(() => stripNonContent(inp.transcript))
  const removed: RemovedRange[] = result.removed.map(r => ({ start: r.start, end: r.end, kind: r.kind, preview: r.preview.slice(0, 80) }))
  const replicaExact = applyRemovals(inp.transcript, removed).text === result.cleaned
  if (!replicaExact) console.warn(`[hygiene ${id8}] the offset replica does not reproduce the cleaned text exactly; offsets near removals may be off`)
  if (!existsSync(cache)) writeJson(cache, { removed, at: new Date().toISOString(), replicaExact })
  return { removed, ms: Date.now() - t0, costUsd, tokens, replicaExact, source: mode }
}

async function chunkCommand(): Promise<void> {
  const id8 = argv[1]
  if (!id8) throw new Error('usage: chunk <id8> [--mode chars|turns] [--context N] [--hygiene off|cached|live]')
  const mode = (flag('mode') ?? 'chars') as Mode
  const ctx = Number(flag('context') ?? 0)
  const hyg = (flag('hygiene') ?? 'off') as Hygiene
  const inp = loadInput(id8)
  const h = await resolveHygiene(inp, id8, hyg)
  const { doc, plan } = buildPlan(inp, mode, ctx, h.removed)
  const sizes = plan.map(c => c.end - c.start).sort((a, b) => a - b)
  const summary = {
    id8, mode, ctx, hygiene: hyg, rawLen: inp.transcript.length, docLen: doc.text.length, removedSpans: h.removed.length,
    chunks: plan.length, min: sizes[0], median: sizes[sizes.length >> 1], max: sizes[sizes.length - 1],
    covered: plan.reduce((n, c) => n + (c.end - c.start), 0),
  }
  writeJson(join(sub('chunks'), `${id8}.${mode}-c${ctx}-${hyg}.json`), { summary, plan })
  console.log(JSON.stringify(summary))
}

// ── extract ─────────────────────────────────────────────────

type Prompt = 'v1' | 'v2' | 'exhaustive'
type Ins = {
  id: string; statement: string; context_note: string | null; direct_quote: string | null; speaker: string | null
  insight_type: string | null; qualifiers: unknown
  /** Quote span in the chunked doc, and in the copy's raw transcript. */
  quote: [number, number] | null; span: [number, number] | null
  /** Quote start/end relative to the chunk start (negative / past the end when it runs into context). */
  relStart: number | null; relEnd: number | null
}
type ChunkRec = {
  idx: number; ms: number; costUsd: number; calls: number; tokens: Tokens; error?: string
  firstPass: number; gateRejected: number; repairCandidates: number; contextOwnedDropped: number
  insights: Ins[]
}
type Header = {
  id8: string; title: string; pass: number; tag: string
  prompt: Prompt; model: string; backend: string; chunkMode: Mode; context: number; hygiene: Hygiene; gate: boolean; repair: boolean
  participants: string; conc: number
  hygieneRemoved: RemovedRange[]; hygieneReplicaExact: boolean | null; hygieneMs: number; hygieneCostUsd: number; hygieneTokens: Tokens
  rawLen: number; docLen: number; nChunks: number; plan: PlanChunk[]
  startedAt: string; endedAt: string | null; wallMs: number; costUsd: number; tokens: Tokens; calls: number
  usageBefore: ReturnType<typeof usageNow>; usageAfter: ReturnType<typeof usageNow>
  complete: boolean; failedChunks: number
}
type PassFile = { header: Header; chunks: ChunkRec[] }

const passPath = (id8: string, tag: string, n: number) => join(sub('passes'), `${id8}.${tag}.pass${n}.json`)

type ExtractOpts = { prompt: Prompt; model: string; ctx: number; gate: boolean; repair: boolean }

async function extractOne(
  o: ExtractOpts, doc: Doc, c: PlanChunk, participants: string, label: string
): Promise<{ kept: ReturnType<typeof normalizeInsights>; first: number; rejected: number; repaired: number }> {
  const text = doc.text.slice(c.start, c.end)
  // Default path: exactly what production runs.
  if (o.prompt !== 'exhaustive' && o.ctx === 0) {
    const r = await extractFromChunkDetailed(text, label, participants, { model: o.model, promptVersion: o.prompt, gate: o.gate, repair: o.repair })
    return { kept: r.kept, first: r.firstPass.length, rejected: r.rejected.length, repaired: r.repairedCandidates.length }
  }
  if (o.prompt === 'v1') throw new Error('prompt v1 has no context variant')
  const window = doc.text.slice(c.from, c.to)
  const pfx = participants ? `Participants in this recording — ${participants}\n\n` : ''
  const system = (o.prompt === 'exhaustive' ? EXTRACTION_SYSTEM_PROMPT_EXHAUSTIVE : EXTRACTION_SYSTEM_PROMPT_V2) + (o.ctx > 0 ? CONTEXT_ADDENDUM : '')
  const before = doc.text.slice(c.from, c.start).trim()
  const after = doc.text.slice(c.end, c.to).trim()
  const user = o.ctx > 0
    ? `${pfx}${before ? `${CONTEXT_HEADERS.before}\n${before}\n\n` : ''}${CONTEXT_HEADERS.text}\n${text}${after ? `\n\n${CONTEXT_HEADERS.after}\n${after}` : ''}`
    : `${pfx}Text to analyze:\n${text}`
  const parsed = await callExtractionModel(system, user, o.model, label)
  const firstPass = normalizeInsights(parsed.insights)
  if (!o.gate) return { kept: firstPass.map(withVideoCheckNote), first: firstPass.length, rejected: 0, repaired: 0 }
  const first = applyGate(window, firstPass)
  let kept = first.kept
  let repaired = 0
  if (o.repair && first.rejected.length > 0) {
    const problems = first.rejected.map((r, n) => ({ n: n + 1, insight: r.insight, problems: r.violations.map(describeViolation) }))
    try {
      const fixed = await callExtractionModel(
        EXTRACTION_REPAIR_PROMPT_V2,
        `${pfx}Text:\n${window}\n\nInsights to correct (JSON):\n${JSON.stringify(problems)}`,
        o.model, `${label} repair`)
      const candidates = normalizeInsights(
        (Array.isArray(fixed.insights) ? fixed.insights : []).map(x => {
          const inner = (x as { insight?: unknown } | null)?.insight
          return inner && typeof inner === 'object' ? inner : x
        }))
      repaired = candidates.length
      kept = [...kept, ...applyGate(window, candidates).kept]
    } catch (err) { rethrowIfUsageLimit(err) }
  }
  return { kept: kept.map(withVideoCheckNote), first: firstPass.length, rejected: first.rejected.length, repaired }
}

async function extractCommand(): Promise<void> {
  const id8 = argv[1]
  const passNo = Number(flag('pass'))
  if (!id8 || !passNo) throw new Error('usage: extract <id8> --pass <n> [options]')
  if (llmBackend() !== 'claude-code') throw new Error(`LLM_BACKEND must be claude-code (subscription), got ${llmBackend()}`)
  const prompt = (flag('prompt') ?? 'v2') as Prompt
  if (!['v1', 'v2', 'exhaustive'].includes(prompt)) throw new Error(`unknown prompt ${prompt}`)
  if (prompt === 'exhaustive' && EXHAUSTIVE_PROMPT_STATUS !== 'FINAL' && !has('allow-draft'))
    throw new Error('the exhaustive prompt is still a DRAFT (anecdotes wording waits for the plan session); pass --allow-draft only if told to')
  const cfg = extractionConfig({
    promptVersion: prompt === 'v1' ? 'v1' : 'v2', model: flag('model'),
    gate: flag('gate') ? flag('gate') === 'on' : undefined, repair: flag('repair') ? flag('repair') === 'on' : undefined,
  })
  const mode = (flag('mode') ?? 'chars') as Mode
  const ctx = Number(flag('context') ?? 0)
  const hyg = (flag('hygiene') ?? 'live') as Hygiene
  const conc = Number(flag('conc') ?? 8)
  if (!(conc >= 1) || conc >= 16) throw new Error('--conc must be between 1 and 15 (default 8; never 16)')
  const modelShort = cfg.model.replace(/^claude-/, '')
  const tag = flag('tag') ?? `${prompt}-${modelShort}-${mode}${ctx ? `-c${ctx}` : ''}-${hyg}`
  const inp = loadInput(id8)
  const file = passPath(id8, tag, passNo)
  const participants = participantsFor(inp)
  const o: ExtractOpts = { prompt, model: cfg.model, ctx, gate: cfg.gate, repair: cfg.repair }

  let pf: PassFile | null = existsSync(file) ? readJson<PassFile>(file) : null
  if (pf) {
    const h = pf.header
    const same = h.prompt === prompt && h.model === cfg.model && h.chunkMode === mode && h.context === ctx && h.hygiene === hyg && h.gate === cfg.gate && h.repair === cfg.repair
    if (!same) throw new Error(`${file} exists with a different configuration; pick another --tag or pass number`)
  }
  if (!usageOk()) { console.error('usage guard: stopping before the pass'); process.exit(2) }

  const startedAt = pf?.header.startedAt ?? new Date().toISOString()
  const wallBefore = pf?.header.wallMs ?? 0
  const t0 = Date.now()
  let hy: HygieneOutcome
  if (pf) {
    hy = { removed: pf.header.hygieneRemoved, ms: pf.header.hygieneMs, costUsd: pf.header.hygieneCostUsd, tokens: pf.header.hygieneTokens, replicaExact: pf.header.hygieneReplicaExact, source: hyg }
  } else {
    hy = await resolveHygiene(inp, id8, hyg)
    console.log(`[${tag} #${passNo}] hygiene ${hyg}: removed ${hy.removed.length} span(s), ${hy.removed.reduce((n, r) => n + r.end - r.start, 0)} chars, ${hy.ms} ms`)
  }
  const { doc, plan } = buildPlan(inp, mode, ctx, hy.removed)
  if (pf && pf.header.nChunks !== plan.length) throw new Error('chunk plan changed since the first run of this pass; delete the pass file to restart')

  const done = new Map<number, ChunkRec>((pf?.chunks ?? []).filter(c => !c.error).map(c => [c.idx, c]))
  const header: Header = {
    id8, title: inp.title, pass: passNo, tag, prompt, model: cfg.model, backend: llmBackend(), chunkMode: mode, context: ctx, hygiene: hyg,
    gate: cfg.gate, repair: cfg.repair, participants, conc,
    hygieneRemoved: hy.removed, hygieneReplicaExact: hy.replicaExact, hygieneMs: hy.ms, hygieneCostUsd: hy.costUsd, hygieneTokens: hy.tokens,
    rawLen: inp.transcript.length, docLen: doc.text.length, nChunks: plan.length, plan,
    startedAt, endedAt: null, wallMs: 0, costUsd: 0, tokens: zeroTokens(), calls: 0,
    usageBefore: pf?.header.usageBefore ?? usageNow(), usageAfter: null, complete: false, failedChunks: 0,
  }
  const save = () => {
    const chunks = [...done.values()].sort((a, b) => a.idx - b.idx)
    header.wallMs = wallBefore + (Date.now() - t0)
    header.costUsd = hy.costUsd + chunks.reduce((n, c) => n + c.costUsd, 0)
    header.tokens = chunks.reduce((n, c) => addTokens(n, c.tokens), hy.tokens)
    header.calls = chunks.reduce((n, c) => n + c.calls, 0)
    header.failedChunks = plan.length - chunks.filter(c => !c.error).length
    header.complete = chunks.filter(c => !c.error).length === plan.length
    header.usageAfter = usageNow()
    header.endedAt = header.complete ? new Date().toISOString() : null
    writeJson(file, { header, chunks } satisfies PassFile)
  }

  const todo = plan.map((c, idx) => ({ c, idx })).filter(x => !done.has(x.idx))
  console.log(`[${tag} #${passNo}] ${id8} ${prompt} ${cfg.model} ${mode} ctx ${ctx}: ${todo.length}/${plan.length} chunks to do, conc ${conc}`)
  const limiter = createLimiter(conc)
  let stop = false
  let consecutiveFailures = 0
  let finished = 0
  await Promise.all(todo.map(({ c, idx }) => limiter.run(async () => {
    if (stop) return
    if (!usageOk()) { stop = true; console.error('usage guard: stopping; rerun the same command to resume'); return }
    const t1 = Date.now()
    try {
      const { result, costUsd, calls, tokens } = await trackCliCost(() => extractOne(o, doc, c, participants, `${id8} ${idx + 1}/${plan.length}`))
      const searchText = ctx > 0 ? doc.text.slice(c.from, c.to) : doc.text.slice(c.start, c.end)
      const base = ctx > 0 ? c.from : c.start
      const insights: Ins[] = []
      let dropped = 0
      result.kept.forEach(i => {
        const q = resolveQuote(searchText, i.direct_quote)
        let quote: [number, number] | null = null
        let span: [number, number] | null = null
        let relStart: number | null = null
        let relEnd: number | null = null
        if (q.start !== null && q.end !== null) {
          const ds = base + q.start, de = base + q.end
          quote = [ds, de]
          span = [docToRaw(doc, ds), docToRaw(doc, de)]
          relStart = ds - c.start
          relEnd = de - c.start
          // A fact that lies entirely in a context block belongs to the neighbouring chunk.
          if (ctx > 0 && (de <= c.start || ds >= c.end)) { dropped++; return }
        }
        insights.push({
          id: `${passNo}:${idx}:${insights.length}`, statement: i.statement, context_note: i.context_note ?? null, direct_quote: q.text,
          speaker: i.speaker ?? null, insight_type: i.insight_type ?? null, qualifiers: i.qualifiers ?? null, quote, span, relStart, relEnd,
        })
      })
      done.set(idx, { idx, ms: Date.now() - t1, costUsd, calls, tokens, firstPass: result.first, gateRejected: result.rejected, repairCandidates: result.repaired, contextOwnedDropped: dropped, insights })
      consecutiveFailures = 0
    } catch (err) {
      consecutiveFailures++
      done.set(idx, { idx, ms: Date.now() - t1, costUsd: 0, calls: 0, tokens: zeroTokens(), error: String(err instanceof Error ? err.message : err).slice(0, 300), firstPass: 0, gateRejected: 0, repairCandidates: 0, contextOwnedDropped: 0, insights: [] })
      console.error(`  chunk ${idx + 1} failed: ${String(err).slice(0, 160)}`)
      if (consecutiveFailures >= 5) { stop = true; console.error('five chunks failed in a row: stopping (circuit breaker); rerun to resume') }
    }
    finished++
    if (finished % 10 === 0 || finished === todo.length) console.log(`  ${finished}/${todo.length} done, ${Math.round((Date.now() - t0) / 1000)} s`)
    save()
  })))
  save()
  const total = [...done.values()].reduce((n, c) => n + c.insights.length, 0)
  console.log(`[${tag} #${passNo}] ${header.complete ? 'COMPLETE' : `INCOMPLETE (${header.failedChunks} chunks missing; rerun to resume)`}: ${total} insights, ${(total / plan.length).toFixed(2)} per chunk, ${Math.round(header.wallMs / 1000)} s, $${header.costUsd.toFixed(2)} list-price, tokens in ${header.tokens.input} out ${header.tokens.output} cacheRead ${header.tokens.cacheRead} cacheCreate ${header.tokens.cacheCreate}`)
  if (!header.complete) process.exit(stop ? 2 : 3)
}

// ── match ───────────────────────────────────────────────────

type Loaded = {
  label: string; id8: string; raw: string; insights: MatchInsight[]; extra: Map<string, { context_note: string | null }>
  nChunks: number; header: Header | null; units: Unit[] | null; hygieneRemoved: number
}

function loadPass(ref: string): Loaded {
  if (ref.startsWith('stored:')) {
    const id8 = ref.slice(7)
    const inp = loadInput(id8)
    const chunkInfo = new Map<string, { idx: number; offset: number; len: number }>()
    inp.chunks.forEach((c, idx) => {
      let at = inp.transcript.indexOf(c.content)
      if (at < 0) at = inp.transcript.indexOf(c.content.slice(0, 60))
      chunkInfo.set(c.id, { idx, offset: at, len: c.content.length })
    })
    const extra = new Map<string, { context_note: string | null }>()
    const insights: MatchInsight[] = inp.raw_insights.map(r => {
      const ci = chunkInfo.get(r.chunk_id)
      const hasSpan = ci && ci.offset >= 0 && r.quote_char_start !== null && r.quote_char_end !== null
      extra.set(r.id, { context_note: r.context_note })
      return {
        id: r.id, chunk: ci?.idx ?? -1, statement: r.statement, quote: r.direct_quote,
        span: hasSpan ? [ci!.offset + r.quote_char_start!, ci!.offset + r.quote_char_end!] : null,
        relStart: hasSpan ? r.quote_char_start : null, relEnd: hasSpan ? r.quote_char_end : null, chunkLen: ci?.len ?? 0, kind: r.insight_type,
      }
    })
    return { label: ref, id8, raw: inp.transcript, insights, extra, nChunks: inp.chunks.length, header: null, units: unitsOf(inp), hygieneRemoved: 0 }
  }
  const [id8, tag, n] = ref.split(':')
  if (!id8 || !tag || !n) throw new Error(`bad pass ref ${ref}; use <id8>:<tag>:<n> or stored:<id8>`)
  const pf = readJson<PassFile>(passPath(id8, tag, Number(n)))
  if (!pf.header.complete) throw new Error(`pass ${ref} is incomplete (${pf.header.failedChunks} chunks missing)`)
  const inp = loadInput(id8)
  const extra = new Map<string, { context_note: string | null }>()
  const insights: MatchInsight[] = []
  for (const c of pf.chunks) {
    const len = pf.header.plan[c.idx].end - pf.header.plan[c.idx].start
    for (const i of c.insights) {
      extra.set(i.id, { context_note: i.context_note })
      insights.push({ id: i.id, chunk: c.idx, statement: i.statement, quote: i.direct_quote, span: i.span, relStart: i.relStart, relEnd: i.relEnd, chunkLen: len, kind: i.insight_type })
    }
  }
  return { label: ref, id8, raw: inp.transcript, insights, extra, nChunks: pf.header.nChunks, header: pf.header, units: unitsOf(inp), hygieneRemoved: pf.header.hygieneRemoved.length }
}

function unitsOf(inp: Input): Unit[] | null {
  try { return inp.timed_transcript?.length ? segmentUnits(inp.timed_transcript, inp.transcript) : null } catch { return null }
}

async function embedAll(texts: string[]): Promise<Map<string, number[]>> {
  const cacheFile = join(sub('matches'), 'embeddings.json')
  const cache: Record<string, number[]> = existsSync(cacheFile) ? readJson(cacheFile) : {}
  const key = (t: string) => createHash('sha1').update(t).digest('hex')
  const need = [...new Set(texts)].filter(t => !cache[key(t)])
  for (let i = 0; i < need.length; i += 96) {
    const batch = need.slice(i, i + 96)
    const vecs = await generateEmbeddingsBatch(batch)
    batch.forEach((t, j) => { cache[key(t)] = vecs[j] })
  }
  if (need.length) writeJson(cacheFile, cache, false)
  return new Map(texts.map(t => [t, cache[key(t)]]))
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_')

type MatchSummary = {
  exp: string; a: string; b: string; createdAt: string; sameCopy: boolean; similarity: 'embedding' | 'lexical'
  passSpecific: { aToB: number; bToA: number; mean: number }
  /** The same rate over non-anecdote insights (plan 4b: anecdotes count in the bar, and the rate without them is reported too). */
  passSpecificExAnecdotes: { aToB: number; bToA: number; mean: number }
  coverage: { turns: { rate: number; bins: number }; window500: { rate: number; bins: number } }
  boundary: { unmatched: number | null; matched: number | null; nUnmatched: number; nMatched: number }
  dirA: Direction & { perChunk: number }; dirB: Direction & { perChunk: number }
  duplicates: { a: ReturnType<typeof withinPassDuplicates>; b: ReturnType<typeof withinPassDuplicates> }
  passes: { a: PassBrief | null; b: PassBrief | null }
}
type PassBrief = { model: string; prompt: string; chunkMode: string; context: number; hygiene: string; gate: boolean; repair: boolean; wallMs: number; costUsd: number; tokens: Tokens; startedAt: string; endedAt: string | null; hygieneSpans: number; usageBefore: Header['usageBefore']; usageAfter: Header['usageAfter'] }
const brief = (h: Header | null): PassBrief | null => h && ({
  model: h.model, prompt: h.prompt, chunkMode: h.chunkMode, context: h.context, hygiene: h.hygiene, gate: h.gate, repair: h.repair, wallMs: h.wallMs,
  costUsd: h.costUsd, tokens: h.tokens, startedAt: h.startedAt, endedAt: h.endedAt, hygieneSpans: h.hygieneRemoved.length, usageBefore: h.usageBefore, usageAfter: h.usageAfter,
})

async function matchCommand(): Promise<void> {
  const [refA, refB] = [argv[1], argv[2]]
  if (!refA || !refB) throw new Error('usage: match <ref> <ref> [--exp <label>] [--lexical]')
  const exp = flag('exp') ?? 'adhoc'
  const lexical = has('lexical')
  const A = loadPass(refA), B = loadPass(refB)
  const sameCopy = A.id8 === B.id8
  const bToA = sameCopy ? IDENTITY_MAP : buildAnchorMap(B.raw, A.raw)
  const aToB = sameCopy ? IDENTITY_MAP : buildAnchorMap(A.raw, B.raw)

  const textOf = (L: Loaded, i: MatchInsight) => insightEmbeddingText({ statement: i.statement, context_note: L.extra.get(i.id)?.context_note ?? null })
  let simA: (x: MatchInsight, y: MatchInsight) => number
  if (lexical) simA = (x, y) => lexicalSim(x.statement, y.statement)
  else {
    const texts = [...A.insights.map(i => textOf(A, i)), ...B.insights.map(i => textOf(B, i))]
    const vecs = await embedAll(texts)
    const vec = new Map<string, number[]>()
    A.insights.forEach(i => vec.set(`A:${i.id}`, vecs.get(textOf(A, i))!))
    B.insights.forEach(i => vec.set(`B:${i.id}`, vecs.get(textOf(B, i))!))
    // Ids are unique inside a pass only; keep the pass prefix by wrapping the lookups.
    const owner = new Map<MatchInsight, string>()
    A.insights.forEach(i => owner.set(i, 'A')); B.insights.forEach(i => owner.set(i, 'B'))
    simA = (x, y) => cosine(vec.get(`${owner.get(x)}:${x.id}`)!, vec.get(`${owner.get(y)}:${y.id}`)!)
  }
  const thr = lexical ? TIER2_LEXICAL : TIER2_COSINE
  const rowsAB = matchOneWay(A.insights, B.insights, { qToP: n => mapOffset(bToA, n), sim: simA, simThreshold: thr })
  const rowsBA = matchOneWay(B.insights, A.insights, { qToP: n => mapOffset(aToB, n), sim: simA, simThreshold: thr })
  const dirA = summariseDirection(A.insights, rowsAB)
  const dirB = summariseDirection(B.insights, rowsBA)

  // Coverage in A's frame: speaker turns (label to label; only the host is labelled in these transcripts, so coarse) and 500-character windows.
  const aSpans = A.insights.map(i => i.span)
  const bSpansInA = B.insights.map(i => (i.span ? ([mapOffset(bToA, i.span[0]), mapOffset(bToA, i.span[1])] as [number, number]) : null))
  const turns = A.units ? turnBins(A.units, A.raw.length) : fixedBins(A.raw.length, 3500)
  const wins = fixedBins(A.raw.length, 500)
  const covTurns = disagreement(coverage(aSpans, turns), coverage(bSpansInA, turns))
  const covWins = disagreement(coverage(aSpans, wins), coverage(bSpansInA, wins))

  const nU = dirA.boundary.nUnmatched + dirB.boundary.nUnmatched
  const nM = dirA.boundary.nMatched + dirB.boundary.nMatched
  const wavg = (a: number | null, na: number, b: number | null, nb: number) => (na + nb ? ((a ?? 0) * na + (b ?? 0) * nb) / (na + nb) : null)
  const summary: MatchSummary = {
    exp, a: refA, b: refB, createdAt: new Date().toISOString(), sameCopy, similarity: lexical ? 'lexical' : 'embedding',
    passSpecific: { aToB: dirA.passSpecificRate, bToA: dirB.passSpecificRate, mean: (dirA.passSpecificRate + dirB.passSpecificRate) / 2 },
    passSpecificExAnecdotes: { aToB: dirA.passSpecificRateExAnecdotes, bToA: dirB.passSpecificRateExAnecdotes, mean: (dirA.passSpecificRateExAnecdotes + dirB.passSpecificRateExAnecdotes) / 2 },
    coverage: { turns: { rate: covTurns.rate, bins: covTurns.union }, window500: { rate: covWins.rate, bins: covWins.union } },
    boundary: {
      unmatched: wavg(dirA.boundary.unmatched, dirA.boundary.nUnmatched, dirB.boundary.unmatched, dirB.boundary.nUnmatched),
      matched: wavg(dirA.boundary.matched, dirA.boundary.nMatched, dirB.boundary.matched, dirB.boundary.nMatched),
      nUnmatched: nU, nMatched: nM,
    },
    dirA: { ...dirA, perChunk: A.insights.length / A.nChunks }, dirB: { ...dirB, perChunk: B.insights.length / B.nChunks },
    duplicates: { a: withinPassDuplicates(A.insights), b: withinPassDuplicates(B.insights) },
    passes: { a: brief(A.header), b: brief(B.header) },
  }
  // The unmatched same-passage pairs: what E6 replays through the production adjudicator.
  const byId = (L: Loaded) => new Map(L.insights.map(i => [i.id, i]))
  const idxA = byId(A), idxB = byId(B)
  const misses = [
    ...rowsAB.filter(r => !r.matched && r.samePassage && r.passagePartner).map(r => ({ from: 'A', x: idxA.get(r.id)!, y: idxB.get(r.passagePartner!)!, sim: r.bestSim })),
    ...rowsBA.filter(r => !r.matched && r.samePassage && r.passagePartner).map(r => ({ from: 'B', x: idxB.get(r.id)!, y: idxA.get(r.passagePartner!)!, sim: r.bestSim })),
  ].map(m => ({ from: m.from, sim: m.sim, xId: m.x.id, xStatement: m.x.statement, xQuote: m.x.quote, yId: m.y.id, yStatement: m.y.statement, yQuote: m.y.quote }))
  writeJson(join(sub('matches'), `${safe(refA)}__${safe(refB)}.json`), { summary, rowsAB, rowsBA, samePassageMisses: misses })

  console.log(`\n${exp}: ${refA}  vs  ${refB}  (${lexical ? 'lexical' : 'embedding'} tier 2)`)
  console.log(`  insights: A ${A.insights.length} (${(A.insights.length / A.nChunks).toFixed(2)}/chunk over ${A.nChunks} chunks), B ${B.insights.length} (${(B.insights.length / B.nChunks).toFixed(2)}/chunk over ${B.nChunks})`)
  console.log(`  pass-specific: A→B ${pct(dirA.passSpecificRate)}  B→A ${pct(dirB.passSpecificRate)}  mean ${pct(summary.passSpecific.mean)}   (bar < 5%; plan baseline post-consolidation 23% / 16%)`)
  console.log(`  pass-specific without anecdotes: A→B ${pct(dirA.passSpecificRateExAnecdotes)} (n ${dirA.nExAnecdotes})  B→A ${pct(dirB.passSpecificRateExAnecdotes)} (n ${dirB.nExAnecdotes})  mean ${pct(summary.passSpecificExAnecdotes.mean)}   (anecdotes count toward the bar above; this is for reference)`)
  console.log(`  matched by quote ${dirA.tier1 + dirB.tier1}, by meaning ${dirA.tier2 + dirB.tier2}; same-passage misses A ${dirA.samePassageMiss} B ${dirB.samePassageMiss}; unmatched with no quote span A ${dirA.unmatchedNoSpan} B ${dirB.unmatchedNoSpan}`)
  console.log(`  coverage disagreement: turns ${pct(covTurns.rate)} of ${covTurns.union} bins; 500-char windows ${pct(covWins.rate)} of ${covWins.union} bins   (bar < 5%)`)
  console.log(`  boundary share (first/last ${300} chars of chunk): unmatched ${pct(summary.boundary.unmatched)} (n ${nU}) vs matched ${pct(summary.boundary.matched)} (n ${nM})   (plan baseline 36.6% vs 29.0%)`)
  console.log(`  repeated quotes inside one pass: A ${summary.duplicates.a.total} overlapping (${summary.duplicates.a.sameChunk} same chunk), ${summary.duplicates.a.identical} identical; B ${summary.duplicates.b.total} overlapping (${summary.duplicates.b.sameChunk} same chunk), ${summary.duplicates.b.identical} identical   (plan baseline: 21 identical-quote splits)`)
}

// ── report ──────────────────────────────────────────────────

// ── fidelity flag rate (report section) ─────────────────────

type FidelityEntry = { file: string; header: FidelityHeader; tally: FidelityTally; speakerFlags: number; setup: 'new' | 'old' | 'other'; reference: { label: string; rate: number } | null; vs: BaselineComparison | null }

/** Which PR #59 figure a judged pass is compared with. Only the new setup (Opus 5.5, v2 prompt, gate on) is held to Paul's +2 points. */
function fidelitySetup(h: FidelityHeader): FidelityEntry['setup'] {
  const c = h.passConfig
  if (!c) return 'old' // stored insights: Haiku 4.5, v1 prompt (the library's current extraction)
  if (c.model.includes('opus') && c.gate) return 'new'
  if (c.model.includes('haiku') && !c.gate) return 'old'
  return 'other'
}

function loadFidelity(): FidelityEntry[] {
  const dir = join(OUT, 'fidelity')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const ff = readJson<FidelityFile>(join(dir, f))
    const tally = tallyFidelity(ff.rows, ff.header.nInsights)
    const setup = fidelitySetup(ff.header)
    const reference = setup === 'new' ? { label: 'PR #59, Opus 5.5 new setup', rate: FIDELITY_BASELINE.opus55NewSetup.rate }
      : setup === 'old' ? { label: 'PR #59, Haiku 4.5 stored', rate: FIDELITY_BASELINE.haiku45OldSetup.rate } : null
    return { file: f, header: ff.header, tally, speakerFlags: speakerAttributionFlags(ff.rows), setup, reference, vs: reference ? compareToBaseline(tally, reference.rate) : null }
  }).sort((x, y) => (x.header.tag ?? '~').localeCompare(y.header.tag ?? '~') || x.header.id8.localeCompare(y.header.id8) || (x.header.pass ?? 0) - (y.header.pass ?? 0))
}

const pts = (n: number | null) => (n === null ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}`)
const ci = (t: FidelityTally) => (t.ci ? `${pct(t.rate)} (${pct(t.ci[0])} to ${pct(t.ci[1])})` : 'n/a')
const barText = (e: { setup: string; vs: BaselineComparison | null }) =>
  e.setup !== 'new' ? 'not held to the bar (old setup)' : e.vs?.meetsBar === null || !e.vs ? 'n/a' : e.vs.meetsBar ? 'meets (+2 or less)' : 'misses (more than +2)'

function fidelityLines(entries: FidelityEntry[]): { lines: string[]; pooled: { tag: string; passes: number; tally: FidelityTally; speakerFlags: number; vs: BaselineComparison }[] } {
  const L: string[] = []
  const pooled: { tag: string; passes: number; tally: FidelityTally; speakerFlags: number; vs: BaselineComparison }[] = []
  if (entries.length === 0) return { lines: [], pooled }
  const judge = entries[0].header
  L.push('## Fidelity Flag Rate', '')
  L.push(`Paul's third condition: the fidelity flag rate on the new setup is at most 2 points above PR #59's Opus 5.5 figure (${pct(FIDELITY_BASELINE.opus55NewSetup.rate)}, so at most ${pct(FIDELITY_BASELINE.opus55NewSetup.rate + FIDELITY_BASELINE.barPoints / 100)}), so a more complete extraction cannot pass by inventing.`)
  L.push(`Judge: the production extraction-fidelity judge (lib/extractionFidelity.ts, \`judgeFidelity\`, the function behind \`extraction_fidelity\` flagging and PR #59's report), model ${judge.judgeModel}, prompt fingerprint ${judge.judgePromptSha}. Each insight is judged against the exact chunk text it was extracted from (rebuilt from the pass file and checked against the pass's recorded chunk plan). Flag rate = (ADDED_DETAIL + DROPPED_QUALIFIER + UNRESOLVED_REFERENCE) / insights with a real verdict, the definition PR #59 used. UNSURE counts as judged and not flagged. No database access.`, '')
  L.push('| Judged pass | Setup | Insights | Judged | Flagged | Flag rate (95% interval) | Added detail / Dropped qualifier / Unresolved reference | Unsure | Reference | Difference (points) | Bar (+2 points) | Quote found in chunk |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const e of entries) {
    const h = e.header, c = h.passConfig, t = e.tally
    const setup = c ? `${c.model.replace(/^claude-/, '')}, prompt ${c.prompt}, gate ${c.gate ? 'on' : 'off'}${c.repair ? ' + repair' : ''}` : 'stored: haiku-4-5, prompt v1'
    L.push(`| ${h.ref}${h.complete ? '' : ' (INCOMPLETE)'} | ${setup} | ${t.insights} | ${t.judged}${t.errors ? ` (+${t.errors} errored)` : ''} | ${t.flagged} | ${ci(t)} | ${t.addedDetail} / ${t.droppedQualifier} / ${t.unresolvedReference} | ${t.unsure} | ${e.reference ? `${pct(e.reference.rate)} (${e.reference.label})` : 'none'} | ${pts(e.vs?.points ?? null)} | ${barText(e)} | ${pct(h.quoteFitShare)} |`)
  }
  const tags = [...new Set(entries.filter(e => e.setup === 'new' && e.header.kind === 'pass').map(e => e.header.tag!))]
  for (const tag of tags) {
    const group = entries.filter(e => e.setup === 'new' && e.header.tag === tag && e.header.complete)
    if (group.length < 2) continue
    const t = poolTallies(group.map(e => e.tally))
    const vs = compareToBaseline(t, FIDELITY_BASELINE.opus55NewSetup.rate)
    pooled.push({ tag, passes: group.length, tally: t, speakerFlags: group.reduce((n, e) => n + e.speakerFlags, 0), vs })
    L.push(`| **${tag}, ${group.length} passes pooled** | new setup | ${t.insights} | ${t.judged} | ${t.flagged} | **${ci(t)}** | ${t.addedDetail} / ${t.droppedQualifier} / ${t.unresolvedReference} | ${t.unsure} | ${pct(FIDELITY_BASELINE.opus55NewSetup.rate)} (PR #59, Opus 5.5 new setup) | **${pts(vs.points)}** | **${vs.meetsBar ? 'meets (+2 or less)' : 'misses (more than +2)'}** | |`)
  }
  L.push('')
  for (const p of pooled) {
    const iv = p.vs.intervalUnderLimit ? 'the whole 95% interval is under the limit' : p.vs.intervalOverLimit ? 'the whole 95% interval is over the limit' : `the 95% interval (${pct(p.tally.ci![0])} to ${pct(p.tally.ci![1])}) straddles the ${pct(p.vs.limit)} limit`
    L.push(`- **${p.tag} verdict (${p.passes} passes, ${p.tally.judged} insights): ${pct(p.tally.rate)} against ${pct(p.vs.baselineRate)}, ${pts(p.vs.points)} points, ${p.vs.meetsBar ? 'meets' : 'misses'} the +${FIDELITY_BASELINE.barPoints}-point bar;** ${iv}.`)
  }
  for (const p of pooled) {
    const sf = p.speakerFlags, rest = p.tally.flagged - sf
    L.push(`- **What the flags are (heuristic text match on the judge's own reasoning).** Of the ${p.tag} pooled flags, ${sf} of ${p.tally.flagged} say the chunk never names the speaker; without them the rate is ${pct(p.tally.judged ? rest / p.tally.judged : null)}. The extractor is told the participants (Host / Guest names) but the judge is shown the chunk only, so a correct "James Clear said …" counts as ADDED_DETAIL. PR #59's figure was measured the same way, so the +2-point comparison is like-for-like; but a prompt that names speakers more or less often moves the flag rate without any change in invention. Judged old-setup passes: ${entries.filter(e => e.setup === 'old').map(e => `${e.header.ref} ${e.speakerFlags} of ${e.tally.flagged}`).join('; ') || 'none'}.`)
  }
  L.push(`- The reference is a pooled figure over 8 other episodes (Opus 5.5 ranged ${pct(FIDELITY_BASELINE.opus55NewSetup.perEpisodeMin)} to ${pct(FIDELITY_BASELINE.opus55NewSetup.perEpisodeMax)} per episode in PR #59), so one episode's rate is a noisy test of "+2 points": a single episode of about 220 insights has a 95% interval of roughly 3 to 5 points either side.`)
  L.push('- "Quote found in chunk" checks that the quote each insight cites occurs in the chunk text the judge saw; anything under about 95% would mean the rebuilt chunks do not match extraction.', '')
  return { lines: L, pooled }
}

function reportCommand(): void {
  const dir = join(OUT, 'matches')
  const matches: { file: string; summary: MatchSummary }[] = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'embeddings.json').map(f => ({ file: f, summary: readJson<{ summary: MatchSummary }>(join(dir, f)).summary }))
    : []
  matches.sort((x, y) => x.summary.exp.localeCompare(y.summary.exp) || x.summary.createdAt.localeCompare(y.summary.createdAt))
  const passDir = join(OUT, 'passes')
  const passes: Header[] = existsSync(passDir)
    ? readdirSync(passDir).filter(f => f.endsWith('.json')).map(f => readJson<PassFile>(join(passDir, f)).header)
    : []
  passes.sort((x, y) => x.tag.localeCompare(y.tag) || x.id8.localeCompare(y.id8) || x.pass - y.pass)
  const usd = (n: number) => `$${n.toFixed(2)}`
  const mins = (ms: number) => `${(ms / 60000).toFixed(1)} min`
  const tok = (t: Tokens) => `${(t.input / 1000).toFixed(0)}k in / ${(t.output / 1000).toFixed(0)}k out${t.cacheRead ? ` / ${(t.cacheRead / 1000).toFixed(0)}k cached` : ''}`
  const verdict = (s: MatchSummary) => (s.passSpecific.mean < BASELINE.bar.passSpecific && s.coverage.window500.rate < BASELINE.bar.coverageDisagreement ? 'meets both bars' : 'misses the bar')

  const L: string[] = []
  L.push('# Extraction Reproducibility: Experiment Report', '')
  L.push(`Generated ${new Date().toISOString()} by scripts/evalReproducibility.ts. Plan: docs/plans/extraction-reproducibility.md.`)
  L.push('Bar (Paul, 2026-11-08): pass-specific facts < 5%, coverage disagreement < 5%, fidelity flags at most +2 points (the fidelity flag rate is in its own section below).', '')
  L.push('## Before (plan section 1) and After (this harness)', '')
  L.push('| Run | Pass-specific A→B | B→A | Coverage disagreement (500-char / turns) | Boundary share unmatched vs matched | Insights per chunk (A / B) | Identical quotes within one pass (A / B) | Verdict |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  L.push(`| Baseline (plan, post-consolidation, #183) | ${pct(BASELINE.passSpecificAfterConsolidation.A, 0)} | ${pct(BASELINE.passSpecificAfterConsolidation.B, 0)} | not measured | ${pct(BASELINE.boundaryShare.onlyOne)} vs ${pct(BASELINE.boundaryShare.both)} | n/a | ${BASELINE.identicalQuoteSplits} identical-quote splits | misses the bar |`)
  for (const { summary: s } of matches) {
    L.push(`| ${s.exp}: ${s.a} vs ${s.b} | ${pct(s.passSpecific.aToB)} | ${pct(s.passSpecific.bToA)} | ${pct(s.coverage.window500.rate)} / ${pct(s.coverage.turns.rate)} | ${pct(s.boundary.unmatched)} vs ${pct(s.boundary.matched)} | ${s.dirA.perChunk.toFixed(2)} / ${s.dirB.perChunk.toFixed(2)} | ${s.duplicates.a.identical} / ${s.duplicates.b.identical} identical (${s.duplicates.a.total} / ${s.duplicates.b.total} overlapping) | ${verdict(s)} |`)
  }
  L.push('', 'Which coverage definition is the bar? The plan (docs/plans/extraction-reproducibility.md, section 3.1) defines it on speaker turns: "Split the transcript into speaker turns (or 500-character windows when there are no labels)", and the resume criteria (section 0) say "fewer than 5% of speaker turns are covered by one pass but not the other". The 500-character figure is the stricter reading and this report keeps it as its verdict; the turn figure is the plan\'s literal definition. Which one governs is Paul\'s call.')
  L.push('', 'Coverage disagreement counts a 500-character window as covered when any resolved quote of the pass touches it. "Turns" bins run from one speaker label to the next; only the host is labelled in these transcripts, so turn bins are coarse (median about 3.5k characters) and the 500-character figure is the stricter one.', '')
  L.push('## Passes', '')
  L.push('| Pass | Model | Prompt | Chunking | Context | Hygiene | Gate / repair | Wall clock | Tokens | List-price cost | Plan usage (7-day) before → after |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const h of passes) {
    const u0 = h.usageBefore?.sevenDay, u1 = h.usageAfter?.sevenDay
    L.push(`| ${h.id8}:${h.tag}:${h.pass}${h.complete ? '' : ' (INCOMPLETE)'} | ${h.model} | ${h.prompt} | ${h.chunkMode} | ${h.context} | ${h.hygiene} (${h.hygieneRemoved.length} spans) | ${h.gate ? 'on' : 'off'} / ${h.repair ? 'on' : 'off'} | ${mins(h.wallMs)} | ${tok(h.tokens)} | ${usd(h.costUsd)} | ${u0 === null || u0 === undefined ? 'n/a' : pct(u0, 0)} → ${u1 === null || u1 === undefined ? 'n/a' : pct(u1, 0)} |`)
  }
  L.push('', 'List-price cost is the CLI\'s own `total_cost_usd` (what the call would cost at API prices, CLI overhead included); on the subscription it is not billed in dollars. The plan-usage column is the share of the 7-day window at the start and end of the pass (best effort, a rounded reading).', '')
  const fid = loadFidelity()
  const fl = fidelityLines(fid)
  L.push(...fl.lines)
  L.push('## Matches in detail', '')
  for (const { summary: s } of matches) {
    L.push(`### ${s.exp}: ${s.a} vs ${s.b}`, '')
    L.push(`- Tier 2 similarity: ${s.similarity}. Same transcript copy: ${s.sameCopy ? 'yes' : 'no (offsets mapped between the two copies)'}.`)
    L.push(`- Insights: A ${s.dirA.n}, B ${s.dirB.n}. Matched by quote A ${s.dirA.tier1}, B ${s.dirB.tier1}; by meaning A ${s.dirA.tier2}, B ${s.dirB.tier2}.`)
    L.push(`- Unmatched but the other pass quotes the same passage (consolidation-style misses): A ${s.dirA.samePassageMiss} (${pct(s.dirA.samePassageMissRate)}), B ${s.dirB.samePassageMiss} (${pct(s.dirB.samePassageMissRate)}).`)
    L.push(`- Unmatched with no quote located: A ${s.dirA.unmatchedNoSpan}, B ${s.dirB.unmatchedNoSpan}.`, '')
  }
  writeFileSync(join(OUT, 'REPORT.md'), L.join('\n'))
  writeJson(join(OUT, 'summary.json'), { generatedAt: new Date().toISOString(), baseline: BASELINE, matches: matches.map(m => m.summary), passes: passes.map(h => ({ id8: h.id8, tag: h.tag, pass: h.pass, ...brief(h), complete: h.complete, nChunks: h.nChunks })),
    fidelity: {
      baseline: FIDELITY_BASELINE,
      judge: fid[0] ? { model: fid[0].header.judgeModel, promptSha: fid[0].header.judgePromptSha } : null,
      passes: fid.map(e => ({ ref: e.header.ref, setup: e.setup, complete: e.header.complete, tally: e.tally, speakerAttributionFlags: e.speakerFlags, reference: e.reference, vsReference: e.vs, quoteFitShare: e.header.quoteFitShare, wallMs: e.header.wallMs, costUsd: e.header.costUsd })),
      pooled: fl.pooled,
    } })
  console.log(`wrote ${join(OUT, 'REPORT.md')} and summary.json (${matches.length} matches, ${passes.length} passes)`)
}

function baselineCommand(): void {
  console.log('Plan section 1 baselines (the "before" column), episode #183 twin copies A=291281d6 and B=3d6c7c5f:')
  console.log(`  pass-specific after consolidation: A ${pct(BASELINE.passSpecificAfterConsolidation.A, 0)}, B ${pct(BASELINE.passSpecificAfterConsolidation.B, 0)}`)
  console.log(`  identical-quote splits: ${BASELINE.identicalQuoteSplits}`)
  console.log(`  boundary share: ${pct(BASELINE.boundaryShare.onlyOne)} of only-one-pass facts vs ${pct(BASELINE.boundaryShare.both)} of both-pass facts`)
  console.log(`  bar: pass-specific < ${pct(BASELINE.bar.passSpecific, 0)}, coverage disagreement < ${pct(BASELINE.bar.coverageDisagreement, 0)}, fidelity flags at most +${BASELINE.bar.fidelityFlagPoints} points`)
  console.log('  stored raw insights A vs B (cross-check, before consolidation): run  match stored:291281d6 stored:3d6c7c5f --exp baseline')
}

// ── fidelity (judge only; no extraction, no database) ───────

type FidelityHeader = {
  ref: string; id8: string; kind: 'pass' | 'stored'; tag: string | null; pass: number | null; title: string
  /** The extraction setup the judged pass came from (null for stored insights, which Haiku 4.5 + prompt v1 produced). */
  passConfig: { model: string; prompt: string; chunkMode: string; context: number; hygiene: string; gate: boolean; repair: boolean } | null
  judgeModel: string; judgePromptSha: string
  nInsights: number; startedAt: string; endedAt: string | null; wallMs: number; costUsd: number; tokens: Tokens; calls: number
  complete: boolean; quoteFitShare: number | null
}
type FidelityFile = { header: FidelityHeader; rows: JudgedRow[] }

const fidelityPath = (ref: string) => {
  const parts = ref.split(':')
  const name = parts[0] === 'stored' ? `stored.${parts[1]}` : `${parts[0]}.${parts[1]}.pass${parts[2]}`
  return join(sub('fidelity'), `${name}.json`)
}

type FidelityJob = { id: string; chunk: number; statement: string; contextNote: string | null; directQuote: string | null; chunkText: string }

/** The insights of a pass (or the stored library) paired with the exact chunk text each was extracted from. */
function fidelityJobs(ref: string): { jobs: FidelityJob[]; title: string; id8: string; kind: 'pass' | 'stored'; tag: string | null; pass: number | null; passConfig: FidelityHeader['passConfig'] } {
  if (ref.startsWith('stored:')) {
    const id8 = ref.slice(7)
    const inp = loadInput(id8)
    const chunkOf = new Map(inp.chunks.map((c, idx) => [c.id, { idx, content: c.content }]))
    const jobs: FidelityJob[] = []
    for (const r of inp.raw_insights) {
      const c = chunkOf.get(r.chunk_id)
      if (!c) continue
      jobs.push({ id: r.id, chunk: c.idx, statement: r.statement, contextNote: r.context_note, directQuote: r.direct_quote, chunkText: c.content })
    }
    return { jobs, title: inp.title, id8, kind: 'stored', tag: null, pass: null, passConfig: null }
  }
  const [id8, tag, n] = ref.split(':')
  if (!id8 || !tag || !n) throw new Error(`bad pass ref ${ref}; use <id8>:<tag>:<n> or stored:<id8>`)
  const pf = readJson<PassFile>(passPath(id8, tag, Number(n)))
  const h = pf.header
  if (!h.complete) throw new Error(`pass ${ref} is incomplete (${h.failedChunks} chunks missing)`)
  const inp = loadInput(id8)
  // Rebuild the chunk text exactly as extraction saw it: the transcript with this pass's hygiene removals applied, sliced by its plan.
  const { doc, plan } = buildPlan(inp, h.chunkMode, h.context, h.hygieneRemoved)
  if (doc.text.length !== h.docLen || plan.length !== h.nChunks) throw new Error(`${ref}: rebuilt document (${doc.text.length} chars, ${plan.length} chunks) differs from the pass (${h.docLen}, ${h.nChunks})`)
  plan.forEach((c, i) => {
    if (c.start !== h.plan[i].start || c.end !== h.plan[i].end) throw new Error(`${ref}: rebuilt chunk ${i} spans ${c.start}-${c.end}, the pass recorded ${h.plan[i].start}-${h.plan[i].end}`)
  })
  const jobs: FidelityJob[] = []
  for (const c of pf.chunks) {
    const text = chunkTextOf(doc, plan[c.idx])
    for (const i of c.insights) jobs.push({ id: i.id, chunk: c.idx, statement: i.statement, contextNote: i.context_note, directQuote: i.direct_quote, chunkText: text })
  }
  return {
    jobs, title: inp.title, id8, kind: 'pass', tag, pass: Number(n),
    passConfig: { model: h.model, prompt: h.prompt, chunkMode: h.chunkMode, context: h.context, hygiene: h.hygiene, gate: h.gate, repair: h.repair },
  }
}

async function fidelityCommand(): Promise<void> {
  const refs = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--conc', '--limit'].includes(all[i - 1]))
  if (refs.length === 0) throw new Error('usage: fidelity <ref…> [--conc N] [--dry] [--limit N]   (ref = <id8>:<tag>:<n> or stored:<id8>)')
  if (llmBackend() !== 'claude-code') throw new Error(`LLM_BACKEND must be claude-code (subscription), got ${llmBackend()}`)
  const conc = Number(flag('conc') ?? 8)
  if (!(conc >= 1) || conc >= 16) throw new Error('--conc must be between 1 and 15 (default 8; never 16)')
  const dry = has('dry')
  const limit = flag('limit') ? Number(flag('limit')) : undefined
  const sha = createHash('sha1').update(FIDELITY_JUDGE_SYSTEM).digest('hex').slice(0, 10)

  for (const ref of refs) {
    const src = fidelityJobs(ref)
    const jobsAll = limit ? src.jobs.slice(0, limit) : src.jobs
    const file = fidelityPath(ref)
    const prev: FidelityFile | null = existsSync(file) ? readJson<FidelityFile>(file) : null
    if (prev && prev.header.nInsights !== src.jobs.length) throw new Error(`${file} judged ${prev.header.nInsights} insights but ${ref} now has ${src.jobs.length}; delete it to restart`)
    if (prev && prev.header.judgePromptSha !== sha) throw new Error(`${file} was judged with a different judge prompt (${prev.header.judgePromptSha} vs ${sha}); delete it to restart`)
    if (!usageOk()) { console.error('usage guard: stopping before the pass'); process.exit(2) }

    const done = new Map<string, JudgedRow>((prev?.rows ?? []).filter(r => isRealFidelity(r)).map(r => [r.id, r]))
    const todo = jobsAll.filter(j => !done.has(j.id))
    const byChunk = new Map<number, FidelityJob[]>()
    for (const j of todo) byChunk.set(j.chunk, [...(byChunk.get(j.chunk) ?? []), j])
    const wallBefore = prev?.header.wallMs ?? 0
    const t0 = Date.now()
    const startedAt = prev?.header.startedAt ?? new Date().toISOString()
    const header: FidelityHeader = {
      ref, id8: src.id8, kind: src.kind, tag: src.tag, pass: src.pass, title: src.title, passConfig: src.passConfig,
      judgeModel: CLAUDE_JUDGMENT_MODEL, judgePromptSha: sha, nInsights: src.jobs.length, startedAt, endedAt: null,
      wallMs: 0, costUsd: prev?.header.costUsd ?? 0, tokens: prev?.header.tokens ?? zeroTokens(), calls: prev?.header.calls ?? 0, complete: false, quoteFitShare: null,
    }
    const failed = new Map<string, JudgedRow>()
    const save = () => {
      const rows = [...done.values(), ...failed.values()].sort((a, b) => a.chunk - b.chunk || a.id.localeCompare(b.id, 'en', { numeric: true }))
      header.wallMs = wallBefore + (Date.now() - t0)
      header.quoteFitShare = quoteFitShare(rows)
      header.complete = jobsAll.length === src.jobs.length && src.jobs.every(j => done.has(j.id))
      header.endedAt = header.complete ? new Date().toISOString() : null
      if (!dry) writeJson(file, { header, rows } satisfies FidelityFile)
    }
    console.log(`[fidelity ${ref}] ${src.jobs.length} insights, ${done.size} already judged, ${todo.length} to judge${limit ? ` (--limit ${limit})` : ''}, judge ${CLAUDE_JUDGMENT_MODEL} (prompt ${sha}), conc ${conc}${dry ? ', DRY (nothing written)' : ''}`)

    const limiter = createLimiter(conc)
    let stop = false
    let finishedChunks = 0
    let consecutiveErrors = 0
    await Promise.all([...byChunk.values()].map(jobs => limiter.run(async () => {
      if (stop) return
      if (!usageOk()) { stop = true; console.error('usage guard: stopping; rerun the same command to resume'); return }
      for (const j of jobs) {
        if (stop) return
        const t1 = Date.now()
        try {
          const { result: v, costUsd, calls, tokens } = await trackCliCost(() => judgeFidelity(j.statement, j.chunkText, { contextNote: j.contextNote, directQuote: j.directQuote }))
          header.costUsd += costUsd; header.calls += calls; header.tokens = addTokens(header.tokens, tokens)
          const row: JudgedRow = {
            id: j.id, chunk: j.chunk, verdict: v.verdict, offending: v.offending, reasoning: v.reasoning, ms: Date.now() - t1, costUsd,
            quoteInChunk: quoteFitsChunk(j.chunkText, j.directQuote),
          }
          if (isRealFidelity(row)) { done.set(j.id, row); failed.delete(j.id); consecutiveErrors = 0 } else {
            failed.set(j.id, row)
            if (++consecutiveErrors >= 8) { stop = true; console.error('eight judge calls errored in a row: stopping (circuit breaker); rerun to resume') }
          }
          if (dry) console.log(`  ${j.id}  ${v.verdict}  «${v.offending.slice(0, 50)}»  ${v.reasoning.slice(0, 80)}`)
        } catch (err) {
          if (err instanceof UsageLimitError || err instanceof PipelineHaltError) { stop = true; console.error(`stopping: ${err.message}; rerun the same command to resume`); return }
          throw err
        }
      }
      finishedChunks++
      if (finishedChunks % 10 === 0 || finishedChunks === byChunk.size) {
        const flagged = [...done.values()].filter(r => ['ADDED_DETAIL', 'DROPPED_QUALIFIER', 'UNRESOLVED_REFERENCE'].includes(r.verdict)).length
        console.log(`  ${finishedChunks}/${byChunk.size} chunks, ${done.size} judged, ${flagged} flagged, ${Math.round((Date.now() - t0) / 1000)} s`)
      }
      save()
    })))
    save()
    const rows = [...done.values(), ...failed.values()]
    const t = tallyFidelity(rows, src.jobs.length)
    console.log(`[fidelity ${ref}] ${header.complete ? 'COMPLETE' : 'INCOMPLETE (rerun to resume)'}: ${t.judged}/${t.insights} judged, ${t.flagged} flagged = ${pct(t.rate)} (AD ${t.addedDetail} / DQ ${t.droppedQualifier} / UR ${t.unresolvedReference}, unsure ${t.unsure}, errors ${t.errors}), quote fits chunk ${pct(header.quoteFitShare)}, ${Math.round(header.wallMs / 1000)} s, $${header.costUsd.toFixed(2)} list-price`)
    if (stop) process.exit(2)
    if (!header.complete && !limit) process.exit(3)
  }
}

async function main(): Promise<void> {
  switch (argv[0]) {
    case 'fetch': return fetchInputs(argv.slice(1).filter(a => !a.startsWith('--')).length ? argv.slice(1).filter(a => !a.startsWith('--')) : Object.keys(TWINS))
    case 'chunk': return chunkCommand()
    case 'extract': return extractCommand()
    case 'match': return matchCommand()
    case 'fidelity': return fidelityCommand()
    case 'report': return reportCommand()
    case 'baseline': return baselineCommand()
    default:
      console.error('usage: evalReproducibility.ts fetch|chunk|extract|match|fidelity|report|baseline …')
      process.exit(1)
  }
}

if (process.argv[1] && /evalReproducibility\.ts$/.test(process.argv[1])) {
  main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
}
