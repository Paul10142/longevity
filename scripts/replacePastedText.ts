/**
 * Retire a pasted-text copy of an episode once a Deepgram copy of the same episode has
 * succeeded (Paul, 2026-11-08: "For Drive pasted text, we should process them with Deepgram
 * again"). Step 3 of the flow in lib/pastedTextReplacement.ts.
 *
 *   npx tsx --env-file=.env.local scripts/replacePastedText.ts                    # dry run (default): every pasted-text row
 *   npx tsx --env-file=.env.local scripts/replacePastedText.ts --pair <text id>:<audio id> [--pair …]
 *   npx tsx --env-file=.env.local scripts/replacePastedText.ts --text <text id> [--text …] # audio copy found by the duplicate rules
 *   npx tsx --env-file=.env.local scripts/replacePastedText.ts --pair … --apply            # write (needs migration 038 and a free writer)
 *   npx tsx --env-file=.env.local scripts/replacePastedText.ts --undo <backup.json> [--apply]
 *
 * Ids are WHOLE source ids (36 characters), never a prefix. `--apply` only ever acts on the
 * rows named with --text / --pair; with neither it is refused. There is no "do them all".
 *
 * WHAT --apply WRITES, on the text row only: processing_status = 'skipped', duplicate_of = the
 * audio row, skip_reason = 'pasted text replaced by Deepgram transcript (Paul, 2026-11-08)'.
 * Nothing in raw_insights, claims or claim_members, and no other column. The facts the text copy
 * holds, and the claims they sit in, are NEVER touched here: they stay until Paul decides on the
 * separate step (scripts/retireDuplicateMemberships.ts --skipped <text id> --kept <audio id>),
 * so until then the episode's facts are in the library TWICE. Every report says so.
 *
 * REFUSES unless the audio row has SUCCEEDED (processing_status 'succeeded', Deepgram
 * transcript, not itself skipped, with facts). A pending audio row leaves the text copy live: the
 * episode must never be left with neither copy. IDEMPOTENT (a text row that already carries this
 * replacement is left alone). Saves the previous values to a JSON backup first; --undo puts a row
 * back exactly as the backup recorded, but only a row still carrying the skip this script wrote.
 *
 * One database writer at a time: --apply refuses while a pipeline job is running or a supervisor
 * is alive (the same guard as dedupLibrary.ts).
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPastedText } from '../lib/episodeDuplicates'
import {
  PASTED_TEXT_SKIP_REASON,
  isFullId,
  planPastedTextReplacements,
  replacementPatch,
  type ReplacementItem,
  type SourceLike,
} from '../lib/pastedTextReplacement'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const allAfter = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []))
const UNDO = allAfter('--undo')[0] ?? null
const BACKUP_DIR = process.env.DEDUP_BACKUP_DIR || 'scratchpad/backups'
const now = () => new Date().toISOString().slice(11, 19)
const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

type Db = NonNullable<Awaited<typeof import('../lib/supabaseServer')>['supabaseAdmin']>

type Backup = {
  made_at: string
  rows: {
    id: string
    processing_status: string | null
    duplicate_of: string | null
    skip_reason: string | null
    to: { duplicate_of: string; skip_reason: string }
  }[]
}

async function main() {
  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')
  if (UNDO) return undo(db)

  // ---- which rows are asked about -------------------------------------------------------------
  const problems: string[] = []
  const pairs: { textId: string; audioId: string | null }[] = []
  for (const spec of allAfter('--pair')) {
    const [t, a, ...rest] = spec.split(':')
    if (rest.length || !isFullId(t) || !isFullId(a)) { problems.push(`--pair needs <whole text id>:<whole audio id>, got "${spec}"`); continue }
    pairs.push({ textId: t, audioId: a })
  }
  for (const t of allAfter('--text')) {
    if (!isFullId(t)) { problems.push(`--text needs a whole source id (36 characters), got "${t}"`); continue }
    if (pairs.some(p => p.textId === t)) { problems.push(`${t} is named twice`); continue }
    pairs.push({ textId: t, audioId: null })
  }
  if (new Set(pairs.map(p => p.textId)).size !== pairs.length) problems.push('a text row is named in more than one --pair/--text')
  if (problems.length) throw new Error(`nothing was read or written:\n  ${problems.join('\n  ')}`)
  if (APPLY && pairs.length === 0) {
    throw new Error('--apply needs the rows to act on: name each with --pair <text id>:<audio id> or --text <text id> (no blanket apply)')
  }

  // ---- read (never select '*' on sources: the transcript columns time out) --------------------
  const { selectAllPaged } = await import('../lib/pagination')
  const base = 'id, title, external_id, authors, series, media_duration_sec, media_type, transcript_origin, processing_status, created_at'
  let columnsReady = true
  let sources: SourceLike[]
  try {
    sources = await selectAllPaged<SourceLike>((from, to) => db.from('sources').select(`${base}, duplicate_of, skip_reason`).order('id').range(from, to))
  } catch (e) {
    if (!/duplicate_of|skip_reason|column/i.test(String(e))) throw e
    columnsReady = false
    sources = await selectAllPaged<SourceLike>((from, to) => db.from('sources').select(base).order('id').range(from, to))
  }
  const known = new Set(sources.map(s => s.id))
  for (const p of pairs) {
    if (!known.has(p.textId)) problems.push(`no source ${p.textId}`)
    if (p.audioId && !known.has(p.audioId)) problems.push(`no source ${p.audioId}`)
  }
  if (problems.length) throw new Error(`nothing was written:\n  ${problems.join('\n  ')}`)

  const counts = new Map<string, number>()
  const insights = await selectAllPaged<{ id: string; source_id: string }>((from, to) =>
    db.from('raw_insights').select('id, source_id').order('id').range(from, to)
  )
  const insightsBySource = new Map<string, string[]>()
  for (const r of insights) {
    counts.set(r.source_id, (counts.get(r.source_id) ?? 0) + 1)
    insightsBySource.set(r.source_id, [...(insightsBySource.get(r.source_id) ?? []), r.id])
  }
  for (const s of sources) s.facts = counts.get(s.id) ?? 0

  const items = planPastedTextReplacements(sources, pairs.length ? { pairs } : {})

  // Claims each text row's facts sit in (and how many the audio copy's facts share).
  const claimsOf = async (sourceId: string): Promise<Set<string>> => {
    const ids = insightsBySource.get(sourceId) ?? []
    const out = new Set<string>()
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('claim_members').select('claim_id').in('raw_insight_id', ids.slice(i, i + 200))
      if (error) throw new Error(`claim lookup failed: ${error.message}`)
      for (const m of (data ?? []) as { claim_id: string }[]) out.add(m.claim_id)
    }
    return out
  }
  const detail = new Map<string, { claims: number; sharedWithAudio: number | null }>()
  for (const it of items) {
    const mine = await claimsOf(it.text.id)
    let shared: number | null = null
    if (it.audio && (it.audio.facts ?? 0) > 0) {
      const theirs = await claimsOf(it.audio.id)
      shared = [...mine].filter(c => theirs.has(c)).length
    }
    detail.set(it.text.id, { claims: mine.size, sharedWithAudio: shared })
  }

  report(items, detail, columnsReady)
  if (!APPLY) { console.log(`\n[${now()}] DRY RUN — nothing written. Name the rows with --pair/--text and add --apply to write.`); return }

  // ---- apply ----------------------------------------------------------------------------------
  if (!columnsReady) throw new Error('refusing to apply: migration 038 (supabase/migrations_v2/038_skipped_duplicate_sources.sql) is not applied')
  const refused = items.filter(it => it.state.state === 'waiting' || it.state.state === 'blocked')
  if (refused.length > 0) {
    throw new Error(
      `refusing to apply, nothing written (the text copy stays live until its audio copy has succeeded):\n` +
        refused.map(it => `  ${short(it.text.id)}  ${it.state.state === 'waiting' || it.state.state === 'blocked' ? it.state.why : ''}`).join('\n')
    )
  }
  const todo = items.filter(it => it.state.state === 'ready')
  if (todo.length === 0) { console.log(`\n[${now()}] nothing to write: every named text row already carries the replacement`); return }
  await assertWriterFree(db)

  mkdirSync(BACKUP_DIR, { recursive: true })
  const backupPath = join(BACKUP_DIR, `replace-pasted-text-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const backup: Backup = {
    made_at: new Date().toISOString(),
    rows: todo.map(it => ({
      id: it.text.id,
      processing_status: it.text.processing_status ?? null,
      duplicate_of: it.text.duplicate_of ?? null,
      skip_reason: it.text.skip_reason ?? null,
      to: { duplicate_of: it.audio!.id, skip_reason: PASTED_TEXT_SKIP_REASON },
    })),
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 2))
  console.log(`\nBackup of ${todo.length} row(s)' previous values: ${backupPath}`)

  let written = 0
  let left = 0
  for (const it of todo) {
    const { data, error } = await db
      .from('sources')
      .update(replacementPatch(it.audio!.id))
      .eq('id', it.text.id)
      .eq('media_type', 'text')
      .in('processing_status', ['succeeded', 'pending', 'failed']) // never a row that is processing right now, never one already skipped
      .select('id')
    if (error) throw new Error(`update ${it.text.id} failed: ${error.message}`)
    if ((data ?? []).length === 0) { left++; console.log(`  left alone ${short(it.text.id)}: it changed since it was read`) }
    else { written++; console.log(`  skipped ${short(it.text.id)} → duplicate_of ${short(it.audio!.id)}`) }
  }
  console.log(`\n[${now()}] DONE — ${written} text row(s) marked skipped${left ? `, ${left} left alone` : ''}. Facts, claims and raw insights untouched.`)
  console.log('The facts of each text copy are still in the library next to the audio copy\'s (the episode counts twice) until the retire step is chosen.')
  console.log(`To reverse: npx tsx --env-file=.env.local scripts/replacePastedText.ts --undo ${backupPath} --apply`)
}

function report(
  items: ReplacementItem[],
  detail: Map<string, { claims: number; sharedWithAudio: number | null }>,
  columnsReady: boolean,
) {
  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — ${items.length} pasted-text row(s) looked at`)
  if (!columnsReady) console.log('NOTE: migration 038 is not applied yet (no duplicate_of / skip_reason columns). The dry run is complete; --apply will refuse.')
  console.log('\n══ PASTED-TEXT COPIES AND THEIR DEEPGRAM REPLACEMENTS ══')
  for (const it of items) {
    const d = detail.get(it.text.id)!
    console.log(`\n  text  ${it.text.id}  ${(it.text.processing_status ?? '').padEnd(9)} ${clip(it.text.title ?? '', 80)}`)
    console.log(`        key ${it.text.external_id ?? '(none)'}  |  holds ${it.text.facts ?? 0} facts, which sit in ${d.claims} claims`)
    if (it.audio) {
      console.log(`  audio ${it.audio.id}  ${(it.audio.processing_status ?? '').padEnd(9)} ${(it.audio.transcript_origin ?? '').padEnd(9)} ${it.audio.facts ?? 0} facts  key ${it.audio.external_id ?? '(none)'}  (${it.how === 'explicit' ? 'named with --pair' : `found by the duplicate rules: ${it.matchDetail}`})`)
      if (d.sharedWithAudio != null) console.log(`        ${d.sharedWithAudio} of the text copy's ${d.claims} claims are also fed by the audio copy`)
    } else {
      console.log('  audio none found')
    }
    const st = it.state
    if (st.state === 'ready') {
      console.log(`  → READY: --apply would mark the text row skipped, duplicate_of ${short(it.audio!.id)}, reason "${PASTED_TEXT_SKIP_REASON}"`)
      console.log(`    its ${it.text.facts ?? 0} facts / ${d.claims} claims are NOT touched: the episode's facts are in the library twice until the retire step is chosen`)
      console.log(`    (retire step, parked: scripts/retireDuplicateMemberships.ts --skipped ${it.text.id} --kept ${it.audio!.id})`)
    } else if (st.state === 'waiting') {
      console.log(`  → WAITING: ${st.why}. Nothing would be written; the text copy stays live.`)
    } else if (st.state === 'applied') {
      console.log('  → ALREADY APPLIED: the text row carries this replacement; nothing to do.')
      console.log(`    its ${it.text.facts ?? 0} facts / ${d.claims} claims are still in the library next to the audio copy's.`)
    } else {
      console.log(`  → BLOCKED: ${st.why}`)
    }
  }
  const t = (s: ReplacementItem['state']['state']) => items.filter(i => i.state.state === s).length
  console.log(`\n══ SUMMARY ══\n  ready ${t('ready')}  |  waiting ${t('waiting')}  |  already applied ${t('applied')}  |  blocked ${t('blocked')}`)
  console.log(`  facts held by the text copies: ${items.reduce((n, i) => n + (i.text.facts ?? 0), 0)} (none of them touched by this script)`)
}

async function assertWriterFree(db: Db) {
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
  acquireWriterLock('replacePastedText')
}

/** Put rows back exactly as a backup recorded them, but only rows still carrying the skip this script wrote. */
async function undo(db: Db) {
  if (!UNDO || !existsSync(UNDO)) throw new Error(`--undo needs the path of a replace-pasted-text-*.json backup (got ${UNDO ?? 'nothing'})`)
  const backup = JSON.parse(readFileSync(UNDO, 'utf8')) as Backup
  console.log(`[${now()}] ${APPLY ? 'APPLY' : 'DRY RUN'} — undo ${UNDO}: ${backup.rows.length} row(s) (made ${backup.made_at})`)
  if (APPLY) await assertWriterFree(db)
  let restored = 0
  let left = 0
  for (const r of backup.rows) {
    const { data } = await db.from('sources').select('id, media_type, processing_status, duplicate_of, skip_reason').eq('id', r.id).maybeSingle()
    const cur = data as { media_type: string | null; processing_status: string; duplicate_of: string | null; skip_reason: string | null } | null
    const same = cur && isPastedText(cur) && cur.processing_status === 'skipped' && cur.skip_reason === r.to.skip_reason && (cur.duplicate_of ?? null) === r.to.duplicate_of
    if (!same) { left++; console.log(`  leave  ${short(r.id)} — it no longer carries the skip this backup wrote`); continue }
    console.log(`  ${APPLY ? 'restore' : 'would restore'} ${short(r.id)} → ${r.processing_status}`)
    if (APPLY) {
      const { error } = await db.from('sources').update({ processing_status: r.processing_status, duplicate_of: r.duplicate_of, skip_reason: r.skip_reason }).eq('id', r.id)
      if (error) throw new Error(`restore ${r.id} failed: ${error.message}`)
    }
    restored++
  }
  console.log(`\n[${now()}] ${APPLY ? 'DONE' : 'DRY RUN — nothing written'} — ${restored} row(s) ${APPLY ? 'restored' : 'would be restored'}, ${left} left alone`)
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
