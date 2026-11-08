/**
 * Extraction prompt / model comparison harness (2026-11-08).
 *
 *   npx tsx --env-file=.env.local scripts/evalExtractionPrompt.ts <command>
 *
 * Re-extracts the EXISTING chunks of a fixed set of episodes with the v2 prompt and
 * gate on different models, judges every insight with the same fidelity judge the
 * pipeline uses (lib/extractionFidelity.ts), and reports flag rate, kinds of flags,
 * cost and time, and how many insights each variant produced versus the stored
 * (Haiku, v1) extraction.
 *
 * It NEVER writes to the database: the only DB access is `fetch`, which reads. All
 * results are JSON files under scratchpad/extraction-compare/.
 *
 * Commands
 *   fetch                       Read the episodes' chunks, stored insights and participant line from
 *                               the DB; add the 40-pair gold set as a pseudo-episode "gold".
 *   extract <variant> [--source <id8>] [--conc N]
 *                               Re-extract with the variant (haiku | sonnet | opus). Resumable per chunk.
 *   judge <variant|baseline> [--source <id8>] [--conc N]
 *                               Judge every candidate insight (before the gate, plus repaired ones).
 *   report                      Print the comparison and write REPORT.md + summary.json.
 *   gate-gold                   No model calls: run the gate over Paul's 40 labelled insights.
 *
 * Needs LLM_BACKEND=claude-code (the default here). Runs `~/.claude/usage-guard/check.sh`
 * before each episode and stops when it exits non-zero. Never run alongside a pipeline run.
 */

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { CLAUDE_BULK_MODEL, CLAUDE_JUDGMENT_MODEL, trackCliCost } from '../lib/llm'
import { extractFromChunkDetailed, inferGuestsFromIntro, type ChunkExtraction } from '../lib/extraction'
import { judgeFidelity, isRealFidelity, isViolation, type FidelityVerdict } from '../lib/extractionFidelity'
import { gateInsight, type GateViolation } from '../lib/extractionGate'
import { createLimiter } from '../lib/concurrency'

const OUT = 'scratchpad/extraction-compare'
const INPUTS = join(OUT, 'inputs.json')

export const SOURCE_IDS = [
  '39a19dc0-72ed-4ce2-acd8-50918cac623b',
  '2ab77a1d-76c1-4692-909e-c1d01d52080a',
  '20794506-e0a9-4213-8a9a-62050d610578',
  '70aba6f8-109b-43a2-9826-b43e523df3b4',
  'eeb6eb61-20b4-4985-a4d7-bd4de5127f27',
  'c93a2604-f281-40cf-b716-227151d6c624',
  '81384ac1-8731-4eab-b112-7ac6e673753c',
  'd80092b8-e884-44af-9f9e-9ff18b0add0f',
]

const VARIANTS: Record<string, string> = {
  haiku: CLAUDE_BULK_MODEL, // the pipeline's current model
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

// ── Files ───────────────────────────────────────────────────

type StoredInsight = {
  statement: string
  context_note: string | null
  direct_quote: string | null
  speaker: string | null
  qualifiers: Record<string, unknown> | null
  locator: string
  label?: FidelityVerdict // gold only: Paul's label
}
type Episode = {
  id: string
  title: string
  participants?: string
  chunks: { idx: number; content: string }[]
  baseline: StoredInsight[]
  baselineModel: string
  isGold?: boolean
}
type Inputs = { episodes: Episode[] }

const short = (id: string) => id.slice(0, 8)
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 1))
const inputs = (): Inputs => {
  if (!existsSync(INPUTS)) throw new Error('run `fetch` first')
  return readJson<Inputs>(INPUTS)
}
const dirFor = (variant: string) => { const d = join(OUT, variant); mkdirSync(d, { recursive: true }); return d }
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usageOk(): boolean {
  try { execSync('sh ~/.claude/usage-guard/check.sh', { stdio: 'pipe' }); return true } catch (e) {
    console.error(String((e as { stdout?: Buffer }).stdout ?? e).trim())
    return false
  }
}

