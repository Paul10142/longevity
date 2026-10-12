/**
 * Audio → speaker-labelled, timestamped transcript via Deepgram (pre-recorded).
 *
 *   npx tsx --env-file=.env.local scripts/transcribeDeepgram.ts <file.mp3> [--out DIR]
 *   npx tsx --env-file=.env.local scripts/transcribeDeepgram.ts <dir-of-mp3s>
 *   npx tsx --env-file=.env.local scripts/transcribeDeepgram.ts <dir-of-mp3s> --dry-run   # plan only, spends nothing
 *
 * Flags: --budget USD (cap, default 200) · --margin USD (kept unspent, default
 * 0.25; `--margin 0` spends to the cent) · --model nova-3|nova-3-medical ·
 * --keyterm "Name" (repeatable) · --out DIR · --dry-run.
 *
 * Why this and not the local route: MacWhisper's WhisperKit models advertise
 * speaker recognition but produced NO speaker field in any export style or
 * format (verified 2026-08-24 on episode 404), and speaker identity is what the
 * corroboration rule is built on. Deepgram returns diarization as data.
 *
 * Output is OUR shape, not Deepgram's, written next to the audio as
 * `<key>.deepgram.json`:
 *   { key, model, duration_seconds, speakers, segments: [
 *       { text, speaker, start_ms, end_ms } ] }
 * Milliseconds, because that is what `raw_insights.start_ms/end_ms` store —
 * converting once here beats every reader re-deriving it. `speaker` is
 * Deepgram's index (0, 1, …), NOT a name: diarization says "two people alternate
 * here", never who they are. Naming happens later from feed metadata (the host
 * is constant, the guest is in the title) — keep those steps separate so a
 * naming mistake never corrupts the measured turn-taking.
 *
 * Utterances, not words: Deepgram returns per-word timings, but an utterance is
 * already a speaker-homogeneous span with clean boundaries, which is exactly the
 * unit the chunker wants. Word timings are dropped deliberately — they would
 * multiply file size ~20x for detail nothing downstream reads.
 *
 * BUDGET. The spend ledger, the real-balance lookup and the reconcile-from-disk
 * step live in lib/deepgramSpend.ts (shared with the downloader's
 * --fit-budget); the fit rule is lib/deepgramBudget.ts. Precedence is
 * unchanged: the REAL balance wins when the key can read it, the ledger is the
 * fallback, and spend at or past --budget stops the run before any request.
 *
 * SKIP, DON'T STOP. A file whose estimated cost would cross the budget is
 * skipped and the walk continues, so the shorter episodes further down still
 * get transcribed with what is left — "as the credit gets low, make the slice
 * smaller so it can use all the existing credit". The run ends by listing what
 * it skipped and the exact --budget that would cover it after a top-up. (The
 * old behaviour stopped at the first unaffordable file and left credit unused.)
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  DEEPGRAM_RATE_PER_HOUR,
  DEFAULT_MARGIN_USD,
  assessItem,
  budgetToCover,
  describeFit,
  fitEpisodesToBudget,
  hoursFromBytes,
  type BudgetItem,
} from '../lib/deepgramBudget'
import { defaultLedgerPath, describeCredit, remainingCredit, writeLedger } from '../lib/deepgramSpend'

const API = 'https://api.deepgram.com/v1/listen'

const RATE_PER_HOUR = DEEPGRAM_RATE_PER_HOUR

/**
 * Keyterm prompting ($0.08/h) biases recognition toward terms we KNOW recur.
 * This exists because the local run rendered the host's own surname as
 * "Atiyah" — the same failure mode that turns a drug name into a plausible
 * non-word, which in a medical corpus is worse than a dropped sentence because
 * it reads as fact. Keep this list to genuinely recurring vocabulary; per-episode
 * guest names are passed with --keyterm instead.
 */
