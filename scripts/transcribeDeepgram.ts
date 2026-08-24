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
import path from 'node:path'

const API = 'https://api.deepgram.com/v1/listen'

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

async function transcribeOne(file: string, outDir: string, keyterms: string[]): Promise<void> {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set (it belongs in .env.local — it is billable)')

  const base = path.basename(file).replace(/\.[^.]+$/, '')
  const audio = await readFile(file)

  const params = new URLSearchParams({
    model: 'nova-3',
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
  const out = {
    key: base,
    model: 'nova-3',
    duration_seconds: body?.metadata?.duration ?? null,
    speakers,
    segments,
  }

  const dest = path.join(outDir, `${base}.deepgram.json`)
  await writeFile(dest, JSON.stringify(out, null, 2))

  const mins = (out.duration_seconds ?? 0) / 60
  process.stdout.write(
    `  ${base}: ${segments.length} utterances, ${speakers.length} speakers, ` +
      `${mins.toFixed(1)} min audio, ${((Date.now() - started) / 1000).toFixed(0)}s wall, ` +
      `~$${(((out.duration_seconds ?? 0) / 3600) * 0.34).toFixed(2)}\n  → ${dest}\n`
  )
}

async function main() {
  const target = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out' && args[args.indexOf(a) - 1] !== '--keyterm')
  if (!target) throw new Error('usage: transcribeDeepgram.ts <file.mp3 | dir> [--out DIR] [--keyterm "Name"]…')

  const keyterms = [...BASE_KEYTERMS, ...multi('--keyterm')]
  const info = await stat(target)
  const files = info.isDirectory()
    ? (await readdir(target)).filter(f => /\.(mp3|m4a|wav)$/i.test(f)).map(f => path.join(target, f))
    : [target]
  if (files.length === 0) throw new Error(`no audio files found in ${target}`)

  const outDir = flag('--out') ?? (info.isDirectory() ? target : path.dirname(target))
  process.stdout.write(`transcribing ${files.length} file(s) with ${keyterms.length} keyterms\n`)

  for (const f of files) {
    try {
      await transcribeOne(f, outDir, keyterms)
    } catch (err) {
      process.stdout.write(`  ${path.basename(f)} FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