// ── fetch ───────────────────────────────────────────────────

async function fetchInputs(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  const { showForSource, isHostName } = await import('../lib/shows')
  if (!db) throw new Error('Supabase admin client not configured')
  const episodes: Episode[] = []
  for (const id of SOURCE_IDS) {
    const { data: s, error } = await db.from('sources')
      .select('id, title, transcript, authors, series, external_id').eq('id', id).single()
    if (error || !s) throw new Error(`source ${id}: ${error?.message}`)
    const { data: chunkRows } = await db.from('chunks').select('locator, content').eq('source_id', id).order('locator', { ascending: true })
    const chunks = (chunkRows ?? []).map((c: { locator: string; content: string }) => ({ idx: parseInt(String(c.locator).replace('seg-', ''), 10) - 1, content: c.content as string }))
    const { data: ri } = await db.from('raw_insights')
      .select('statement, context_note, direct_quote, speaker, qualifiers, locator, extraction_model').eq('source_id', id).order('locator', { ascending: true })
    // The same participant line extractSource builds, so the models see what production shows them.
    const show = showForSource(s as never)
    const metaGuests = ((s.authors as string[] | null) ?? []).filter(a => a && !isHostName(show, a))
    const guests = metaGuests.length ? metaGuests : await inferGuestsFromIntro(s.transcript as string, show)
    const participants =
      `Host: ${show.hostLabel} (the interviewer).` +
      (guests.length
        ? ` Guest(s): ${guests.join(', ')}.`
        : ` Guest names are unavailable — attribute a statement ONLY when the dialogue itself makes the speaker unambiguous; otherwise return null. Do not assume the host is speaking.`)
    episodes.push({
      id, title: s.title as string, participants, chunks,
      baseline: (ri ?? []).map((r: Record<string, unknown>) => ({
        statement: r.statement as string, context_note: r.context_note as string | null, direct_quote: r.direct_quote as string | null,
        speaker: r.speaker as string | null, qualifiers: r.qualifiers as Record<string, unknown> | null, locator: r.locator as string,
      })),
      baselineModel: (ri?.[0]?.extraction_model as string) ?? 'unknown',
    })
    console.log(`${short(id)}  ${chunks.length} chunks  ${ri?.length ?? 0} stored insights  ${s.title}`)
  }
  episodes.push(goldEpisode())
  writeJson(INPUTS, { episodes } satisfies Inputs)
  console.log(`wrote ${INPUTS}`)
}

/** The 40 human-labelled pairs as a pseudo-episode: unique chunks, the labelled insights as the baseline. */
function goldEpisode(): Episode {
  type Pair = { id: string; statement: string; context_note: string | null; qualifiers: Record<string, unknown> | null; direct_quote: string | null; chunk_text: string }
  const pairs = readJson<Pair[]>('eval/extraction-eval-pairs.json')
  const labels = new Map(readJson<{ id: string; label: FidelityVerdict }[]>('eval/extraction-goldset.json').map(l => [l.id, l.label]))
  const chunkIdx = new Map<string, number>()
  for (const p of pairs) if (!chunkIdx.has(p.chunk_text)) chunkIdx.set(p.chunk_text, chunkIdx.size)
  return {
    id: 'gold', title: 'Gold set (40 insights Paul labelled)', isGold: true, baselineModel: 'claude-haiku-4-5',
    chunks: [...chunkIdx.entries()].map(([content, idx]) => ({ idx, content })),
    baseline: pairs.map(p => ({
      statement: p.statement, context_note: p.context_note, direct_quote: p.direct_quote, speaker: null,
      qualifiers: p.qualifiers, locator: `seg-${String(chunkIdx.get(p.chunk_text)! + 1).padStart(3, '0')}`, label: labels.get(p.id),
    })),
  }
}

// ── extract ─────────────────────────────────────────────────

