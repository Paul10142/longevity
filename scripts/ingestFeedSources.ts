/**
 * Podcast feed → `sources` rows, so episodes appear in the admin queue before
 * any audio is transcribed.
 *
 *   npx tsx --env-file=.env.local scripts/ingestFeedSources.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/ingestFeedSources.ts --limit 100
 *
 * Newest first, matching feed order, so the most current material enters the
 * library first and a partial run is still a useful library rather than an
 * arbitrary slice.
 *
 * Requires migration 023 (`description`, `episode_number`, and the unique index
 * on `external_id`).
 *
 * IDEMPOTENT BY `external_id`, which is the same join key the audio file and the
 * transcript use (`attia-0405`). Re-running updates the feed-derived fields and
 * leaves everything the pipeline owns alone — never resets `processing_status`,
 * so re-running cannot silently queue 107 finished episodes for re-extraction.
 *
 * WHAT IS DELIBERATELY NOT STORED: the enclosure URL. It carries the membership
 * key, and a credential in a database row outlives every intention to remove it.
 * `media_url` therefore stays null; the audio lives locally, named by the key.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { parseEpisodeNumber, parseFeed, totalHours } from '../lib/podcastFeed'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

const HOST = 'Dr. Peter Attia'

async function main() {
  const feedEnv = val('--feed-env') ?? 'ATTIA_FEED_URL'
  const feedUrl = process.env[feedEnv]
  if (!feedUrl) throw new Error(`${feedEnv} is not set (it belongs in .env.local — it is a credential)`)

  const prefix = val('--prefix') ?? 'attia'
  const limit = Number(val('--limit')) || Infinity
  const skip = Number(val('--skip')) || 0
  const dryRun = has('--dry-run')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const res = await fetch(feedUrl)
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`)
  const all = parseFeed(await res.text(), prefix)
  if (all.length === 0) throw new Error('feed parsed to 0 episodes — aborting rather than writing nothing')

  const { hours, estimated } = totalHours(all)
  process.stdout.write(
    `feed: ${all.length} episodes, ~${hours.toFixed(0)} h (${estimated} estimated from file size)\n`
  )

  const episodes = all.slice(skip, limit === Infinity ? undefined : skip + limit)
  const withGuests = episodes.filter(e => e.guests.length > 0).length
  const withOutline = episodes.filter(e => e.description && /\d{1,2}:\d{2}/.test(e.description)).length
  process.stdout.write(
    `slice: ${episodes.length} episodes | ${withGuests} name a guest | ${withOutline} carry a timestamped outline\n`
  )

  // MATCH BEFORE INSERT. 125 of the feed's 400 numbered episodes are already in
  // the library, ingested from YouTube captions and carrying a NULL external_id,
  // so keying only on external_id would create a second row for every one of
  // them — two sources for one episode, splitting its claims and double-counting
  // it in any corroboration tally.
  //
  // Episodes are matched on the number in the title, which is the show's own
  // stable identifier. An episode number appearing on MORE THAN ONE existing row
  // is ambiguous and is left alone: a wrong match would attach a transcript to
  // the wrong episode, which is worse than a duplicate because it is invisible.
  const { data: allExisting, error: exErr } = await db
    .from('sources')
    .select('id, title, external_id, authors')
  if (exErr) throw new Error(`existing-row lookup failed: ${exErr.message}`)

  const byExternalId = new Map<string, string>()
  const byNumber = new Map<number, string[]>()
  const idHasExternalId = new Set<string>()
  for (const r of allExisting ?? []) {
    if (r.external_id) { byExternalId.set(r.external_id, r.id); idHasExternalId.add(r.id) }
    const n = parseEpisodeNumber(r.title ?? '')
    if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), r.id])
  }

  type Plan = { ep: (typeof episodes)[number]; action: 'create' | 'link' | 'update'; id?: string }

  // TWO PASSES, and the order matters. A rebroadcast shares its episode number
  // with the original, so number-matching alone can hand one database row to two
  // feed episodes — the second would steal the first's external_id and leave the
  // first with no row at all. So: settle every exact external_id match FIRST,
  // then let number-matching use only rows nothing has claimed and that carry no
  // external_id of their own.
  const claimed = new Set<string>()
  const plans: Plan[] = episodes.map(ep => {
    const direct = byExternalId.get(ep.key)
    if (direct) { claimed.add(direct); return { ep, action: 'update' as const, id: direct } }
    return { ep, action: 'create' as const }
  })
  for (const plan of plans) {
    if (plan.action !== 'create') continue
    const n = plan.ep.episode_number
    if (!n) continue
    const free = (byNumber.get(n) ?? []).filter(id => !claimed.has(id) && !idHasExternalId.has(id))
    // Exactly one free candidate, or it stays a new row. Two candidates is
    // ambiguous and a wrong link is worse than a duplicate: it would attach this
    // episode's transcript to a different episode, invisibly.
    if (free.length === 1) {
      claimed.add(free[0])
      plan.action = 'link'
      plan.id = free[0]
    }
  }

  const ambiguous = episodes.filter(
    ep => ep.episode_number && (byNumber.get(ep.episode_number)?.length ?? 0) > 1
  )
  const count = (a: Plan['action']) => plans.filter(p => p.action === a).length
  process.stdout.write(
    `plan: ${count('create')} new, ${count('link')} linked to an existing YouTube row, ` +
      `${count('update')} refreshed` +
      (ambiguous.length ? ` | ${ambiguous.length} ambiguous (left alone)` : '') + '\n'
  )

  if (dryRun) {
    process.stdout.write('\ndry run — nothing written. First few:\n')
    plans.slice(0, 6).forEach(p =>
      process.stdout.write(
        `  ${p.ep.key}  ep ${p.ep.episode_number ?? '—'}  ${p.ep.published_at?.slice(0, 10)}  ` +
          `${p.action.padEnd(6)}  guests: ${p.ep.guests.join(', ') || '(none)'}\n`
      )
    )
    return
  }

  let created = 0
  let linked = 0
  let refreshed = 0
  for (const { ep: e, action, id } of plans) {
    // Feed-derived fields that are safe to set on ANY row.
    const feedFields: Record<string, unknown> = {
      external_id: e.key,
      episode_number: e.episode_number,
      description: e.description,
      media_duration_sec: e.duration_seconds,
    }

    let row: Record<string, unknown>
    if (action === 'create') {
      row = {
        ...feedFields,
        type: 'podcast',
        title: e.title,
        // Host first, then guests. Guests come only from an explicit title
        // segment — never inferred — so an AMA correctly lists the host alone.
        // A phantom guest would invent agreement that never happened once
        // corroboration starts counting distinct speakers.
        authors: [HOST, ...e.guests],
        date: e.published_at?.slice(0, 10) ?? null,
        url: e.page_url,
        media_type: 'audio',
        authority_tier: 'expert',
        processing_status: 'pending',
        // media_url intentionally omitted — see the header.
      }
    } else {
      // LINKING TO AN EXISTING YOUTUBE ROW IS DELIBERATELY CONSERVATIVE.
      // Those rows already have extracted claims whose citations deep-link into
      // the YouTube video via the source's `url`/`media_url`. Overwriting either
      // with the Supercast page would break every existing citation on 107
      // already-extracted episodes — silently, since nothing checks. So a link
      // ADDS feed identity and metadata and touches nothing the pipeline or the
      // reader already depends on: not url, media_url, type, media_type, title,
      // date, or processing_status.
      row = { ...feedFields }
      // Guests are additive and only when the existing row has none, so a
      // hand-corrected author list is never clobbered.
      if (e.guests.length > 0) {
        const current = (allExisting ?? []).find((r: { id: string }) => r.id === id)?.authors as
          | string[]
          | null
          | undefined
        if (!current || current.length <= 1) row.authors = [HOST, ...e.guests]
      }
    }

    const q = action === 'create'
      ? db.from('sources').insert(row)
      : db.from('sources').update(row).eq('id', id!)
    const { error } = await q
    if (error) {
      process.stdout.write(`  ${e.key} FAILED (${action}): ${error.message}\n`)
      continue
    }
    if (action === 'create') created++
    else if (action === 'link') linked++
    else refreshed++
  }

  process.stdout.write(`\ncreated ${created}, linked ${linked}, refreshed ${refreshed}\n`)
  if (created > 0) process.stdout.write(`${created} episode(s) queued and visible in the admin source list\n`)
  if (linked > 0) process.stdout.write(`${linked} existing YouTube-origin row(s) now carry a feed id — no duplicates created\n`)
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
