/**
 * Which voices does each episode have, what does the attach call them today, and who would Claude
 * suggest for the guest? READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/previewGuestVoices.ts --dir <audio-root> --keys fmf-0012,fmf-0020 [--suggest]
 *
 *   --dir <audio-root>   where the Deepgram files are: `<root>/<key>/<key>.deepgram.json`
 *                        (the runner's layout, scratchpad/batch3/audio) or `<root>/<key>.deepgram.json`.
 *   --keys <k1,k2,…>     the episodes (`sources.external_id`), required.
 *   --suggest            also ask Claude (one small call per episode that has exactly one guest and two or
 *                        more voices besides the host) which voice is the guest. Off by default: no model call.
 *
 * For each episode it prints a table: the id, the title, each voice's number and share of the non-host
 * words, the label the attach gives that voice TODAY (the unchanged two-voice rule: a third voice is
 * `Speaker N`, never guessed), and, with `--suggest`, the name Claude would pre-select on the review page
 * (/admin/speakers). A saved review (`sources.speaker_names`, migration 039) is shown with what a re-attach
 * would do with it.
 *
 * WHAT IT DOES AND DOES NOT TOUCH. It SELECTs the episode rows (title, authors, status, and the saved review
 * when the column exists) and reads the Deepgram file from disk. It writes nothing: no database write, no
 * file, no transcript. The only outside call is the optional suggestion read (lib/speakerRead.ts), on the
 * subscription backend by default.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { guestsForLabels, nameSpeakers, openingSpeaker, voiceOrder } from '../lib/deepgramSegments'
import type { DgSegment } from '../lib/deepgramSegments'
import { stopKindOf } from '../lib/guestNames'
import { claudeSpeakerLlm, suggestGuestVoice } from '../lib/speakerRead'
import { nameSpeakersAssigned, readSpeakerNames } from '../lib/speakerReview'
import { hostLabelForKey } from '../lib/shows'

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

const args = process.argv.slice(2)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

type DgFile = { segments: DgSegment[] }

/** `<root>/<key>/<key>[.model].deepgram.json`, else `<root>/<key>[.model].deepgram.json`. */
async function findDeepgramFile(root: string, key: string): Promise<{ file: string; dir: string } | null> {
  for (const dir of [path.join(root, key), root]) {
    let entries: string[] = []
    try { entries = await readdir(dir) } catch { continue }
    const hit = entries.find(f => f.startsWith(`${key}.`) && f.endsWith('.deepgram.json'))
    if (hit) return { file: path.join(dir, hit), dir }
  }
  return null
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length

/** Each non-host voice's words and its share of ALL non-host words, in first-appearance order. */
function voiceShares(segments: DgSegment[]): { speaker: number; words: number; share: number }[] {
  const order = voiceOrder(segments)
  const words = new Map(order.map(v => [v, 0]))
  for (const s of segments) if (s.speaker !== null && words.has(s.speaker)) words.set(s.speaker, (words.get(s.speaker) ?? 0) + wordCount(s.text))
  const total = [...words.values()].reduce((a, b) => a + b, 0)
  return order.map(speaker => ({ speaker, words: words.get(speaker) ?? 0, share: total > 0 ? (words.get(speaker) ?? 0) / total : 0 }))
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const pct = (x: number) => `${(x * 100).toFixed(0)}%`

async function main() {
  const root = val('--dir')
  const suggest = args.includes('--suggest')
  const keys = (val('--keys') ?? '').split(',').map(k => k.trim()).filter(Boolean)
  if (!root || keys.length === 0) throw new Error('usage: previewGuestVoices.ts --dir <audio-root> --keys <k1,k2,…> [--suggest]')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  type Row = { id: string; external_id: string | null; title: string | null; authors: string[] | null; processing_status: string | null; speaker_names?: unknown }
  const base = 'id, external_id, title, authors, processing_status'
  let { data, error } = await db.from('sources').select(`${base}, speaker_names`).in('external_id', keys)
  if (error && /speaker_names/.test(error.message)) {
    process.stdout.write('note: sources.speaker_names does not exist yet (migration 039 is not applied): no saved reviews to show\n')
    ;({ data, error } = await db.from('sources').select(base).in('external_id', keys))
  }
  if (error) throw new Error(`source lookup failed: ${error.message}`)
  const byKey = new Map(((data ?? []) as unknown as Row[]).map(r => [r.external_id as string, r]))

  const llm = claudeSpeakerLlm()
  process.stdout.write(
    `${pad('Episode', 10)}${pad('Title', 45)}${pad('Voice', 7)}${pad('Words', 8)}${pad('Share', 7)}${pad('Label today', 14)}${suggest ? 'Suggested for the guest' : ''}\n`
  )

  for (const key of keys) {
    const row = byKey.get(key)
    const host = hostLabelForKey(key)
    const found = await findDeepgramFile(root, key)
    if (!row || !host || !found) {
      process.stdout.write(`${pad(key, 10)}skipped: ${!row ? 'no database row' : !host ? 'no registered show' : 'no Deepgram file under --dir'}\n\n`)
      continue
    }
    const dg = JSON.parse(await readFile(found.file, 'utf8')) as DgFile
    let manifestGuests: string[] | undefined
    try {
      const man = JSON.parse(await readFile(path.join(found.dir, 'manifest.json'), 'utf8')) as { episodes: { key: string; guests?: string[] }[] }
      manifestGuests = man.episodes.find(e => e.key === key)?.guests ?? []
    } catch { /* the row's `authors` is the record; the manifest is only the fallback */ }
    const { guests } = guestsForLabels({ row, manifestGuests, host })

    const today = nameSpeakers(dg.segments, guests, host)
    const shares = voiceShares(dg.segments)
    const hostVoice = openingSpeaker(dg.segments)

    // The suggestion: only when exactly one guest is listed and there is more than one voice to choose among.
    let suggestedVoice: number | null = null
    let why = ''
    if (suggest) {
      if (guests.length !== 1) why = guests.length === 0 ? 'no guest is listed' : `${guests.length} guests are listed; not suggested`
      else if (shares.length < 2) why = 'one voice besides the host: the attach already names it'
      else {
        try {
          const r = await suggestGuestVoice({ segments: dg.segments, host, guest: guests[0], llm })
          suggestedVoice = r.voice
          why = r.why
        } catch (err) {
          if (!stopKindOf(err)) throw err
          why = `stopped: the suggestion read is unavailable (${err instanceof Error ? err.message.slice(0, 100) : String(err)})`
        }
      }
    }

    const voices = [
      ...(hostVoice === null ? [] : [{ speaker: hostVoice, words: null as number | null, share: null as number | null }]),
      ...shares,
    ]
    voices.forEach((v, i) => {
      const suggested = suggestedVoice === v.speaker ? `${guests[0]}   <- suggested` : ''
      process.stdout.write(
        `${pad(i === 0 ? key : '', 10)}${pad(i === 0 ? row.title ?? '' : '', 45)}${pad(String(v.speaker), 7)}${pad(v.words === null ? '' : String(v.words), 8)}` +
          `${pad(v.share === null ? '(host)' : pct(v.share), 7)}${pad(today.get(v.speaker) ?? '?', 14)}${suggested}\n`
      )
    })
    process.stdout.write(`${pad('', 10)}authors: ${(row.authors ?? []).join(' | ') || '(none)'}; status ${row.processing_status}\n`)
    if (suggest) process.stdout.write(`${pad('', 10)}suggestion: ${suggestedVoice === null ? 'none' : `voice ${suggestedVoice}`} — ${why}\n`)

    const saved = readSpeakerNames(row.speaker_names)
    if (Object.keys(saved).length > 0) {
      const result = nameSpeakersAssigned(dg.segments, guests, host, saved)
      process.stdout.write(
        `${pad('', 10)}saved review: ${Object.entries(saved).map(([l, a]) => `${l} → ${a.name ?? 'not a guest'}`).join('; ')}; ` +
          `a re-attach ${result.ignored ? `would IGNORE it (${result.ignored})` : `would apply ${result.applied.length} name(s)`}\n`
      )
    }
    process.stdout.write('\n')
  }
  process.stdout.write('Nothing was written.\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