type Item = {
  key: string
  origin: 'first' | 'repair'
  insight: ChunkExtraction['firstPass'][number]
  gate: 'pass' | 'reject'
  violations: GateViolation[]
}
type ChunkRecord = {
  idx: number; ms: number; costUsd: number; calls: number
  items: Item[]
  error?: string
}
type ExtractFile = { sourceId: string; title: string; variant: string; model: string; wallMs: number; chunks: ChunkRecord[] }

function itemsOf(idx: number, r: ChunkExtraction): Item[] {
  const items: Item[] = []
  r.firstPass.forEach((insight, i) => {
    const rej = r.rejected.find(x => x.insight === insight)
    items.push({ key: `${idx}:f:${i}`, origin: 'first', insight, gate: rej ? 'reject' : 'pass', violations: rej?.violations ?? [] })
  })
  r.repairedCandidates.forEach((insight, i) => {
    const rej = r.stillRejected.find(x => x.insight === insight)
    items.push({ key: `${idx}:r:${i}`, origin: 'repair', insight, gate: rej ? 'reject' : 'pass', violations: rej?.violations ?? [] })
  })
  return items
}

async function extractVariant(variant: string): Promise<void> {
  const model = VARIANTS[variant]
  if (!model) throw new Error(`unknown variant ${variant}`)
  const only = arg('source')
  const conc = Number(arg('conc')) || 8
  const limiter = createLimiter(conc)
  for (const ep of inputs().episodes.filter(e => !only || short(e.id) === only || e.id === only)) {
    if (!usageOk()) { console.error('usage guard: stopping'); process.exit(2) }
    const file = join(dirFor(variant), `${ep.isGold ? 'gold' : short(ep.id)}.extract.json`)
    const prev: ExtractFile | null = existsSync(file) ? readJson<ExtractFile>(file) : null
    const done = new Map<number, ChunkRecord>((prev?.chunks ?? []).filter(c => !c.error).map(c => [c.idx, c]))
    const todo = ep.chunks.filter(c => !done.has(c.idx))
    console.log(`[${variant}] ${short(ep.id)} ${ep.title.slice(0, 50)}: ${todo.length}/${ep.chunks.length} chunks to do`)
    const started = Date.now()
    let wallBefore = prev?.wallMs ?? 0
    const save = () => writeJson(file, {
      sourceId: ep.id, title: ep.title, variant, model, wallMs: wallBefore + (Date.now() - started),
      chunks: [...done.values()].sort((a, b) => a.idx - b.idx),
    } satisfies ExtractFile)
    await Promise.all(todo.map(c => limiter.run(async () => {
      const t0 = Date.now()
      try {
        const { result, costUsd, calls } = await trackCliCost(() =>
          extractFromChunkDetailed(c.content, `${short(ep.id)} ${c.idx + 1}/${ep.chunks.length}`, ep.participants,
            { model, promptVersion: 'v2', gate: true, repair: true }))
        done.set(c.idx, { idx: c.idx, ms: Date.now() - t0, costUsd, calls, items: itemsOf(c.idx, result) })
      } catch (err) {
        done.set(c.idx, { idx: c.idx, ms: Date.now() - t0, costUsd: 0, calls: 0, items: [], error: String(err instanceof Error ? err.message : err).slice(0, 300) })
        console.error(`  chunk ${c.idx + 1} failed: ${String(err).slice(0, 160)}`)
      }
      save()
    })))
    save()
    const failed = [...done.values()].filter(c => c.error).length
    console.log(`  done in ${Math.round((Date.now() - started) / 1000)}s${failed ? `, ${failed} chunk(s) FAILED (rerun to retry)` : ''}`)
  }
}

// ── judge ───────────────────────────────────────────────────

type Judged = { key: string; verdict: FidelityVerdict; offending: string; reasoning: string; ms: number; costUsd: number }
type JudgeFile = { sourceId: string; variant: string; judgeModel: string; judged: Judged[] }

