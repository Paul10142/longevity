/**
 * Guest names for a show's episodes, read by Claude from each title and its show
 * notes, written to `sources.authors` only after a person has read the plan.
 *
 *   # 1. Make a plan. READ-ONLY: reads the feed and the existing `sources` rows, asks
 *   #    Claude, writes a plan file, prints a summary and every row that would change.
 *   npx tsx --env-file=.env.local scripts/refreshGuests.ts --show fmf --out plan-fmf.json
 *
 *   # 2. Read it, then apply exactly that plan (`--dry-run` first if in doubt).
 *   npx tsx --env-file=.env.local scripts/refreshGuests.ts --apply plan-fmf.json
 *
 * --show attia|fmf|huberman  the show (lib/shows.ts), required to make a plan.
 * --out <file>               where to write the plan (default: print only).
 * --limit <n>                only the first n feed episodes (for a trial).
 * --keys <k1,k2,…>           only these feed keys (`fmf-0113,fmf-0112`): the batch just ingested.
 * --new                      only the rows nobody has read yet: in the library, not yet extracted, and
 *                            still holding exactly the guests the ingest's title rule wrote.
 * --apply-now                make the plan, print every change, then apply it in the same run through
 *                            the same stale-plan guard as --apply. The per-batch step: no plan file.
 * --apply <file>             write the plan's `authors` changes. Takes the show from the plan.
 * --dry-run                  with --apply or --apply-now: say what would be written, write nothing.
 *
 * EVERY NEW BATCH (Paul, 2026-11-08: "apply this plan to all future podcast episodes"). After
 * `ingestFeedSources.ts --show <prefix>` and before anything uses `authors` (the attach):
 *   npx tsx --env-file=.env.local scripts/refreshGuests.ts --show <prefix> --new --apply-now
 * reads only the newly ingested rows, writes only their `authors`, and prints what it changed.
 *
 * HAND-SET ROWS. `lib/guestOverrides.ts` lists guest lists a person set by hand. The model is not
 * asked about those episodes, and `--apply` writes them even from a plan that proposed something
 * else, so neither a re-plan nor an old plan can undo them.
 *
 * WHY NOT THE TITLE RULE. `parseGuests` reads titles with a hand-written rule that
 * loses real guests (`James Clear (#183 rebroadcast)`, `Dr. David Sinclair on …`) and
 * invents others (`M.P.H.`, `Quarterly Podcast Summary #6`). A person reads the title
 * and the notes and knows who the interviewee is; so does Claude (lib/guestNames.ts).
 * Claude proposes, a deterministic check disposes: a name must read as a name, appear
 * in the title or notes, and not be the host, or that episode falls back to the title
 * rule and the plan says so.
 *
 * WHAT --apply TOUCHES. Only `sources.authors`, only on the rows the plan marks
 * changed, and only while each row still holds exactly the authors the plan recorded
 * as current. If any of those rows has changed since the plan was made (a hand
 * correction, a re-ingest), NOTHING is written and the plan must be made again. The
 * host stays `authors[0]`. Rows with no library row yet are not in play: ingest first.
 *
 * Models: the bulk tier through `claudeJson` (lib/llm.ts), so `LLM_BACKEND=claude-code`
 * bills the subscription. A usage limit, a halted CLI or a missing `claude` command
 * stops the run cleanly: the rest use the title rule, the plan is marked incomplete and
 * `--apply` refuses it. Exit code 2 means "incomplete plan", not a crash.
 *
 * The Drive's feed URL is a credential: it is never printed, and no feed XML or audio
 * URL is written to the plan.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  buildPlan,
  checkPlan,
  claudeGuestLlm,
  defaultGuestModel,
  fallbackGuests,
  parsePlan,
  resolveGuests,
  isUnreadRow,
  withOverrides,
  type GuestEpisode,
  type GuestPlan,
  type PlanRow,
  type SourceRow,
} from '../lib/guestNames'
import { withNetworkRetry } from '../lib/networkRetry'
import { selectAllPaged } from '../lib/pagination'
import { parseFeed, redact } from '../lib/podcastFeed'
import { isHostName, SHOWS, showByPrefix, type Show } from '../lib/shows'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

const out = (s: string) => process.stdout.write(s + '\n')

async function database() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  return db
}

/** `[guest, guest]`, or the whole list when the first author is not the host. */
function fmtAuthors(authors: readonly string[] | null, show: Show): string {
  if (!authors || authors.length === 0) return '(no authors)'
  if (isHostName(show, authors[0])) return authors.length === 1 ? '(host only)' : `[${authors.slice(1).join(' | ')}]`
  return `FIRST AUTHOR IS NOT THE HOST [${authors.join(' | ')}]`
}