const BASE_KEYTERMS = [
  'Peter Attia', 'Attia', 'apoB', 'ApoE', 'lipoprotein', 'Lp(a)', 'LDL', 'HDL',
  'triglycerides', 'atherosclerosis', 'VO2 max', 'zone 2', 'rapamycin',
  'metformin', 'GLP-1', 'semaglutide', 'tirzepatide', 'sarcopenia',
  'hyperinsulinemia', 'insulin resistance', 'HbA1c', 'creatine',
  'testosterone', 'estradiol', 'progesterone', 'cortisol', 'DHEA',
  'hypertrophy', 'mTOR', 'autophagy', 'nutrigenomics', 'centenarian',
]

const args = process.argv.slice(2)
const flag = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}
const multi = (f: string): string[] => args.flatMap((a, i) => (a === f && args[i + 1] ? [args[i + 1]] : []))
/** Every flag that consumes the argument after it — so its value is never mistaken for the target. */
const VALUE_FLAGS = ['--out', '--keyterm', '--model', '--budget', '--margin']

function parseMargin(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MARGIN_USD
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`--margin takes a dollar amount ≥ 0, got "${raw}"`)
  return n
}

type Segment = { text: string; speaker: number | null; start_ms: number; end_ms: number }

type DeepgramUtterance = {
  transcript?: string
  speaker?: number
  start?: number
  end?: number
}