async function judgeVariant(variant: string): Promise<void> {
  const only = arg('source')
  const conc = Number(arg('conc')) || 12
  const limiter = createLimiter(conc)
  for (const ep of inputs().episodes.filter(e => !only || short(e.id) === only || e.id === only)) {
    if (variant === 'baseline' && ep.isGold) continue // the gold baseline is Paul's own labels
    if (!usageOk()) { console.error('usage guard: stopping'); process.exit(2) }
    const name = ep.isGold ? 'gold' : short(ep.id)
    const file = join(dirFor(variant), `${name}.judge.json`)
    const prev: JudgeFile | null = existsSync(file) ? readJson<JudgeFile>(file) : null
    const done = new Map<string, Judged>((prev?.judged ?? []).filter(j => !j.reasoning.startsWith('error:')).map(j => [j.key, j]))

    type Job = { key: string; chunk: string; statement: string; context_note: string | null; direct_quote: string | null }
    const chunkText = new Map(ep.chunks.map(c => [c.idx, c.content]))
    let jobs: Job[]
    if (variant === 'baseline') {
      jobs = ep.baseline.map((b, i) => {
        const idx = parseInt(b.locator.replace('seg-', ''), 10) - 1
        return { key: `${idx}:b:${i}`, chunk: chunkText.get(idx) ?? '', statement: b.statement, context_note: b.context_note, direct_quote: b.direct_quote }
      })
    } else {
      const ex = join(dirFor(variant), `${name}.extract.json`)
      if (!existsSync(ex)) { console.log(`[${variant}] ${name}: no extract file, skipping`); continue }
      const ef = readJson<ExtractFile>(ex)
      jobs = ef.chunks.flatMap(c => c.items.map(it => ({
        key: it.key, chunk: chunkText.get(c.idx) ?? '', statement: it.insight.statement,
        context_note: it.insight.context_note ?? null, direct_quote: it.insight.direct_quote ?? null,
      })))
    }
    const todo = jobs.filter(j => j.chunk && !done.has(j.key))
    console.log(`[judge ${variant}] ${name}: ${todo.length}/${jobs.length} to judge`)
    const started = Date.now()
    const save = () => writeJson(file, { sourceId: ep.id, variant, judgeModel: CLAUDE_JUDGMENT_MODEL, judged: [...done.values()] } satisfies JudgeFile)
    let n = 0
    await Promise.all(todo.map(j => limiter.run(async () => {
      const t0 = Date.now()
      const { result: r, costUsd } = await trackCliCost(() =>
        judgeFidelity(j.statement, j.chunk, { contextNote: j.context_note, directQuote: j.direct_quote }))
      done.set(j.key, { key: j.key, verdict: r.verdict, offending: r.offending, reasoning: r.reasoning, ms: Date.now() - t0, costUsd })
      if (++n % 25 === 0) { save(); console.log(`  …${n}/${todo.length}`) }
    })))
    save()
    console.log(`  done in ${Math.round((Date.now() - started) / 1000)}s`)
  }
}

// ── report ──────────────────────────────────────────────────

type Tally = { n: number; real: number; flagged: number; kinds: Record<string, number> }
const newTally = (): Tally => ({ n: 0, real: 0, flagged: 0, kinds: {} })
function add(t: Tally, v: Judged | undefined) {
  t.n++
  if (!v || !isRealFidelity(v)) return
  t.real++
  if (isViolation(v.verdict)) { t.flagged++; t.kinds[v.verdict] = (t.kinds[v.verdict] ?? 0) + 1 }
}
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a')
const kinds = (t: Tally) => `AD ${t.kinds.ADDED_DETAIL ?? 0} / DQ ${t.kinds.DROPPED_QUALIFIER ?? 0} / UR ${t.kinds.UNRESOLVED_REFERENCE ?? 0}`

