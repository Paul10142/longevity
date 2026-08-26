/**
 * Fill in `sources.youtube_url` by matching a channel listing to episodes.
 *
 *   yt-dlp --flat-playlist --print "%(id)s|%(title)s" \
 *     "https://www.youtube.com/@PeterAttiaMD/videos" > /tmp/attia_yt.txt
 *   npx tsx --env-file=.env.local scripts/resolveEpisodeLinks.ts /tmp/attia_yt.txt --series "The Drive"
 *
 * WHY A CHANNEL LISTING AND NOT A SEARCH PER EPISODE. Searching the web once per
 * episode is ~425 requests to answer a question one request already answers: the
 * channel publishes its whole catalogue, and every full episode's title begins
 * with its episode number. Matching on that number is exact — a search result is
 * a guess, and a wrong video attached to an episode is worse than no video,
 * because nothing downstream would ever question it.
 *
 * MATCHES ONLY ON THE EPISODE NUMBER, never on title similarity. The channel
 * carries ~1,384 videos of which only ~292 are numbered full episodes; the rest
 * are clips whose titles are often near-identical to the episode they came from.
 * Fuzzy title matching would attach a 4-minute clip to a 2-hour episode, and the
 * catalogue would show a confident, wrong link.
 *
 * Idempotent and non-destructive: only fills rows where youtube_url is null.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

/** yt-dlp writes `\t` from a --print template literally, so accept either. */
function splitRow(line: string): [string, string] | null {
  for (const sep of ['|', '\\t', '\t']) {
    const i = line.indexOf(sep)
    if (i > 0) return [line.slice(0, i).trim(), line.slice(i + sep.length).trim()]
  }
  return null
}

/** Episode number from a title like `#404 ‒ Mental health…` or `404 - …`.
 *  Anchored at the start: a number later in a title is a dose, a study year, or
 *  an "AMA #88" reference, none of which identify the episode. */
function episodeNumber(title: string): number | null {
  const m = title.match(/^\s*#?\s*(\d{1,4})\s*[-–—‒:]/)
  return m ? Number(m[1]) : null
}

async function main() {
  const file = args.find(a => !a.startsWith('--') && !['--series'].includes(args[args.indexOf(a) - 1]))
  if (!file) throw new Error('usage: resolveEpisodeLinks.ts <yt-dlp-listing> [--series "The Drive"] [--dry-run]')
  const series = val('--series') ?? 'The Drive'
  const dryRun = has('--dry-run')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  const byNumber = new Map<number, string>()
  let clips = 0
  for (const line of lines) {
    const row = splitRow(line)
    if (!row) continue
    const [id, title] = row
    const n = episodeNumber(title)
    if (n === null) { clips++; continue }
    // First wins: the listing is newest-first, and a re-upload should not
    // displace the original.
    if (!byNumber.has(n)) byNumber.set(n, `https://www.youtube.com/watch?v=${id}`)
  }
  process.stdout.write(
    `listing: ${lines.length} videos | ${byNumber.size} numbered episodes | ${clips} clips and unnumbered (ignored)\n`
  )

  const { data: rows, error } = await db
    .from('sources')
    .select('id, episode_number, youtube_url, title')
    .eq('series', series)
    .is('youtube_url', null)
    .not('episode_number', 'is', null)
  if (error) throw new Error(`lookup failed: ${error.message}`)

  const targets = (rows ?? []) as { id: string; episode_number: number; title: string | null }[]
  const matched = targets.filter(r => byNumber.has(r.episode_number))
  process.stdout.write(
    `${series}: ${targets.length} episode(s) missing a YouTube link, ${matched.length} matched by number\n`
  )

  if (dryRun) {
    matched.slice(0, 5).forEach(r => process.stdout.write(`  #${r.episode_number}  ${(r.title ?? '').slice(0, 56)}\n`))
    process.stdout.write('\ndry run — nothing written\n')
    return
  }

  let updated = 0
  for (const r of matched) {
    const { error: upErr } = await db
      .from('sources')
      .update({ youtube_url: byNumber.get(r.episode_number) })
      .eq('id', r.id)
      .is('youtube_url', null) // never overwrite a link already resolved
    if (upErr) { process.stdout.write(`  #${r.episode_number} failed: ${upErr.message}\n`); continue }
    updated++
  }
  process.stdout.write(`\nfilled ${updated} YouTube link(s)\n`)
  process.stdout.write(`${targets.length - matched.length} episode(s) still have none — the channel has no numbered video for them\n`)
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