async function readFeed(show: Show) {
  const url = process.env[show.env]
  if (!url) throw new Error(`${show.env} is not set (it belongs in .env.local)`)
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } }
    // A fetch error can echo the URL, and the Drive's carries a membership key.
    throw new Error(`feed fetch failed (${redact(String(err.cause?.code ?? err.message ?? 'network error')).replace(/https?:\/\/\S+/g, '<url>')})`)
  }
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`)
  const episodes = parseFeed(await res.text(), show.prefix)
  if (episodes.length === 0) throw new Error('feed parsed to 0 episodes: aborting rather than planning nothing')
  return episodes
}

type LibraryRow = SourceRow & { processing_status: string | null }

async function readRows(show: Show): Promise<Map<string, LibraryRow>> {
  const db = await database()
  const rows = await selectAllPaged<LibraryRow>((from, to) =>
    withNetworkRetry('read sources', () =>
      db.from('sources').select('id, external_id, authors, processing_status').like('external_id', `${show.prefix}-%`).order('id', { ascending: true }).range(from, to)
    )
  )
  const byKey = new Map<string, LibraryRow>()
  for (const r of rows) if (r.external_id) byKey.set(r.external_id, r)
  return byKey
}

function printChanged(plan: GuestPlan, show: Show) {
  const changed = plan.rows.filter(r => r.changed)
  out(`\nrows whose authors would change (${changed.length}):`)
  for (const r of changed) {
    out(`  ${r.key}  ${r.title.slice(0, 70)}`)
    out(`      now: ${fmtAuthors(r.current_authors, show)}`)
    out(`      new: ${fmtAuthors(r.proposed_authors, show)}   [${r.decided_by}: ${r.reason}]`)
  }
}

/** Episodes with no library row yet: where Claude's guests differ from what the title-rule ingest would write. */
function printUningested(plan: GuestPlan, show: Show) {
  const rows = plan.rows.filter(r => r.source_id === null)
  const differ = rows.filter(r => r.proposed_authors.slice(1).join('|') !== fallbackGuests(show, r.title).join('|'))
  if (rows.length === 0) return
  out(`