type VariantStats = {
  variant: string; model: string; episodes: number; chunks: number; failedChunks: number
  baselineInsights: number
  firstPass: Tally; final: Tally
  gateRejected: number; gateRejectedFlagged: number; gateRejectedFaithful: number
  gatePassedFlagged: number
  repairRan: number; repairKept: number
  rejectsByRule: Record<string, number>
  insightsKept: number; insightsFaithfulKept: number
  extractSerialS: number; extractWallS: number; extractCost: number; judgeCost: number
}

function statsFor(ep: Episode, variant: string): VariantStats | null {
  const name = ep.isGold ? 'gold' : short(ep.id)
  const exf = join(OUT, variant, `${name}.extract.json`)
  const jf = join(OUT, variant, `${name}.judge.json`)
  if (!existsSync(exf) || !existsSync(jf)) return null
  const ef = readJson<ExtractFile>(exf)
  const jv = new Map(readJson<JudgeFile>(jf).judged.map(j => [j.key, j]))
  const st: VariantStats = {
    variant, model: ef.model, episodes: 1, chunks: ef.chunks.length, failedChunks: ef.chunks.filter(c => c.error).length,
    baselineInsights: ep.baseline.length, firstPass: newTally(), final: newTally(),
    gateRejected: 0, gateRejectedFlagged: 0, gateRejectedFaithful: 0, gatePassedFlagged: 0,
    repairRan: 0, repairKept: 0, rejectsByRule: {}, insightsKept: 0, insightsFaithfulKept: 0,
    extractSerialS: ef.chunks.reduce((s, c) => s + c.ms, 0) / 1000, extractWallS: ef.wallMs / 1000,
    extractCost: ef.chunks.reduce((s, c) => s + c.costUsd, 0),
    judgeCost: [...jv.values()].reduce((s, j) => s + j.costUsd, 0),
  }
  for (const c of ef.chunks) {
    if (c.calls > 1) st.repairRan++
    for (const it of c.items) {
      const v = jv.get(it.key)
      const flagged = !!v && isRealFidelity(v) && isViolation(v.verdict)
      const faithful = !!v && isRealFidelity(v) && v.verdict === 'FAITHFUL'
      if (it.origin === 'first') {
        add(st.firstPass, v)
        if (it.gate === 'reject') {
          st.gateRejected++
          if (flagged) st.gateRejectedFlagged++
          if (faithful) st.gateRejectedFaithful++
          for (const vi of it.violations) st.rejectsByRule[vi.rule] = (st.rejectsByRule[vi.rule] ?? 0) + 1
        } else if (flagged) st.gatePassedFlagged++
      }
      if (it.gate === 'pass') {
        add(st.final, v)
        st.insightsKept++
        if (faithful) st.insightsFaithfulKept++
        if (it.origin === 'repair') st.repairKept++
      }
    }
  }
  return st
}

function merge(list: VariantStats[]): VariantStats {
  const m: VariantStats = { ...list[0], episodes: 0, chunks: 0, failedChunks: 0, baselineInsights: 0, firstPass: newTally(), final: newTally(),
    gateRejected: 0, gateRejectedFlagged: 0, gateRejectedFaithful: 0, gatePassedFlagged: 0, repairRan: 0, repairKept: 0, rejectsByRule: {},
    insightsKept: 0, insightsFaithfulKept: 0, extractSerialS: 0, extractWallS: 0, extractCost: 0, judgeCost: 0 }
  for (const s of list) {
    m.episodes += s.episodes; m.chunks += s.chunks; m.failedChunks += s.failedChunks; m.baselineInsights += s.baselineInsights
    for (const k of ['firstPass', 'final'] as const) {
      m[k].n += s[k].n; m[k].real += s[k].real; m[k].flagged += s[k].flagged
      for (const [kk, v] of Object.entries(s[k].kinds)) m[k].kinds[kk] = (m[k].kinds[kk] ?? 0) + v
    }
    for (const f of ['gateRejected', 'gateRejectedFlagged', 'gateRejectedFaithful', 'gatePassedFlagged', 'repairRan', 'repairKept', 'insightsKept', 'insightsFaithfulKept', 'extractSerialS', 'extractWallS', 'extractCost', 'judgeCost'] as const) m[f] += s[f]
    for (const [r, v] of Object.entries(s.rejectsByRule)) m.rejectsByRule[r] = (m.rejectsByRule[r] ?? 0) + v
  }
  return m
}

