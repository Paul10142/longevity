/**
 * Audio → speaker-labelled, timestamped transcript via Deepgram (pre-recorded).
 *
 *   npx tsx --env-file=.env.local scripts/transcribeDeepgram.ts <file.mp3> [--out DIR]
 *   npx tsx --env-file=.env.local scripts/transcribeDeepgram.ts <dir-of-mp3s>
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
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.deepgram.com/v1/listen'

/** $0.26/h nova-3 + $0.08/h keyterm prompting, pre-recorded pay-as-you-go. */
const RATE_PER_HOUR = 0.34

/**
 * Spend ledger. The API key issued for this project lacks `usage:read`, so the
 * real balance CANNOT be queried — this is a self-tracked ESTIMATE from audio
 * duration times the published rate, and it is only as right as that rate.
 * Verify against the Deepgram dashboard before trusting it near the limit.
 *
 * It is a FILE, not an in-memory counter, because the counter resets to zero
 * every time the script restarts — and a budget that forgets what it already
 * spent is not a budget. Appended after every success, so a crash loses at most
 * the last episode's record.
 *
 * ONE ledger for the whole account, NOT one per output folder. Spend is billed
 * per account, so a per-folder ledger hands every new folder a fresh $200 —
 * which is not a cap, it is a cap-shaped decoration. Lives next to the repo by
 * default; override with DEEPGRAM_LEDGER when transcribing for a different
 * account.
 */
type LedgerEntry = { key: string; model: string; hours: number; est_usd: number; at: string }

async function readLedger(file: string): Promise<LedgerEntry[]> {
  if (!existsSync(file)) return []
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LedgerEntry[]
  } catch {
    // A corrupt ledger must NOT read as $0 spent — that would silently uncap the
    // budget. Fail loudly instead.
    throw new Error(`spend ledger at ${file} is unreadable; refusing to run with an unknown balance`)
  }
}

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

async function main() {
  const target = args.find(
    a => !a.startsWith('--') && !['--out', '--keyterm', '--model'].includes(args[args.indexOf(a) - 1])
  )
  if (!target) throw new Error('usage: transcribeDeepgram.ts <file.mp3 | dir> [--out DIR] [--keyterm "Name"]…')

  // nova-3-medical is a domain-specialised variant; worth comparing against
  // nova-3 (general) on this corpus rather than assuming the medical one wins.
  const model = flag('--model') ?? 'nova-3'
  const suffix = model === 'nova-3' ? '' : `.${model}`
  const keyterms = [...BASE_KEYTERMS, ...multi('--keyterm')]
  const budget = Number(flag('--budget')) || 200
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
  // `new URL('..', import.meta.url)` already resolves to the repo root from
  // scripts/ — wrapping it in dirname() strips one level too many and put the
  // ledger in the home directory, where it read as $0 spent.
  const ledgerPath =
    process.env.DEEPGRAM_LEDGER ??
    path.join(fileURLToPath(new URL('..', import.meta.url)), '.deepgram-spend.json')
  const ledger = await readLedger(ledgerPath)
  const spent = ledger.reduce((s2, e) => s2 + e.est_usd, 0)

  process.stdout.write(
    `${files.length} file(s), model ${model}, ${keyterms.length} keyterms\n` +
      `budget $${budget.toFixed(2)} | already spent ~$${spent.toFixed(2)} | ` +
      `remaining ~$${Math.max(0, budget - spent).toFixed(2)}\n` +
      `(estimated from duration x $${RATE_PER_HOUR}/h — this key cannot read real usage, ` +
      `so check the Deepgram dashboard near the limit)\n`
  )
  if (spent >= budget) {
    process.stdout.write('budget already reached — nothing to do. Raise it with --budget once funded.\n')
    return
  }

  let running = spent
  let done = 0
  let stoppedForBudget = false
  for (const f of files) {
    const base = path.basename(f).replace(/\.[^.]+$/, '')
    if (existsSync(path.join(outDir, `${base}${suffix}.deepgram.json`))) continue // already transcribed

    // Estimate BEFORE spending. A file whose cost would cross the limit stops
    // the run rather than being skipped, so the ledger stays contiguous and
    // resuming picks up exactly where this left off.
    const bytes = (await stat(f)).size
    const estHours = (bytes * 8) / 128_000 / 3600
    if (running + estHours * RATE_PER_HOUR > budget) {
      process.stdout.write(
        `\nstopping before ${base}: it would cost ~$${(estHours * RATE_PER_HOUR).toFixed(2)} ` +
          `and take the total past $${budget.toFixed(2)}\n`
      )
      stoppedForBudget = true
      break
    }

    try {
      const hours = await transcribeOne(f, outDir, keyterms, model, suffix)
      const est = hours * RATE_PER_HOUR
      running += est
      done++
      ledger.push({ key: base, model, hours, est_usd: est, at: new Date().toISOString() })
      await writeFile(ledgerPath, JSON.stringify(ledger, null, 2))
    } catch (err) {
      process.stdout.write(`  ${base} FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  process.stdout.write(
    `\ntranscribed ${done} | estimated total spend ~$${running.toFixed(2)} of $${budget.toFixed(2)}\n`
  )
  if (stoppedForBudget) process.stdout.write('stopped on budget, not on error — re-run with a higher --budget to continue\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
