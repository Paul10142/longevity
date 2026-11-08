/**
 * Accuracy of Claude's guest-name reading against the hand-labelled gold set.
 *
 *   npx tsx --env-file=.env.local scripts/evalGuestNames.ts
 *   npx tsx --env-file=.env.local scripts/evalGuestNames.ts --model claude-sonnet-5-5 --out result.json
 *
 * Reads tests/fixtures/guest-gold.json (about 100 episodes from the three feeds, labelled
 * by reading each title and its notes), runs `resolveGuests` exactly as refreshGuests.ts
 * does (same prompt, same batches, same validation, same fallback), and prints:
 *   - episode-level exact-match accuracy (the guest list must match; case, accents and
 *     order ignored), per show and overall, for Claude's pipeline AND for the two title
 *     rules, so the gain is measured and not assumed;
 *   - every disagreement, with the reason the pipeline gave.
 *
 * No database, no Deepgram, no audio. It spends Claude calls (about 5 batches on the
 * subscription), so run `sh ~/.claude/usage-guard/check.sh` first.
 *
 * Flags: --model <id> (default: the bulk tier), --thinking (let the CLI think; off by
 * default), --out <file> (the full per-episode result), --limit <n> (first n only).
 */
export {} // module marker: keep `main` file-scoped

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  claudeGuestLlm,
  defaultGuestModel,
  fallbackGuests,
  resolveGuests,
  sameGuestSet,
  type Decision,
  type GuestEpisode,
} from '../lib/guestNames'
import { parseGuests } from '../lib/podcastFeed'
import { isHostName, showByPrefix, type Show } from '../lib/shows'

type GoldEpisode = {
  show: string
  key: string
  group: string
  title: string
  notes: string
  expected: string[]
  note?: string
  unsure?: boolean
}

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`)

async function main() {
  const gold = (JSON.parse(readFileSync(resolve('tests/fixtures/guest-gold.json'), 'utf8')) as { episodes: GoldEpisode[] }).episodes
  const limit = Number(val('--limit')) || Infinity
  const episodes = gold.slice(0, limit)
  const model = val('--model') ?? (await defaultGuestModel())
  const llm = claudeGuestLlm(model, !has('--thinking'))
  process.stdout.write(`gold set: ${episodes.length} episodes | model ${model} | thinking ${has('--thinking') ? 'on' : 'off'}\n`)

  const decided = new Map<string, Decision>()
  let stopped: string | null = null
  for (const showPrefix of ['attia', 'fmf', 'huberman']) {
    const show = showByPrefix(showPrefix) as Show
    const mine = episodes.filter(e => e.show === showPrefix)
    if (mine.length === 0) continue
    const input: GuestEpisode[] = mine.map(e => ({ id: e.key, title: e.title, description: e.notes }))
    const r = await resolveGuests(show, input, llm)
    for (const [id, d] of r.decisions) decided.set(id, d)
    if (r.stopped) { stopped = `${r.stopped.kind}: ${r.stopped.message}`; break }
  }
  if (stopped) process.stdout.write(`STOPPED EARLY (${stopped}): the rest used the fallback\n`)

  type Row = { e: GoldEpisode; got: string[]; d: Decision; ok: boolean; legacyOk: boolean; strictOk: boolean }
  const rows: Row[] = episodes.map(e => {
    const show = showByPrefix(e.show) as Show
    const d = decided.get(e.key) as Decision
    const legacy = parseGuests(e.title, false).filter(g => !isHostName(show, g))
    return {
      e,
      got: d.guests,
      d,
      ok: sameGuestSet(d.guests, e.expected),
      legacyOk: sameGuestSet(legacy, e.expected),
      strictOk: sameGuestSet(fallbackGuests({ ...show, strictGuests: true }, e.title), e.expected),
    }
  })

  const line = (label: string, rs: Row[]) =>
    process.stdout.write(
      `${label.padEnd(10)} n=${String(rs.length).padStart(3)}  claude ${pct(rs.filter(r => r.ok).length, rs.length).padStart(6)}` +
        `  strict rule ${pct(rs.filter(r => r.strictOk).length, rs.length).padStart(6)}` +
        `  legacy rule ${pct(rs.filter(r => r.legacyOk).length, rs.length).padStart(6)}\n`
    )
  process.stdout.write('\nepisode-level exact match (guest list)\n')
  for (const p of ['attia', 'fmf', 'huberman']) line(p, rows.filter(r => r.e.show === p))
  line('ALL', rows)
  const fb = rows.filter(r => r.d.decided_by === 'fallback').length
  process.stdout.write(`decided by claude ${rows.length - fb}, by fallback ${fb}\n`)
  const sure = rows.filter(r => !r.e.unsure)
  process.stdout.write(`without the ${rows.length - sure.length} labels flagged unsure: claude ${pct(sure.filter(r => r.ok).length, sure.length)}\n`)

  const bad = rows.filter(r => !r.ok)
  process.stdout.write(`\ndisagreements (${bad.length})\n`)
  for (const r of bad) {
    process.stdout.write(
      `  ${r.e.key}${r.e.unsure ? ' [label unsure]' : ''}\n    title:    ${r.e.title.slice(0, 120)}\n` +
        `    expected: ${JSON.stringify(r.e.expected)}\n    got:      ${JSON.stringify(r.got)}  (${r.d.decided_by}: ${r.d.reason})\n`
    )
  }
  if (val('--out')) {
    writeFileSync(
      resolve(val('--out') as string),
      JSON.stringify(rows.map(r => ({ key: r.e.key, expected: r.e.expected, got: r.got, ok: r.ok, decided_by: r.d.decided_by, reason: r.d.reason })), null, 1) + '\n'
    )
  }
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
