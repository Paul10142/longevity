/**
 * Find the duplicate episodes already in the library and (only with --apply)
 * mark the extra copies as skipped.
 *
 *   npx tsx --env-file=.env.local scripts/dedupLibrary.ts                  # dry run (the default): read-only
 *   npx tsx --env-file=.env.local scripts/dedupLibrary.ts --json out.json  # also write the full plan, with whole ids
 *   npx tsx --env-file=.env.local scripts/dedupLibrary.ts --apply          # write (needs migration 038 and a free writer)
 *   npx tsx --env-file=.env.local scripts/dedupLibrary.ts --undo <backup.json> [--apply]   # put the rows back as they were
 *
 * A DUPLICATE is a second row for one recording: the same episode re-posted as a
 * rebroadcast or re-release, a 30-minute "Essentials" cut, or the same episode
 * under a second feed title. The rules are the feed ingest's own
 * (lib/episodeDuplicates.ts), so this cleanup and the ingest always agree.
 * Titles with DIFFERENT episode numbers are never duplicates.
 *
 * WHAT --apply WRITES. For each extra copy: processing_status = 'skipped',
 * duplicate_of = the copy we keep, skip_reason = why. Nothing else on a row, and
 * nothing in raw_insights, claims or claim_members. It is idempotent (a second run
 * finds nothing to do), it never touches a row that is being processed right now,
 * and it saves the previous values to a JSON backup first so --undo can reverse it.
 *
 * COPIES THAT ARE ALREADY EXTRACTED. Where two copies of one episode both have
 * facts, the extra copy is still marked skipped, but its facts stay in the claims
 * (raw_insights are immutable). Their claim_members sit beside the kept copy's,
 * so the episode counts twice until they are retired; the report lists each such
 * row and the command that would retire it. That retirement is a separate step.
 *
 * PASTED TEXT (Paul, 2026-11-08: "For Drive pasted text, we should process them with
 * Deepgram again"). A pasted-text copy loses to an audio copy of the same episode whatever
 * its facts. The cleanup never skips one: the report lists them under their own heading and
 * scripts/replacePastedText.ts retires them, only once the audio copy has succeeded.
 *
 * Refuses to --apply while a pipeline job is running or a supervisor process is
 * alive: one database writer at a time (the same guard as retireSourceClaims.ts).
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planCleanup, type Change, type CleanupRow } from '../lib/libraryDedup'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const argAfter = (flag: string) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : null }
const JSON_OUT = argAfter('--json')
const UNDO = argAfter('--undo')
const BACKUP_DIR = process.env.DEDUP_BACKUP_DIR || 'scratchpad/backups'
const now = () => new Date().toISOString().slice(11, 19)
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

type SourceRow = CleanupRow & { last_processed_at?: string | null; date?: string | null }

type Backup = {
  made_at: string
  rows: { id: string; processing_status: string | null; duplicate_of: string | null; skip_reason: string | null; to: { duplicate_of: string | null; skip_reason: string } }[]
}

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  const { selectAllPaged } = await import('../lib/pagination')

  if (UNDO) return undo(db)

  // ---- read everything (never select '*' on sources: the transcript columns time out) -------
  const base = 'id, title, external_id, authors, series, episode_number, media_duration_sec, transcript_origin, media_type, processing_status, created_at, last_processed_at'
  let columnsReady = true
  let sources: SourceRow[]
  try {
    sources = await selectAllPaged<SourceRow>((from, to) =>
      db.from('sources').select(`${base}, duplicate_of, skip_reason`).order('id').range(from, to)
    )
  } catch (e) {
    if (!/duplicate_of|skip_reason|column/i.test(String(e))) throw e
    columnsReady = false
    sources = await selectAllPaged<SourceRow>((from, to) => db.from('sources').select(base).order('id').range(from, to))
  }
  const counts = new Map<string, number>()
  const insights = await selectAllPaged<{ source_id: string }>((from, to) =>
    db.from('raw_insights').select('source_id').order('id').range(from, to)
  )
  for (const r of insights) counts.set(r.source_id, (counts.get(r.source_id) ?? 0) + 1)
  for (const s of sources) s.facts = counts.get(s.id) ?? 0

  const plan = planCleanup(sources)
  const byId = new Map(sources.map(s => [s.id, s]))
  const changeOf = new Map(plan.changes.map(c => [c.id, c]))
  const pastedOf = new Map(plan.pastedText.map(p => [p.id, p]))

  // ---- report -------------------------------------------------------------------------------
  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — ${sources.length} sources, ${insights.length} facts read`)
  if (!columnsReady) console.log('NOTE: migration 038 is not applied yet (no duplicate_of / skip_reason columns). The dry run is complete; --apply will refuse.')
  console.log(`\n══ DUPLICATE GROUPS (${plan.groups.length}) ══`)
  plan.groups.forEach((g, i) => {
    const via = [...new Set(g.links.map(l => l.kind))].join(', ')
    console.log(`\nGroup ${i + 1} — ${g.series} — ${g.rows.length} copies — matched by ${via}${g.suspicious ? ` — NOT APPLIED: ${g.suspicious}` : ''}`)
    for (const r of g.rows) {
      const c = changeOf.get(r.id)
      const verdict = g.suspicious ? 'review ' : c ? (c.alreadyApplied ? 'skipped' : 'SKIP   ') : pastedOf.has(r.id) ? 'REPLACE' : 'KEEP   '
      console.log(
        `  ${verdict} ${short(r.id)}  ${(r.processing_status ?? '').padEnd(9)} ${(r.media_type ?? '').padEnd(5)} ${(r.transcript_origin ?? '').padEnd(9)} facts ${String(r.facts ?? 0).padStart(4)}  ${(r.created_at ?? '').slice(0, 10)}  ${clip(r.title, 80)}`
      )
      if (c && !g.suspicious) console.log(`             ↳ ${c.skip_reason}`)
      const pt = pastedOf.get(r.id)
      if (pt && !g.suspicious) console.log(`             ↳ pasted text; the audio copy ${short(pt.audioId)} replaces it (${pt.state}${pt.why ? `: ${pt.why}` : ''}) — NOT written by this script`)
    }
  })

  console.log(`\n══ PASTED TEXT BEATEN BY AN AUDIO COPY (${plan.pastedText.length}) — never skipped by this script ══`)
  if (plan.pastedText.length === 0) console.log('  none: no pasted-text row has an audio copy of the same episode in the library yet.')
  for (const pt of plan.pastedText) {
    console.log(`  ${pt.state.toUpperCase().padEnd(8)} ${short(pt.id)}  ${(pt.processing_status ?? '').padEnd(9)} facts ${String(pt.facts).padStart(4)}  ${clip(pt.title, 70)}`)
    console.log(`             audio copy ${short(pt.audioId)}  ${(pt.audioStatus ?? '').padEnd(9)} ${(pt.audioOrigin ?? '').padEnd(9)} facts ${String(pt.audioFacts).padStart(4)}${pt.why ? `  → ${pt.why}` : ''}`)
  }
  if (plan.pastedText.length) console.log('  Retire a ready one with scripts/replacePastedText.ts (dry run first). Until then the text copy stays live; its facts are never touched.')

  const alone = plan.changes.filter(c => c.group == null)
  console.log(`\n══ SKIPPED ON THEIR OWN TITLE, NO COPY IN THE LIBRARY (${alone.length}) — re-posts, cuts and Q&A items (full episodes only) ══`)
  const byKind = new Map<string, Change[]>()
  for (const c of alone) {
    const k = /^re-cut \(Essentials\)/.test(c.skip_reason) ? 'Essentials cut' : /^AMA:/.test(c.skip_reason) ? 'Huberman AMA' : /^live Q&A:/.test(c.skip_reason) ? 'Huberman live Q&A' : /^trailer:/.test(c.skip_reason) ? 'Huberman trailer' : c.skip_reason.split(':')[0]
    byKind.set(k, [...(byKind.get(k) ?? []), c])
  }
  for (const [k, list] of byKind) {
    console.log(`\n  ${k}: ${list.length}`)
    for (const c of list.slice(0, 5)) console.log(`    ${short(c.id)}  ${(c.processing_status ?? '').padEnd(9)} facts ${String(c.facts).padStart(4)}  ${clip(c.title, 90)}`)
    if (list.length > 5) console.log(`    … and ${list.length - 5} more (all in the --json file)`)
  }

  // One line per RULE, across groups and stand-alone rows, so a person can accept or reject a rule, not a row.
  const ruleOf = (reason: string): string => {
    if (/^re-cut \(Essentials\)/.test(reason)) return 'Title starts "Essentials:" (Huberman 30-minute re-cut)'
    if (/^AMA:/.test(reason)) return 'Huberman title starts "AMA #N:" (not a full episode)'
    if (/^live Q&A:/.test(reason)) return 'Huberman title has "Q&A" / "LIVE EVENT" (not a full episode)'
    if (/^trailer:/.test(reason)) return 'Huberman welcome trailer (not a full episode)'
    if (/^(rebroadcast|re-release)/.test(reason)) return 'Title says rebroadcast / re-release'
    if (/same episode number/.test(reason)) return 'Same episode number as a held episode'
    if (/same AMA/.test(reason)) return 'Same AMA number as a held episode'
    if (/same title/.test(reason)) return 'Same title once numbers and markers are ignored'
    if (/same guest/.test(reason)) return 'Same guests, length within 2%, shared topic'
    return 'Linked through another copy of the same episode'
  }
  const byRule = new Map<string, Change[]>()
  for (const c of plan.changes) byRule.set(ruleOf(c.skip_reason), [...(byRule.get(ruleOf(c.skip_reason)) ?? []), c])
  console.log(`\n══ WHAT EACH RULE CATCHES (${plan.changes.length} rows) — accept or reject a rule, not a row ══`)
  for (const [rule, list] of [...byRule].sort((x, y) => y[1].length - x[1].length)) {
    const withCopy = list.filter(c => c.duplicate_of).length
    console.log(`\n  ${rule}: ${list.length}  (${withCopy} point at a kept copy, ${list.length - withCopy} stand alone, ${list.filter(c => c.facts > 0).length} already extracted)`)
    for (const c of list.slice(0, 3)) console.log(`    ${short(c.id)}  ${clip(c.title, 90)}`)
  }

  console.log(`\n══ LOOK ALIKE BUT NOT DECIDED (${plan.similar.length}) — left alone; a person decides ══`)
  for (const { a, b } of plan.similar) {
    console.log(`  ${short(a.id)}  ${(a.media_duration_sec ?? 0)}s  ${clip(a.title, 70)}\n  ${short(b.id)}  ${(b.media_duration_sec ?? 0)}s  ${clip(b.title, 70)}\n`)
  }

  const todo = plan.changes.filter(c => !c.alreadyApplied)
  const withFacts = plan.changes.filter(c => c.facts > 0)
  const inGroups = plan.groups.reduce((n, g) => n + g.rows.length, 0)
  const applicable = todo.filter(c => {
    const g = c.group == null ? null : plan.groups[c.group - 1]
    return !g?.suspicious
  })
  console.log('\n══ WHAT --apply WOULD DO ══')
  console.log(`  duplicate groups:                    ${plan.groups.length} (${inGroups} rows in them)`)
  console.log(`  rows to mark skipped:                ${applicable.length} (${plan.changes.length - todo.length} already marked)`)
  console.log(`    of which copies of a held episode: ${applicable.filter(c => c.duplicate_of).length}`)
  console.log(`    of which skipped on their own title: ${applicable.filter(c => !c.duplicate_of).length}`)
  console.log(`  rows that are being processed now:   ${applicable.filter(c => c.processing_status === 'processing').length} (left alone)`)
  console.log(`  groups held back for a person:       ${plan.groups.filter(g => g.suspicious).length}`)

  if (withFacts.length) {
    console.log(`\n══ SKIPPED COPIES THAT ALREADY HAVE FACTS (${withFacts.length}) — facts stay until a person approves retiring them ══`)
    for (const c of withFacts) {
      const keeper = c.duplicate_of ? byId.get(c.duplicate_of) : null
      console.log(`  ${short(c.id)}  facts ${String(c.facts).padStart(4)}  ${clip(c.title, 70)}\n             ${c.skip_reason}${keeper ? `  (kept copy ${short(keeper.id)} has ${keeper.facts ?? 0} facts)` : ''}`)
    }
    console.log('\n  To retire one copy\'s facts safely (claims keep the other copy\'s members), use scripts/retireSourceClaims.ts --source <id>.')
    console.log('  Today it deletes or resets the row; keeping it marked skipped needs a small follow-up change.')
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({
      generated_at: new Date().toISOString(),
      counts: { sources: sources.length, groups: plan.groups.length, rows_in_groups: inGroups, changes: plan.changes.length, to_apply: applicable.length, with_facts: withFacts.length, similar: plan.similar.length },
      groups: plan.groups.map((g, i) => ({
        group: i + 1, series: g.series, suspicious: g.suspicious, keeper: g.keeper.id,
        rows: g.rows.map(r => ({ id: r.id, title: r.title, created_at: r.created_at, processing_status: r.processing_status, transcript_origin: r.transcript_origin, facts: r.facts ?? 0, keep: r.id === g.keeper.id && !changeOf.has(r.id), skip_reason: changeOf.get(r.id)?.skip_reason ?? null })),
      })),
      changes: plan.changes,
      pasted_text: plan.pastedText,
      similar: plan.similar.map(s => ({ a: { id: s.a.id, title: s.a.title }, b: { id: s.b.id, title: s.b.title } })),
    }, null, 2))
    console.log(`\nFull plan written to ${JSON_OUT}`)
  }

  if (!APPLY) { console.log(`\n[${now()}] DRY RUN — nothing written. Run again with --apply to write.`); return }

  // ---- apply --------------------------------------------------------------------------------
  if (!columnsReady) throw new Error('refusing to apply: migration 038 (supabase/migrations_v2/038_skipped_duplicate_sources.sql) is not applied')
  await assertWriterFree(db)
  const live = applicable.filter(c => c.processing_status !== 'processing')
  if (live.length === 0) { console.log(`\n[${now()}] nothing to write`); return }

  mkdirSync(BACKUP_DIR, { recursive: true })
  const backupPath = join(BACKUP_DIR, `dedup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const backup: Backup = {
    made_at: new Date().toISOString(),
    rows: live.map(c => {
      const r = byId.get(c.id)!
      return { id: c.id, processing_status: r.processing_status ?? null, duplicate_of: r.duplicate_of ?? null, skip_reason: r.skip_reason ?? null, to: { duplicate_of: c.duplicate_of, skip_reason: c.skip_reason } }
    }),
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 2))
  console.log(`\nBackup of ${live.length} rows' previous values: ${backupPath}`)

  let written = 0
  let moved = 0
  // Originals first: a row's duplicate_of must point at a row that exists (it already does; this just keeps log order stable).
  for (const c of live) {
    const { data, error } = await db
      .from('sources')
      .update({ processing_status: 'skipped', duplicate_of: c.duplicate_of, skip_reason: c.skip_reason })
      .eq('id', c.id)
      .neq('processing_status', 'processing') // never pull a row out from under a running job
      .select('id')
    if (error) throw new Error(`update ${c.id} failed: ${error.message}`)
    if ((data ?? []).length === 0) moved++
    else written++
  }
  console.log(`\n[${now()}] DONE — ${written} rows marked skipped${moved ? `, ${moved} left alone (started processing meanwhile)` : ''}. Claims and facts untouched.`)
  console.log(`To reverse: npx tsx --env-file=.env.local scripts/dedupLibrary.ts --undo ${backupPath} --apply`)
}

async function assertWriterFree(db: NonNullable<Awaited<typeof import('../lib/supabaseServer')>['supabaseAdmin']>) {
  const { data: running } = await db
    .from('jobs')
    .select('id, type')
    .eq('status', 'running')
    .gt('locked_at', new Date(Date.now() - 10 * 60_000).toISOString())
  const runningJobs = (running ?? []) as { id: string; type: string }[]
  if (runningJobs.length > 0) {
    throw new Error(`refusing to apply: ${runningJobs.length} pipeline job(s) running (${runningJobs.map(r => r.type).join(', ')})`)
  }
  const procs = execSync('ps -eo command', { encoding: 'utf8' })
    .split('\n')
    .filter(l => /extractDeepgram|overnightExtract|scripts\/pipeline\.ts|sweepCorpus|extract_with_fidelity/.test(l) && !/grep/.test(l))
  if (procs.length > 0) throw new Error(`refusing to apply: a supervisor is running:\n${procs.join('\n')}`)
  const { acquireWriterLock } = await import('../lib/writerLock')
  acquireWriterLock('dedupLibrary')
}

/** Put rows back exactly as a backup recorded them, but only rows still carrying the skip this script wrote. */
async function undo(db: NonNullable<Awaited<typeof import('../lib/supabaseServer')>['supabaseAdmin']>) {
  if (!UNDO || !existsSync(UNDO)) throw new Error(`--undo needs the path of a dedup-*.json backup (got ${UNDO ?? 'nothing'})`)
  const backup = JSON.parse(readFileSync(UNDO, 'utf8')) as Backup
  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — undo ${UNDO}: ${backup.rows.length} rows (made ${backup.made_at})`)
  if (APPLY) await assertWriterFree(db)
  let restored = 0
  let left = 0
  for (const r of backup.rows) {
    const { data } = await db.from('sources').select('id, processing_status, duplicate_of, skip_reason').eq('id', r.id).maybeSingle()
    const cur = data as { processing_status: string; duplicate_of: string | null; skip_reason: string | null } | null
    const same = cur && cur.processing_status === 'skipped' && cur.skip_reason === r.to.skip_reason && (cur.duplicate_of ?? null) === r.to.duplicate_of
    if (!same) { left++; console.log(`  leave  ${short(r.id)} — it no longer carries the skip this backup wrote`); continue }
    console.log(`  ${APPLY ? 'restore' : 'would restore'} ${short(r.id)} → ${r.processing_status}`)
    if (APPLY) {
      const { error } = await db.from('sources').update({ processing_status: r.processing_status, duplicate_of: r.duplicate_of, skip_reason: r.skip_reason }).eq('id', r.id)
      if (error) throw new Error(`restore ${r.id} failed: ${error.message}`)
    }
    restored++
  }
  console.log(`\n[${now()}] ${APPLY ? 'DONE' : 'DRY RUN — nothing written'} — ${restored} rows ${APPLY ? 'restored' : 'would be restored'}, ${left} left alone`)
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