episodes with no library row yet: ${rows.length}; Claude's guests differ from the title rule's on ${differ.length}`)
  out('  (run this again after ingest: only rows that exist can be applied)')
  for (const r of differ) {
    out(`  ${r.key}  ${r.title.slice(0, 70)}`)
    out(`      title rule: ${JSON.stringify(fallbackGuests(show, r.title))}`)
    out(`      claude:     ${JSON.stringify(r.proposed_authors.slice(1))}   [${r.decided_by}]`)
  }
}

async function makePlan(show: Show) {
  const limit = Number(val('--limit')) || Infinity
  const model = await defaultGuestModel()
  out(`show: ${show.series} | host ${show.host} | model ${model} (bulk tier, ${process.env.LLM_BACKEND === 'claude-code' ? 'subscription' : 'API'} backend)`)

  let feed = (await readFeed(show)).slice(0, limit === Infinity ? undefined : limit)
  const rowsByKey = await readRows(show)
  const wantedKeys = val('--keys')?.split(',').map(k => k.trim()).filter(Boolean)
  if (wantedKeys) {
    const unknown = wantedKeys.filter(k => !feed.some(e => e.key === k))
    if (unknown.length > 0) throw new Error(`--keys not in the feed: ${unknown.join(', ')}`)
    feed = feed.filter(e => wantedKeys.includes(e.key))
  }
  if (has('--new')) {
    feed = feed.filter(e => {
      const row = rowsByKey.get(e.key)
      return !!row && isUnreadRow(show, row, e.title)
    })
    out(`--new: ${feed.length} row(s) nobody has read yet (in the library, not extracted, guests still as the title rule wrote them)`)
    if (feed.length === 0) { out('nothing to read.'); return }
  }
  const inLibrary = feed.filter(e => rowsByKey.has(e.key)).length
  out(`feed: ${feed.length} episodes | library rows for them: ${inLibrary} | not ingested yet: ${feed.length - inLibrary}`)

  const input: GuestEpisode[] = feed.map(e => ({ id: e.key, title: e.title, description: e.description }))
  const llm = claudeGuestLlm(model)
  const r = await resolveGuests(show, input, llm, {
    onBatch: (done, total) => process.stdout.write(`  asked Claude: batch ${done}/${total}\r`),
  })
  out('')
  if (r.stopped) out(`STOPPED EARLY (${r.stopped.kind}): ${r.stopped.message}\n  the episodes not yet asked use the title rule; this plan is INCOMPLETE and --apply will refuse it`)

  const plan = buildPlan({ show, episodes: input, decisions: r.decisions, rowsByKey, model, madeAt: new Date().toISOString(), stopped: r.stopped })
  const c = plan.counts
  out(`\nplan: ${c.episodes} episodes | decided by claude ${c.claude} | by fallback ${c.fallback} | by hand-set override ${c.override ?? 0} | no library row ${c.no_row} | authors would change on ${c.changed} row(s)`)
  out(`claude batches: ${r.batches.asked}/${r.batches.total} asked, ${r.batches.failed} failed`)

  const fb = plan.rows.filter(x => x.decided_by === 'fallback')
  if (fb.length > 0) {
    out(`\nfallback episodes (${fb.length}): the title rule decided, and why`)
    for (const x of fb) out(`  ${x.key}  ${x.title.slice(0, 70)}\n      ${x.reason}\n      guests now ${fmtAuthors(x.proposed_authors, show)}`)
  }
  printChanged(plan, show)
  printUningested(plan, show)

  const file = val('--out')
  if (file) {
    writeFileSync(resolve(file), JSON.stringify(plan, null, 1) + '\n')
    out(`\nplan written to ${resolve(file)}`)
  } else {
    out('\n(no --out: plan not saved)')
  }
  if (has('--apply-now')) {
    if (r.stopped) {
      out('not applying: the plan is incomplete (see above). Wait, then run this again.')
      process.exitCode = 2
      return
    }
    await applyPlanObject(plan)
    return
  }
  out('nothing was written to the database.')
  if (r.stopped) process.exitCode = 2
}

async function applyPlan(file: string) {
  await applyPlanObject(parsePlan(JSON.parse(readFileSync(resolve(file), 'utf8'))))
}

async function applyPlanObject(made: GuestPlan) {
  const show = showByPrefix(made.show)
  if (!show) throw new Error(`plan is for an unknown show "${made.show}" (registered: ${SHOWS.map(s => s.prefix).join(', ')})`)
  if (made.host !== show.host) throw new Error(`plan host "${made.host}" is not the registry's "${show.host}"`)
  // Hand-set guest lists win over whatever the plan proposed (an old plan, a model that varied).
  const { plan, replaced } = withOverrides(made, show)
  if (replaced.length > 0) {
    out(`hand-set override list (lib/guestOverrides.ts) replaces the plan on ${replaced.length} row(s):`)
    for (const r of replaced) out(`  ${r.key}  now ${fmtAuthors(r.current_authors, show)}  ->  ${fmtAuthors(r.proposed_authors, show)}${r.changed ? '' : '  (already so)'}`)
  }

  const wanted = plan.rows.filter(r => r.changed && r.source_id)
  const db = await database()
  const now = new Map<string, SourceRow>()
  const ids = wanted.map(r => r.source_id as string)
  for (let i = 0; i < ids.length; i += 100) {
    const res = await withNetworkRetry<{ data: SourceRow[] | null; error: { message: string } | null }>('re-read rows', () => db.from('sources').select('id, external_id, authors').in('id', ids.slice(i, i + 100)))
    if (res.error) throw new Error(`re-read failed: ${res.error.message}`)
    for (const r of (res.data ?? []) as SourceRow[]) now.set(r.id, r)
  }

  const check = checkPlan(plan, show, now)
  out(`plan: ${plan.show}, made ${plan.made_at}, ${wanted.length} row(s) to change`)
  if (check.refusal) throw new Error(`refusing to apply: ${check.refusal}`)
  if (check.stale.length > 0) {
    out(`\nREFUSING: ${check.stale.length} row(s) are not as they were when the plan was made. Nothing was written. Make a new plan.`)
    for (const s of check.stale.slice(0, 20)) out(`  ${s.row.key}: ${s.reason}`)
    if (check.stale.length > 20) out(`  … and ${check.stale.length - 20} more`)
    process.exitCode = 1
    return
  }
  out(`still as planned: ${check.toUpdate.length} | already applied: ${check.alreadyApplied.length}`)
  if (has('--dry-run')) {
    out('dry run: nothing written.')
    return
  }

  let written = 0
  const failed: PlanRow[] = []
  for (const row of check.toUpdate) {
    // ONLY `authors`, only this row. Setting a fixed value, so a retry is safe.
    const res = await withNetworkRetry('update authors', () =>
      db.from('sources').update({ authors: row.proposed_authors }).eq('id', row.source_id as string).eq('external_id', row.key)
    )
    if (res.error) {
      failed.push(row)
      out(`  ${row.key} FAILED: ${res.error.message}`)
    } else {
      written++
    }
  }
  out(`\nwrote authors on ${written} row(s)${failed.length ? `, ${failed.length} FAILED (re-run the same command: finished rows are skipped)` : ''}`)
  if (failed.length > 0) process.exitCode = 1
}

async function main() {
  const applyFile = val('--apply')
  if (applyFile) {
    await applyPlan(applyFile)
    return
  }
  const showArg = val('--show')
  const show = showByPrefix(showArg)
  if (!show) throw new Error(`--show <${SHOWS.map(s => s.prefix).join('|')}> is required${showArg ? ` (got "${showArg}")` : ''}`)
  await makePlan(show)
}

main().catch(e => {
  process.stderr.write(redact(e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
