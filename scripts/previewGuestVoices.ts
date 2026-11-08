/**
 * What would the attach step name the speakers of these episodes? READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/previewGuestVoices.ts --dir <audio-root> --keys fmf-0012,fmf-0020
 *
 *   --dir <audio-root>   where the Deepgram files are: `<root>/<key>/<key>.deepgram.json`
 *                        (the runner's layout, scratchpad/batch3/audio) or `<root>/<key>.deepgram.json`.
 *   --keys <k1,k2,…>     the episodes (`sources.external_id`), required.
 *   --probe-read         DIAGNOSTIC: also make the confirmation read for an episode the share rule would NOT
 *                        name, and print what it says and whether the opening voice is only an intro/outro.
 *                        It never changes a proposed label; it exists to see why a rule does not fire.
 *
 * For each episode it prints a table: the id, the title, each voice's number and share of the
 * non-host words, the label that voice carries TODAY (the rule without the third-voice step), and the
 * label it would carry NOW (share rule + confirmation read). One line under each episode says why.
 *
 * WHAT IT DOES AND DOES NOT TOUCH. It SELECTs the episode's row (title, authors, status) and reads
 * the Deepgram file from disk. It writes nothing: no database write, no file, no transcript. The only
 * outside call is the confirmation read (lib/speakerRead.ts): one small model call per episode the
 * share rule would name, on the subscription backend by default. `SKIP_GUEST_VOICE_READ=1` makes no
 * call at all (the share rule then decides alone and the table says "skipped").
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { guestsForLabels, nameSpeakers, openingSpeaker } from '../lib/deepgramSegments'
import type { DgSegment } from '../lib/deepgramSegments'
import { stopKindOf } from '../lib/guestNames'
import { claudeSpeakerLlm, nameSpeakersWithRead, readGuestSpeaker, readSkipped } from '../lib/speakerRead'
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

/**
 * Words the opening voice speaks in the middle of the episode, as a share of all its words: close to 0 means it is a
 * produced intro and outro (a different recording from the conversation), not the person doing the interview.
 */
function openerMiddleShare(segments: DgSegment[], opener: number): number {
  const end = segments[segments.length - 1]?.start_ms ?? 0
  const w = (s: DgSegment) => s.text.split(/\s+/).filter(Boolean).length
  const mine = segments.filter(s => s.speaker === opener)
  const all = mine.reduce((a, s) => a + w(s), 0)
  const mid = mine.filter(s => s.start_ms > end * 0.15 && s.start_ms < end * 0.85).reduce((a, s) => a + w(s), 0)
  return all > 0 ? mid / all : 0
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

async function main() {
  const root = val('--dir')
  const probe = args.includes('--probe-read')
  const keys = (val('--keys') ?? '').split(',').map(k => k.trim()).filter(Boolean)
  if (!root || keys.length === 0) throw new Error('usage: previewGuestVoices.ts --dir <audio-root> --keys <k1,k2,…>')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  type Row = { id: string; external_id: string | null; title: string | null; authors: string[] | null; processing_status: string | null }
  const { data, error } = await db.from('sources').select('id, external_id, title, authors, processing_status').in('external_id', keys)
  if (error) throw new Error(`source lookup failed: ${error.message}`)
  const byKey = new Map(((data ?? []) as unknown as Row[]).map(r => [r.external_id as string, r]))

  const llm = claudeSpeakerLlm()
  if (readSkipped()) process.stdout.write('SKIP_GUEST_VOICE_READ=1: no confirmation read is made; the share rule decides alone\n')
  process.stdout.write(
    `${pad('Episode', 10)}${pad('Title', 46)}${pad('Voice', 7)}${pad('Words', 8)}${pad('Share', 8)}${pad("Today's label", 24)}Proposed label\n`
  )

  let changed = 0
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
    let naming
    try {
      naming = await nameSpeakersWithRead({ segments: dg.segments, guests, host, llm })
    } catch (err) {
      if (!stopKindOf(err)) throw err
      process.stdout.write(`${pad(key, 10)}stopped: the confirmation read is unavailable (${err instanceof Error ? err.message.slice(0, 100) : String(err)})\n\n`)
      continue
    }

    const hostVoice = openingSpeaker(dg.segments)
    const voices = [
      ...(hostVoice === null ? [] : [{ speaker: hostVoice, words: null as number | null, share: null as number | null }]),
      ...naming.shares,
    ]
    voices.forEach((v, i) => {
      const t = today.get(v.speaker) ?? '?'
      const p = naming.names.get(v.speaker) ?? '?'
      if (t !== p) changed++
      process.stdout.write(
        `${pad(i === 0 ? key : '', 10)}${pad(i === 0 ? row.title ?? '' : '', 46)}${pad(String(v.speaker), 7)}${pad(v.words === null ? '' : String(v.words), 8)}` +
          `${pad(v.share === null ? '(host)' : pct(v.share), 8)}${pad(t, 24)}${p}${t !== p ? '   <- changed' : ''}\n`
      )
    })
    process.stdout.write(
      `${pad('', 10)}authors: ${(row.authors ?? []).join(' | ') || '(none)'}; status ${row.processing_status}\n` +
        `${pad('', 10)}why: ${naming.call.reason}${naming.note ? ` (${naming.note})` : ''}\n`
    )
    if (probe && hostVoice !== null) {
      const mid = openerMiddleShare(dg.segments, hostVoice)
      let said = 'not asked (needs exactly one guest)'
      if (guests.length === 1 && naming.shares.length >= 1) {
        const r = naming.read !== undefined ? { read: naming.read, note: '' } : await readGuestSpeaker({ segments: dg.segments, host, guest: guests[0], llm })
        said = r.read === 'unsure' ? `unsure${r.note ? ` (${r.note})` : ''}` : r.read === 'skipped' ? 'skipped' : `voice ${r.read} is ${guests[0]}`
      }
      process.stdout.write(
        `${pad('', 10)}probe: voice ${hostVoice} speaks ${(mid * 100).toFixed(0)}% of its words in the middle 70% of the episode` +
          `${mid < 0.05 ? ' (a produced intro/outro, not the interviewer)' : ''}; the read says: ${said}\n`
      )
    }
    process.stdout.write('\n')
  }
  process.stdout.write(`${changed} voice label(s) would change. Nothing was written.\n`)
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
