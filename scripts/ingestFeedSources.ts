/**
 * Podcast feed → `sources` rows, so episodes appear in the admin queue before
 * any audio is transcribed.
 *
 *   npx tsx --env-file=.env.local scripts/ingestFeedSources.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/ingestFeedSources.ts --limit 100
 *   npx tsx --env-file=.env.local scripts/ingestFeedSources.ts --show fmf --dry-run
 *   npx tsx --env-file=.env.local scripts/ingestFeedSources.ts --show huberman --dry-run
 *
 * --show <prefix> picks the show from the registry (lib/shows.ts): its feed URL
 * variable, its host (the first author of every row), its series, its
 * `external_id` prefix. Default `attia` (The Drive), so the Drive's command is
 * unchanged. The old --feed-env / --prefix flags are gone: a show is ONE registry
 * entry, never a mix of flags that could pair one show's feed with another's host.
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
 * RE-POSTS ARE NEVER QUEUED (migration 038). Shows re-post old episodes under a
 * new feed id: a rebroadcast, a re-release, a 30-minute "Essentials" cut, the same
 * recording under a second title. Before a NEW row is inserted it is checked against
 * the whole library with lib/episodeDuplicates.ts (same episode number in the title,
 * same title once numbers and markers are ignored, same guests and length). A match is
 * still inserted, so the feed never re-creates it, but as `processing_status =
 * 'skipped'` with `duplicate_of` and `skip_reason`; every picker ignores skipped rows,
 * so it is never transcribed (Deepgram bills per minute) or extracted. A title that is
 * an `Essentials:` cut or says rebroadcast / re-release is skipped even when its
 * original is not in the library (full episodes only), and so is a Huberman Lab
 * `AMA #N:` or live Q&A item (Paul, 2026-11-08: not full episodes). Different episode
 * numbers are never duplicates. Only rows this run CREATES are checked; linked and refreshed rows
 * are never changed. `--no-duplicate-check` switches the check off.
 *
 * WHAT IS DELIBERATELY NOT STORED: the enclosure URL. It carries the membership
 * key, and a credential in a database row outlives every intention to remove it.
 * `media_url` therefore stays null; the audio lives locally, named by the key.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { planNewEpisodes, type LibraryRow, type NewEpisode, type PlannedEpisode } from '../lib/episodeDuplicates'
import { isFeedKey, matchOlderRows, parseEpisodeNumber, parseFeed, totalHours } from '../lib/podcastFeed'
import type { OlderRow } from '../lib/podcastFeed'
import { DEFAULT_SHOW, SHOWS, showByPrefix, showForSource } from '../lib/shows'
import { isPublicUrl } from '../lib/sourceLinks'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

async function main() {
  if (has('--feed-env') || has('--prefix')) {
    throw new Error('--feed-env and --prefix are replaced by --show <prefix> (lib/shows.ts registry)')
  }
  const showArg = val('--show') ?? DEFAULT_SHOW.prefix
  const show = showByPrefix(showArg)
  if (!show) throw new Error(`unknown show "${showArg}" — registered: ${SHOWS.map(s => s.prefix).join(', ')}`)
  const feedEnv = show.env
  const feedUrl = process.env[feedEnv]
  if (!feedUrl) throw new Error(`${feedEnv} is not set (it belongs in .env.local)`)

  const prefix = show.prefix
  const limit = Number(val('--limit')) || Infinity
  const skip = Number(val('--skip')) || 0
  const dryRun = has('--dry-run')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const res = await fetch(feedUrl)
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`)
  const all = parseFeed(await res.text(), prefix)
  if (all.length === 0) throw new Error('feed parsed to 0 episodes — aborting rather than writing nothing')

  process.stdout.write(
    `show: ${show.series} | host ${show.host} | external_id prefix ${prefix}- | feed from $${feedEnv}\n`
  )
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
  //
  // PAGED: PostgREST caps one response at 1000 rows and the library is past that, so a
  // plain select silently drops the newest rows. A dropped row would be invisible to the
  // duplicate check below, so every read of this table goes through selectAllPaged.
  const { selectAllPaged } = await import('../lib/pagination')
  type ExistingRow = {
    id: string
    title: string | null
    external_id: string | null
    authors: string[] | null
    series: string | null
    processing_status?: string | null
    duplicate_of?: string | null
    created_at?: string | null
    media_duration_sec?: number | null
    date?: string | null
  }
  const baseCols = 'id, title, external_id, authors, series'
  const dupCols = `${baseCols}, processing_status, duplicate_of, created_at, media_duration_sec, date`
  // Migration 038 adds `duplicate_of`. Until it is applied the duplicate check still
  // RUNS (so the report is complete) but cannot write a skipped row, so a would-be
  // duplicate is held back — never inserted as a pending row, which is the cost this
  // check exists to prevent.
  let skipColumnsReady = true
  let existing: ExistingRow[]
  try {
    existing = await selectAllPaged<ExistingRow>((from, to) => db.from('sources').select(dupCols).order('id').range(from, to))
  } catch (e) {
    if (!/duplicate_of|column/i.test(String(e))) throw new Error(`existing-row lookup failed: ${e instanceof Error ? e.message : String(e)}`)
    skipColumnsReady = false
    existing = await selectAllPaged<ExistingRow>((from, to) => db.from('sources').select(`${baseCols}, processing_status, created_at, media_duration_sec, date`).order('id').range(from, to))
  }

  // NUMBER MATCHING IS PER SHOW. Episode numbers are only unique within a show:
  // FoundMyFitness #114 and The Drive #114 are different episodes, and matching
  // across shows would attach a FoundMyFitness feed episode to a Drive row.
  // A row's show is its `series`, else its external_id prefix, else its first
  // author, else The Drive (so the pre-feed YouTube rows stay The Drive's).
  // A show that does not number its episodes (Huberman Lab) skips this entirely.
  const inThisShow = (r: { series?: string | null; external_id?: string | null; authors?: string[] | null }) =>
    showForSource(r).prefix === prefix

  const byExternalId = new Map<string, string>()
  const byNumber = new Map<number, string[]>()
  const idHasExternalId = new Set<string>()
  for (const r of existing) {
    if (r.external_id) { byExternalId.set(r.external_id, r.id); idHasExternalId.add(r.id) }
    if (!show.numbered || !inThisShow(r)) continue
    const n = parseEpisodeNumber(r.title ?? '')
    if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), r.id])
  }

  // `older`: the library already holds this episode under an id from before the
  // feed was ingested (`fmf-george-church` for the feed's `fmf-0077`; the 17
  // rows ingestFoundMyFitness.ts made from published transcripts). Creating a
  // second row would split the episode's claims and double-count it, so it is
  // left alone and listed. Only ids that LOOK like this show's (`fmf-…`) but are
  // not feed keys count — a YouTube-id row is never a candidate.
  type Plan = { ep: (typeof episodes)[number]; action: 'create' | 'link' | 'update' | 'older'; id?: string; olderKey?: string }

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

  const olderRows = existing.filter(
    r => inThisShow(r) && r.external_id?.startsWith(`${prefix}-`) && !isFeedKey(prefix, r.external_id)
  ) as OlderRow[]
  if (olderRows.length > 0) {
    const toCreate = plans.filter(p => p.action === 'create').map(p => p.ep)
    const matched = matchOlderRows(toCreate, olderRows, prefix)
    for (const plan of plans) {
      const row = matched.get(plan.ep.key)
      if (plan.action === 'create' && row) { plan.action = 'older'; plan.id = row.id; plan.olderKey = row.external_id }
    }
  }

  const ambiguous = episodes.filter(
    ep => ep.episode_number && (byNumber.get(ep.episode_number)?.length ?? 0) > 1
  )
  const count = (a: Plan['action']) => plans.filter(p => p.action === a).length
  process.stdout.write(
    `plan: ${count('create')} new, ${count('link')} linked to an existing YouTube row, ` +
      `${count('update')} refreshed` +
      (count('older') ? `, ${count('older')} already in the library under an older id (not created)` : '') +
      (ambiguous.length ? ` | ${ambiguous.length} ambiguous (left alone)` : '') + '\n'
  )

  // DUPLICATE CHECK. Only rows about to be CREATED are checked (a linked or refreshed
  // row is never changed), against the whole library and against each other.
  type Skip = { reason: string; duplicateOf: string | null }
  const dupCheck = !has('--no-duplicate-check')
  const planned = new Map<string, PlannedEpisode>()
  if (dupCheck) {
    const library: LibraryRow[] = existing.map(r => ({
      id: r.id,
      title: r.title ?? '',
      series: r.series,
      external_id: r.external_id,
      authors: r.authors,
      media_duration_sec: r.media_duration_sec,
      created_at: r.created_at,
      processing_status: r.processing_status,
      duplicate_of: r.duplicate_of,
      published_at: r.date,
    }))
    const fresh: NewEpisode[] = plans
      .filter(p => p.action === 'create')
      .map(p => ({
        key: p.ep.key,
        title: p.ep.title,
        series: show.series,
        external_id: p.ep.key,
        authors: [show.host, ...p.ep.guests],
        media_duration_sec: p.ep.duration_seconds,
        published_at: p.ep.published_at,
      }))
    // Insert order: originals before the copies that point at them.
    for (const pl of planNewEpisodes(fresh, library)) planned.set(pl.episode.key, pl)
  }
  const skipOf = (key: string): Skip | null => {
    const pl = planned.get(key)
    if (!pl || !pl.decision.skip) return null
    const orig = pl.decision.original
    const duplicateOf = pl.originalKey ? null : orig && !orig.row.id.startsWith('new:') ? orig.row.id : null
    return { reason: pl.decision.reason, duplicateOf }
  }
  const skippedKeys = [...planned.values()].filter(pl => pl.decision.skip)
  if (dupCheck) {
    process.stdout.write(
      `duplicate check: ${skippedKeys.length} of ${count('create')} new episode(s) are re-posts or copies → created as skipped, never transcribed or extracted` +
        (skippedKeys.length && !skipColumnsReady ? ' | migration 038 NOT applied: they are held back instead of written' : '') + '\n'
    )
  } else {
    process.stdout.write('duplicate check: OFF (--no-duplicate-check)\n')
  }

  // What a create writes. One function so the dry run prints EXACTLY the row the
  // real run inserts. `article_url` is the public episode page and nothing else:
  // a private feed URL (the Drive's guid is a Supercast link) stays out of it.
  const createRow = (e: (typeof episodes)[number], skip?: Skip | null): Record<string, unknown> => ({
    external_id: e.key,
    episode_number: e.episode_number,
    description: e.description,
    media_duration_sec: e.duration_seconds,
    type: 'podcast',
    title: e.title,
    // Host first, then guests. Guests come only from an explicit title
    // segment — never inferred — so an AMA correctly lists the host alone.
    // A phantom guest would invent agreement that never happened once
    // corroboration starts counting distinct speakers.
    authors: [show.host, ...e.guests],
    series: show.series,
    date: e.published_at?.slice(0, 10) ?? null,
    url: e.page_url,
    article_url: isPublicUrl(e.page_url) ? e.page_url : null,
    media_type: 'audio',
    authority_tier: 'expert',
    processing_status: skip ? 'skipped' : 'pending',
    ...(skip ? { duplicate_of: skip.duplicateOf, skip_reason: skip.reason } : {}),
    // media_url intentionally omitted — see the header.
  })

  if (dryRun) {
    process.stdout.write('\ndry run — nothing written. First few:\n')
    plans.slice(0, 6).forEach(p =>
      process.stdout.write(
        `  ${p.ep.key}  ep ${p.ep.episode_number ?? '—'}  ${p.ep.published_at?.slice(0, 10)}  ` +
          `${p.action.padEnd(6)}  guests: ${p.ep.guests.join(', ') || '(none)'}\n`
      )
    )
    const older = plans.filter(p => p.action === 'older')
    if (older.length > 0) {
      process.stdout.write(`\nalready in the library under an older id (${older.length}):\n`)
      older.forEach(p => process.stdout.write(`  ${p.ep.key}  =  ${p.olderKey}  ${p.ep.title.slice(0, 60)}\n`))
    }
    if (skippedKeys.length > 0) {
      process.stdout.write(`\nwould be created as SKIPPED (${skippedKeys.length}) — never transcribed or extracted:\n`)
      skippedKeys.slice(0, 25).forEach(pl => {
        const d = pl.decision
        process.stdout.write(`  ${pl.episode.key}  ${pl.episode.title.slice(0, 64)}\n      ↳ ${d.skip ? d.reason : ''}\n`)
      })
      if (skippedKeys.length > 25) process.stdout.write(`  … and ${skippedKeys.length - 25} more\n`)
    }
    const firstCreate = plans.find(p => p.action === 'create' && !skipOf(p.ep.key))
    if (firstCreate) {
      const row = createRow(firstCreate.ep)
      const shown = { ...row, description: row.description ? `${String(row.description).slice(0, 40)}…` : null }
      process.stdout.write(`\nfirst new row would be written as:\n${JSON.stringify(shown, null, 2)}\n`)
    }
    return
  }

  let created = 0
  let linked = 0
  let refreshed = 0
  let createdSkipped = 0
  let held = 0
  // Non-creates first (they touch existing rows), then creates with originals before the
  // copies that point at them.
  const createOrder = dupCheck
    ? [...planned.keys()].map(k => plans.find(p => p.action === 'create' && p.ep.key === k)!)
    : plans.filter(p => p.action === 'create')
  const ordered = [...plans.filter(p => p.action !== 'create'), ...createOrder]
  const insertedIds = new Map<string, string>() // feed key → new row id, for duplicate_of
  for (const { ep: e, action, id } of ordered) {
    if (action === 'older') continue // left alone — see the Plan type
    // Feed-derived fields that are safe to set on ANY row.
    const existingRow = id ? existing.find(r => r.id === id) : undefined
    const feedFields: Record<string, unknown> = {
      external_id: e.key,
      episode_number: e.episode_number,
      description: e.description,
      media_duration_sec: e.duration_seconds,
    }

    let row: Record<string, unknown>
    let skip: Skip | null = null
    if (action === 'create') {
      skip = skipOf(e.key)
      if (skip && !skipColumnsReady) {
        held++
        process.stdout.write(`  ${e.key} HELD BACK (migration 038 not applied): ${skip.reason}\n`)
        continue
      }
      if (skip && planned.get(e.key)?.originalKey) skip = { ...skip, duplicateOf: insertedIds.get(planned.get(e.key)!.originalKey!) ?? null }
      row = createRow(e, skip)
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
        const current = existingRow?.authors
        if (!current || current.length <= 1) row.authors = [show.host, ...e.guests]
      }
    }

    let error: { message: string } | null
    if (action === 'create') {
      const res = await db.from('sources').insert(row).select('id').single()
      error = res.error
      if (!error && res.data) insertedIds.set(e.key, (res.data as { id: string }).id)
    } else {
      error = (await db.from('sources').update(row).eq('id', id!)).error
    }
    if (error) {
      process.stdout.write(`  ${e.key} FAILED (${action}): ${error.message}\n`)
      continue
    }
    if (action === 'create') { created++; if (skip) createdSkipped++ }
    else if (action === 'link') linked++
    else refreshed++
  }

  process.stdout.write(`\ncreated ${created} (${createdSkipped} of them skipped as re-posts or copies), linked ${linked}, refreshed ${refreshed}${held ? `, held back ${held}` : ''}\n`)
  if (created - createdSkipped > 0) process.stdout.write(`${created - createdSkipped} episode(s) queued and visible in the admin source list\n`)
  if (createdSkipped > 0) process.stdout.write(`${createdSkipped} skipped row(s) are listed, with reasons, at /admin/duplicates\n`)
  if (linked > 0) process.stdout.write(`${linked} existing YouTube-origin row(s) now carry a feed id — no duplicates created\n`)
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