function baselineStats(ep: Episode): { n: number; t: Tally; faithful: number; cost: number } | null {
  if (ep.isGold) {
    const t = newTally(); let faithful = 0
    for (const b of ep.baseline) {
      t.n++; t.real++
      if (b.label === 'FAITHFUL') faithful++
      else if (b.label && isViolation(b.label)) { t.flagged++; t.kinds[b.label] = (t.kinds[b.label] ?? 0) + 1 }
    }
    return { n: ep.baseline.length, t, faithful, cost: 0 }
  }
  const jf = join(OUT, 'baseline', `${short(ep.id)}.judge.json`)
  if (!existsSync(jf)) return null
  const jv = readJson<JudgeFile>(jf).judged
  const t = newTally(); let faithful = 0
  for (const j of jv) { add(t, j); if (isRealFidelity(j) && j.verdict === 'FAITHFUL') faithful++ }
  return { n: ep.baseline.length, t, faithful, cost: jv.reduce((s, j) => s + j.costUsd, 0) }
}

function report(): void {
  const inp = inputs()
  const names = Object.keys(VARIANTS)
  const lines: string[] = []
  const out = (s = '') => { lines.push(s); console.log(s) }
  const summary: Record<string, unknown> = {}

  const section = (title: string, eps: Episode[]) => {
    out(`## ${title}`)
    out()
    const base = eps.map(baselineStats).filter(Boolean) as NonNullable<ReturnType<typeof baselineStats>>[]
    const bn = base.reduce((s, b) => s + b.n, 0)
    const bt = newTally(); let bf = 0
    for (const b of base) { bt.n += b.t.n; bt.real += b.t.real; bt.flagged += b.t.flagged; for (const [k, v] of Object.entries(b.t.kinds)) bt.kinds[k] = (bt.kinds[k] ?? 0) + v; bf += b.faithful }
    out('| Variant | Insights kept | vs stored | Faithful kept | Flag rate (kept) | Kinds (kept) | Flag rate before gate | Time / episode (serial) | Cost / episode (extract + judge) |')
    out('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    if (base.length) out(`| **Stored (haiku-4-5, old prompt)** | ${bn} | 100% | ${bf} | ${pct(bt.flagged, bt.real)} | ${kinds(bt)} | n/a | n/a | n/a |`)
    const rows: Record<string, VariantStats> = {}
    for (const v of names) {
      const per = eps.map(e => statsFor(e, v)).filter(Boolean) as VariantStats[]
      if (!per.length) continue
      const m = merge(per); rows[v] = m
      const e = m.episodes || 1
      out(`| ${v} (${m.model}, new prompt + gate) | ${m.insightsKept} | ${pct(m.insightsKept, m.baselineInsights)} | ${m.insightsFaithfulKept} | ${pct(m.final.flagged, m.final.real)} | ${kinds(m.final)} | ${pct(m.firstPass.flagged, m.firstPass.real)} | ${(m.extractSerialS / e / 60).toFixed(1)} min | $${((m.extractCost + m.judgeCost) / e).toFixed(2)} ($${(m.extractCost / e).toFixed(2)} + $${(m.judgeCost / e).toFixed(2)}) |`)
    }
    out()
    out('Gate behaviour (first pass):')
    out()
    out('| Variant | Insights from model | Gate rejected | Of rejected: judged flawed | Of rejected: judged faithful | Passed but judged flawed | Repair rounds | Insights rescued by repair | Rejections by rule |')
    out('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const [v, m] of Object.entries(rows)) {
      out(`| ${v} | ${m.firstPass.n} | ${m.gateRejected} (${pct(m.gateRejected, m.firstPass.n)}) | ${m.gateRejectedFlagged} | ${m.gateRejectedFaithful} | ${m.gatePassedFlagged} | ${m.repairRan} | ${m.repairKept} | ${Object.entries(m.rejectsByRule).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'} |`)
    }
    out()
    summary[title] = { stored: { n: bn, faithful: bf, flagged: bt.flagged, real: bt.real, kinds: bt.kinds }, variants: rows }
    const failed = Object.entries(rows).filter(([, m]) => m.failedChunks > 0)
    if (failed.length) out(`⚠ chunks that failed extraction (not retried): ${failed.map(([v, m]) => `${v} ${m.failedChunks}`).join(', ')}\n`)
  }

  const real = inp.episodes.filter(e => !e.isGold)
  out('# Extraction comparison (same 8 episodes, same chunks, same judge)')
  out()
  out(`Judge: ${CLAUDE_JUDGMENT_MODEL}. Flag rate = ADDED_DETAIL + DROPPED_QUALIFIER + UNRESOLVED_REFERENCE over judged insights. Cost = the CLI's own list-price figure per call (includes its fixed overhead; the subscription is not billed per call).`)
  out()
  section('All 8 episodes', real)
  out('### Per episode')
  out()
  out('| Episode | Chunks | Stored insights | Stored flag rate | ' + names.map(v => `${v} kept / flag rate / min`).join(' | ') + ' |')
  out('| --- | --- | --- | --- | ' + names.map(() => '---').join(' | ') + ' |')
  for (const e of real) {
    const b = baselineStats(e)
    const cells = names.map(v => { const s = statsFor(e, v); return s ? `${s.insightsKept} / ${pct(s.final.flagged, s.final.real)} / ${(s.extractSerialS / 60).toFixed(1)}` : 'n/a' })
    out(`| ${e.title.slice(0, 48)} | ${e.chunks.length} | ${e.baseline.length} | ${b ? pct(b.t.flagged, b.t.real) : 'n/a'} | ${cells.join(' | ')} |`)
  }
  out()
  const gold = inp.episodes.filter(e => e.isGold)
  if (gold.length) section("Gold set (40 insights Paul labelled; stored row = Paul's labels, 5 of 40 ADDED_DETAIL)", gold)
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n')
  writeJson(join(OUT, 'summary.json'), summary)
}

// ── gate-gold ───────────────────────────────────────────────

function gateGold(): void {
  const g = goldEpisode()
  const chunkOf = (b: StoredInsight) => g.chunks[parseInt(b.locator.replace('seg-', ''), 10) - 1].content
  let tp = 0, fn = 0, fp = 0, tn = 0
  for (const b of g.baseline) {
    const r = gateInsight(chunkOf(b), { statement: b.statement, context_note: b.context_note, direct_quote: b.direct_quote, qualifiers: b.qualifiers })
    const bad = b.label !== 'FAITHFUL'
    if (bad && !r.ok) tp++; else if (bad) fn++; else if (!r.ok) fp++; else tn++
    if (!r.ok) console.log(`${bad ? 'CAUGHT ' : 'FALSE+ '} ${r.violations.map(v => `${v.rule}:${v.detail.slice(0, 40)}`).join(' | ')}  «${b.statement.slice(0, 90)}»`)
    else if (bad) console.log(`MISSED  «${b.statement.slice(0, 110)}»`)
  }
  console.log(`\nGate on Paul's 40 labels: caught ${tp} of ${tp + fn} flawed; wrongly rejected ${fp} of ${fp + tn} faithful.`)
}

// ── main ────────────────────────────────────────────────────

async function main() {
  const [cmd, a] = process.argv.slice(2)
  switch (cmd) {
    case 'fetch': return fetchInputs()
    case 'extract': return extractVariant(a)
    case 'judge': return judgeVariant(a)
    case 'report': return report()
    case 'gate-gold': return gateGold()
    default:
      console.log('usage: evalExtractionPrompt.ts <fetch | extract <haiku|sonnet|opus> | judge <haiku|sonnet|opus|baseline> | report | gate-gold>')
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