async function transcribeOne(file: string, outDir: string, keyterms: string[], model: string, suffix: string): Promise<number> {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set (it belongs in .env.local — it is billable)')

  const base = path.basename(file).replace(/\.[^.]+$/, '')
  const audio = await readFile(file)

  const params = new URLSearchParams({
    model,
    diarize: 'true',      // the whole point — who spoke when
    utterances: 'true',   // speaker-homogeneous spans (see header)
    smart_format: 'true', // punctuation + casing, included at no cost
    punctuate: 'true',
  })
  for (const t of keyterms) params.append('keyterm', t)

  const started = Date.now()
  const res = await fetch(`${API}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/mpeg' },
    body: new Uint8Array(audio),
  })
  if (!res.ok) {
    // Deepgram puts the reason in the body; the URL carries no secret, but the
    // Authorization header would appear in a naive error dump, so build the
    // message from the body alone.
    throw new Error(`Deepgram HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const body = await res.json()

  const utterances: DeepgramUtterance[] = body?.results?.utterances ?? []
  if (utterances.length === 0) {
    throw new Error('Deepgram returned no utterances — refusing to write an empty transcript')
  }

  const segments: Segment[] = utterances
    .filter(u => (u.transcript ?? '').trim().length > 0)
    .map(u => ({
      text: (u.transcript ?? '').trim(),
      speaker: typeof u.speaker === 'number' ? u.speaker : null,
      start_ms: Math.round((u.start ?? 0) * 1000),
      end_ms: Math.round((u.end ?? 0) * 1000),
    }))

  const speakers = [...new Set(segments.map(s => s.speaker).filter(s => s !== null))].sort()
  // Record what the SERVER says it ran, not what we asked for. A silently
  // ignored parameter (an unsupported model alias, a keyterm the model does not
  // accept) is otherwise invisible, and months later there would be no way to
  // tell which transcripts were produced with which settings.
  const modelInfo = Object.values(body?.metadata?.model_info ?? {})[0] as
    | { name?: string; version?: string; arch?: string }
    | undefined
  const out = {
    key: base,
    model: modelInfo?.name ?? 'unknown',
    model_version: modelInfo?.version ?? null,
    diarized: body?.metadata?.diarize_info != null,
    keyterms,
    request_id: body?.metadata?.request_id ?? null,
    duration_seconds: body?.metadata?.duration ?? null,
    speakers,
    segments,
  }

  const dest = path.join(outDir, `${base}${suffix}.deepgram.json`)
  await writeFile(dest, JSON.stringify(out, null, 2))

  const mins = (out.duration_seconds ?? 0) / 60
  process.stdout.write(
    `  ${base}: ${segments.length} utterances, ${speakers.length} speakers, ` +
      `${mins.toFixed(1)} min audio, ${((Date.now() - started) / 1000).toFixed(0)}s wall ` +
      `(${(mins * 60 / Math.max(1, (Date.now() - started) / 1000)).toFixed(0)}x realtime), ` +
      `model ${out.model}, diarized=${out.diarized}, ` +
      `~$${(((out.duration_seconds ?? 0) / 3600) * RATE_PER_HOUR).toFixed(2)}\n  → ${dest}\n`
  )
  return (out.duration_seconds ?? 0) / 3600
}

type PendingFile = BudgetItem & { file: string }

/** The files a run skipped for budget, as printed lines (the real run's recap; the dry run's plan already lists them). */
function listSkipped(skipped: PendingFile[]): string[] {
  const skippedUsd = skipped.reduce((s, p) => s + p.hours * RATE_PER_HOUR, 0)
  const skippedHours = skipped.reduce((s, p) => s + p.hours, 0)
  return [
    `skipped for budget: ${skipped.length} file(s), ~${skippedHours.toFixed(1)} h, ~$${skippedUsd.toFixed(2)}:`,
    ...skipped.map(p => `  ${p.key}  ~${p.hours.toFixed(2)} h  ~$${(p.hours * RATE_PER_HOUR).toFixed(2)}`),
  ]
}

/** The exact --budget (and the top-up) that would let the next run take what this one skipped. */
function coverLine(skipped: PendingFile[], runningUsd: number, budget: number, margin: number): string {
  const skippedUsd = skipped.reduce((s, p) => s + p.hours * RATE_PER_HOUR, 0)
  const needed = budgetToCover(runningUsd, skippedUsd, margin)
  const topUp = Math.max(0, skippedUsd + margin - Math.max(0, budget - runningUsd))
  return (
    `to cover them next run: --budget ${needed.toFixed(2)}` +
    (topUp > 0 ? ` (the account needs ~$${topUp.toFixed(2)} more credit than it has now)` : '')
  )
}

async function main() {
  const target = args.find(
    a => !a.startsWith('--') && !VALUE_FLAGS.includes(args[args.indexOf(a) - 1])
  )
  if (!target) {
    throw new Error(
      'usage: transcribeDeepgram.ts <file.mp3 | dir> [--out DIR] [--keyterm "Name"]… [--budget USD] [--margin USD] [--dry-run]'
    )
  }

  // nova-3-medical is a domain-specialised variant; worth comparing against
  // nova-3 (general) on this corpus rather than assuming the medical one wins.
  const model = flag('--model') ?? 'nova-3'
  const suffix = model === 'nova-3' ? '' : `.${model}`
  const keyterms = [...BASE_KEYTERMS, ...multi('--keyterm')]
  const budget = Number(flag('--budget')) || 200
  const margin = parseMargin(flag('--margin'))
  const dryRun = args.includes('--dry-run')
  const info = await stat(target)
  const files = info.isDirectory()
    ? (await readdir(target))
        .filter(f => /\.(mp3|m4a|wav)$/i.test(f))
        // NEWEST FIRST. readdir is alphabetical, which for `attia-0001` …
        // `attia-0405` means OLDEST first — the opposite of what is wanted, and
        // a silent one: a budget-limited run would spend the whole balance on
        // 2018 episodes and never reach this year's.
        .sort((a, b) => b.localeCompare(a))
        .map(f => path.join(target, f))
    : [target]
  if (files.length === 0) throw new Error(`no audio files found in ${target}`)

  const outDir = flag('--out') ?? (info.isDirectory() ? target : path.dirname(target))
  // Checked up front: a transcript that cannot be written after Deepgram has
  // already billed for it is money spent for nothing.
  if (!existsSync(outDir)) throw new Error(`--out ${outDir} does not exist`)

  // Ledger → reconcile against the transcripts on disk → real balance if the
  // key can read it. A dry run counts recovered transcripts but writes nothing.
  const credit = await remainingCredit({
    budgetUsd: budget,
    apiKey: process.env.DEEPGRAM_API_KEY,
    ledgerPath: defaultLedgerPath(),
    reconcileDir: outDir,
    persistReconcile: !dryRun,
  })
  const { ledger, ledgerPath } = credit

  process.stdout.write(`${files.length} file(s), model ${model}, ${keyterms.length} keyterms\n`)
  for (const line of describeCredit(credit)) process.stdout.write(line + '\n')
  if (credit.spentUsd >= budget) {
    process.stdout.write('budget already reached — nothing to do. Raise it with --budget once funded.\n')
    return
  }

  // Everything not yet transcribed, with its size-based estimate. The estimate
  // is made BEFORE spending: a file is only sent once it is known to fit.
  const pending: PendingFile[] = []
  for (const f of files) {
    const base = path.basename(f).replace(/\.[^.]+$/, '')
    if (existsSync(path.join(outDir, `${base}${suffix}.deepgram.json`))) continue // already transcribed
    const bytes = (await stat(f)).size
    pending.push({ key: base, hours: hoursFromBytes(bytes), estimated: true, file: f })
  }
  if (pending.length === 0) {
    process.stdout.write('every file here is already transcribed — nothing to do\n')
    return
  }

  if (dryRun) {
    const fit = fitEpisodesToBudget(pending, credit.remainingUsd, RATE_PER_HOUR, margin)
    process.stdout.write(`\ndry run — plan for ${pending.length} untranscribed file(s), margin $${margin.toFixed(2)}:\n`)
    for (const line of describeFit(fit, { ratePerHour: RATE_PER_HOUR })) process.stdout.write(line + '\n')
    const over = fit.skipped.filter(s => s.reason === 'over-budget')
    if (over.length > 0) process.stdout.write(coverLine(over, credit.spentUsd + fit.chosenUsd, budget, margin) + '\n')
    process.stdout.write('nothing sent, nothing spent\n')
    return
  }

  let running = credit.spentUsd
  let done = 0
  const skipped: PendingFile[] = []
  for (const p of pending) {
    // The hard stop: at or past the cap, nothing more is sent, whatever the
    // estimate says. Kept separate from the fit rule on purpose.
    if (running >= budget) {
      skipped.push(p)
      continue
    }
    // Same rule as the plan, asked again with the REAL spend so far (Deepgram's
    // measured duration replaces the byte estimate after every success).
    const verdict = assessItem(p, budget - running, RATE_PER_HOUR, margin)
    if (!verdict.ok) {
      process.stdout.write(
        `  skipping ${p.key}: ~$${verdict.estUsd.toFixed(2)} (~${p.hours.toFixed(2)} h) would take the total ` +
          `past $${budget.toFixed(2)} (~$${Math.max(0, budget - running).toFixed(2)} left, margin $${margin.toFixed(2)})\n`
      )
      skipped.push(p)
      continue
    }

    try {
      const hours = await transcribeOne(p.file, outDir, keyterms, model, suffix)
      const est = hours * RATE_PER_HOUR
      running += est
      done++
      ledger.push({ key: p.key, model, hours, est_usd: est, at: new Date().toISOString() })
      await writeLedger(ledgerPath, ledger)
    } catch (err) {
      process.stdout.write(`  ${p.key} FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  process.stdout.write(
    `\ntranscribed ${done} | estimated total spend ~$${running.toFixed(2)} of $${budget.toFixed(2)}\n`
  )
  if (skipped.length > 0) {
    for (const line of listSkipped(skipped)) process.stdout.write(line + '\n')
    process.stdout.write(coverLine(skipped, running, budget, margin) + '\n')
    process.stdout.write('skipped on budget, not on error — top up, then re-run with that --budget to pick them up\n')
  }
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
