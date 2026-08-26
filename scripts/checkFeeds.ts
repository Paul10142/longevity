/**
 * Weekly check: has any show published episodes we have not ingested?
 *
 *   npx tsx --env-file=.env.local scripts/checkFeeds.ts
 *
 * Read-only. Prints what is missing and the command that would fetch it; writes
 * nothing, so it is safe to run on a schedule without supervision.
 *
 * WHY REPORT-ONLY BY DEFAULT. A watcher that ingests unattended would, on a week
 * when a show published five episodes, quietly start a download, a paid
 * transcription and an extraction run with nobody watching the budget. The
 * expensive half stays a deliberate act.
 *
 * SCHEDULING IS NOT SET UP HERE, ON PURPOSE. This project already had a daily
 * Vercel cron and it caused real damage: cloud functions cannot reach the local
 * `claude` CLI, so every run fell through to the API backend whose key had no
 * credit, adding ~1,500 claims with no deduplication before anyone noticed
 * (removed in 6a1bdc7). Run this locally — by hand, or from a local scheduler —
 * and do not re-add a cloud cron for it.
 *
 * Adding a show: give it an entry below and set its URL in .env.local. A feed
 * whose env var is unset is skipped with a note rather than failing the run, so
 * one missing key never hides the others.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { parseFeed, totalHours } from '../lib/podcastFeed'

type FeedConfig = {
  /** Display name, and the value written to `sources.series`. */
  series: string
  /** env var holding the feed URL; feed URLs for paid shows are credentials. */
  env: string
  /** external_id prefix — also the audio filename prefix. */
  prefix: string
}

const FEEDS: FeedConfig[] = [
  { series: 'The Drive', env: 'ATTIA_FEED_URL', prefix: 'attia' },
  { series: 'FoundMyFitness', env: 'FMF_FEED_URL', prefix: 'fmf' },
  { series: 'Huberman Lab', env: 'HUBERMAN_FEED_URL', prefix: 'huberman' },
]

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  let totalNew = 0
  const lines: string[] = []

  for (const feed of FEEDS) {
    const url = process.env[feed.env]
    if (!url) {
      process.stdout.write(`${feed.series}: no ${feed.env} set — skipped\n`)
      continue
    }

    let episodes
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      episodes = parseFeed(await res.text(), feed.prefix)
    } catch (err) {
      // A feed that is down must not fail the whole check — the other shows
      // still need reporting, and a transient error is not news.
      process.stdout.write(`${feed.series}: feed unreachable (${err instanceof Error ? err.message : String(err)})\n`)
      continue
    }

    const keys = episodes.map(e => e.key)
    const known = new Set<string>()
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await db.from('sources').select('external_id').in('external_id', keys.slice(i, i + 200))
      if (error) throw new Error(`lookup failed for ${feed.series}: ${error.message}`)
      for (const r of data ?? []) if (r.external_id) known.add(r.external_id)
    }

    const missing = episodes.filter(e => !known.has(e.key))
    const { hours } = totalHours(missing)
    totalNew += missing.length

    process.stdout.write(
      `${feed.series}: ${episodes.length} in the feed, ${known.size} already known, ` +
        `${missing.length} NEW${missing.length ? ` (~${hours.toFixed(1)} h audio)` : ''}\n`
    )
    // Newest first, and only a handful listed — the count is the signal, the
    // titles are just so it is obvious what turned up.
    for (const e of missing.slice(0, 5)) {
      process.stdout.write(`    ${e.published_at?.slice(0, 10) ?? '—'}  ${e.title.slice(0, 70)}\n`)
    }
    if (missing.length > 5) process.stdout.write(`    …and ${missing.length - 5} more\n`)

    if (missing.length > 0 && feed.env === 'ATTIA_FEED_URL') {
      lines.push(`  npx tsx --env-file=.env.local scripts/ingestFeedSources.ts   # ${feed.series}: add the rows`)
      lines.push(`  npx tsx --env-file=.env.local scripts/fetchPodcastFeed.ts --limit ${missing.length} --out ~/Desktop/'Lifestyle Academy'/Audio`)
    }
  }

  if (totalNew === 0) {
    process.stdout.write('\nNothing new. Everything the feeds publish is already in the library.\n')
    return
  }
  process.stdout.write(`\n${totalNew} new episode(s). To ingest:\n`)
  for (const l of lines) process.stdout.write(`${l}\n`)
  process.stdout.write('  then attachTranscripts.ts and extractDeepgram.ts as usual\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
