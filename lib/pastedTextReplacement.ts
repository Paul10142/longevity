/**
 * Replacing a pasted-text copy of an episode with a Deepgram transcript of its audio
 * (Paul, 2026-11-08: "For Drive pasted text, we should process them with Deepgram
 * again"). Pure rules, no I/O: scripts/ingestFeedSources.ts (`--replace`) and
 * scripts/replacePastedText.ts read the database and apply what this decides;
 * tests/pastedTextReplacement.test.ts covers it.
 *
 * THE FLOW, in order, each step a separate run:
 *
 *   1. INGEST. A pasted-text row holds the episode's feed key (`attia-0368`) and the key is
 *      UNIQUE, so a plain ingest only ever "refreshes" that row and never creates an audio
 *      row. `ingestFeedSources.ts --replace <full text row id>` frees the key (the text row
 *      is renamed `text-attia-0368`) and creates the audio row under the real key. Without
 *      `--replace` nothing changes: this is a named exception for exact ids, never a switch.
 *   2. TRANSCRIBE + EXTRACT, the normal pipeline. Until the audio row has SUCCEEDED, the text
 *      row stays exactly as it was (live, succeeded, its facts in the claims).
 *   3. RETIRE THE TEXT COPY, `scripts/replacePastedText.ts --apply`, refused until step 2 is
 *      done: the text row becomes `skipped`, `duplicate_of` = the audio row, `skip_reason` =
 *      PASTED_TEXT_SKIP_REASON. Nothing else about it changes.
 *
 * FACTS ARE NEVER TOUCHED. The text copy's raw_insights stay (they are immutable, and 10 of
 * the 40 fidelity gold-set pairs point at them) and so do its claim memberships. Until
 * Paul picks the separate "retire only the duplicate citations" step
 * (scripts/retireDuplicateMemberships.ts), the episode's facts are in the library TWICE,
 * once from the text copy and once from the Deepgram copy. Every report says so.
 *
 * THE TRAP THIS AVOIDS. Between step 1 and step 2 the audio row is `pending` with 0 facts
 * and the text row is `succeeded` with hundreds. The duplicate rules rank an extracted copy
 * above an unextracted one, which would skip the new audio row. Two guards:
 * `preference()` in lib/episodeDuplicates.ts ranks a pasted-text copy last, whatever its
 * facts, and `replacementState` here refuses to retire the text copy until the audio copy
 * has succeeded, so there is never a moment when neither copy is live.
 */

import { findOriginal, isPastedText, type LibraryRow } from './episodeDuplicates'

/** The `skip_reason` every replaced text row carries. */
export const PASTED_TEXT_SKIP_REASON = 'pasted text replaced by Deepgram transcript (Paul, 2026-11-08)'

/** What a replaced text row's feed key is renamed to, so the audio row can take the real key. */
export const TEXT_KEY_PREFIX = 'text-'
export const textKeyFor = (key: string): string => `${TEXT_KEY_PREFIX}${key}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isFullId = (s: string | null | undefined): boolean => !!s && UUID.test(s)

/** The columns of a `sources` row these rules read. */
export type ReplacementRow = {
  id: string
  title: string | null
  external_id?: string | null
  media_type?: string | null
  transcript_origin?: string | null
  processing_status?: string | null
  duplicate_of?: string | null
  skip_reason?: string | null
  /** raw_insights this source holds. */
  facts?: number
}

// ── Step 1: which text rows an ingest may replace ─────────────────────────────

export type ReplaceTarget = { id: string; key: string; title: string }

/**
 * Check the ids given to `ingestFeedSources.ts --replace` BEFORE anything is written.
 * Every id must be a whole UUID (never a prefix), name a pasted-text row that is still live,
 * and that row's key must be a key the feed carries, otherwise there is nothing to ingest.
 * Returns the targets, or every problem found (never a partial answer).
 */
export function resolveReplaceTargets(input: {
  ids: readonly string[]
  rows: readonly ReplacementRow[]
  /** Feed keys of the episodes in this run's feed slice. */
  feedKeys: ReadonlySet<string>
  /** True for a key of this show (`attia-0368`, `attia-g0ab081`). */
  isShowKey: (key: string | null | undefined) => boolean
}): { targets: ReplaceTarget[]; errors: string[] } {
  const errors: string[] = []
  const targets: ReplaceTarget[] = []
  const byId = new Map(input.rows.map(r => [r.id, r]))
  const heldKeys = new Set(input.rows.map(r => r.external_id).filter((k): k is string => !!k))
  const seen = new Set<string>()
  for (const id of input.ids) {
    if (!isFullId(id)) { errors.push(`--replace needs a whole source id (36 characters), got "${id}"`); continue }
    if (seen.has(id)) { errors.push(`--replace ${id} is given twice`); continue }
    seen.add(id)
    const row = byId.get(id)
    if (!row) { errors.push(`--replace ${id}: no such source`); continue }
    if (!isPastedText(row)) { errors.push(`--replace ${id}: not a pasted-text row (media_type ${row.media_type ?? 'null'}); only pasted text is replaced`); continue }
    if (row.processing_status === 'skipped' || row.duplicate_of) { errors.push(`--replace ${id}: already skipped as a duplicate; nothing to replace`); continue }
    if (!row.external_id || !input.isShowKey(row.external_id)) {
      errors.push(`--replace ${id}: it holds no feed key of this show (external_id ${row.external_id ?? 'null'}), so no feed episode maps to it; link it with --pair in scripts/replacePastedText.ts instead`)
      continue
    }
    if (!input.feedKeys.has(row.external_id)) { errors.push(`--replace ${id}: the feed has no episode ${row.external_id} in this run (check --limit/--skip)`); continue }
    if (heldKeys.has(textKeyFor(row.external_id))) { errors.push(`--replace ${id}: a row already holds ${textKeyFor(row.external_id)}`); continue }
    targets.push({ id, key: row.external_id, title: row.title ?? '' })
  }
  return { targets, errors }
}

// ── Step 3: whether a text copy may be retired ────────────────────────────────

/** Why the audio copy is or is not ready to replace the text copy. */
export type ReplacementState =
  | { state: 'ready'; audio: ReplacementRow }
  /** There is no audio copy yet, or it has not finished: nothing is written, the text copy stays live. */
  | { state: 'waiting'; why: string }
  /** The text copy already carries this replacement: applying again is a no-op. */
  | { state: 'applied' }
  /** Something is wrong that waiting will not fix: the run refuses and says why. */
  | { state: 'blocked'; why: string }

/**
 * Whether `text` may be set aside in favour of `audio`. The audio copy must have SUCCEEDED
 * through extraction, be a Deepgram transcript of the audio (not another pasted copy and not
 * a caption import) and be live itself, with facts: a text copy is never retired for a copy
 * that has not produced anything.
 */
export function replacementState(text: ReplacementRow, audio: ReplacementRow | null): ReplacementState {
  if (!isPastedText(text)) return { state: 'blocked', why: `${text.id} is not a pasted-text row (media_type ${text.media_type ?? 'null'})` }
  if (!audio) return { state: 'waiting', why: 'no audio copy of this episode exists yet (ingest it with --replace first)' }
  if (audio.id === text.id) return { state: 'blocked', why: 'the text copy and the audio copy are the same source' }
  if (text.processing_status === 'skipped') {
    if (text.duplicate_of === audio.id && text.skip_reason === PASTED_TEXT_SKIP_REASON) return { state: 'applied' }
    return { state: 'blocked', why: `the text copy is already skipped for another reason (${text.skip_reason ?? 'no reason recorded'}); not overwritten` }
  }
  if (text.processing_status === 'processing') return { state: 'waiting', why: 'the text copy is being processed right now' }
  if (isPastedText(audio)) return { state: 'blocked', why: 'the other copy is also pasted text, not audio' }
  if (audio.processing_status === 'skipped' || audio.duplicate_of) return { state: 'blocked', why: 'the audio copy is itself skipped as a duplicate' }
  if (audio.transcript_origin !== 'deepgram') {
    return { state: 'blocked', why: `the audio copy's transcript origin is ${audio.transcript_origin ?? 'null'}, not deepgram` }
  }
  if (audio.processing_status !== 'succeeded') {
    return { state: 'waiting', why: `the audio copy is ${audio.processing_status ?? 'in an unknown state'}, not yet succeeded: the text copy stays live until it is` }
  }
  if ((audio.facts ?? 0) === 0) return { state: 'waiting', why: 'the audio copy is marked succeeded but holds 0 facts' }
  return { state: 'ready', audio }
}

/** The only fields step 3 writes on a text row. */
export function replacementPatch(audioId: string): { processing_status: 'skipped'; duplicate_of: string; skip_reason: string } {
  return { processing_status: 'skipped', duplicate_of: audioId, skip_reason: PASTED_TEXT_SKIP_REASON }
}

// ── Pairing: which audio copy replaces which text copy ────────────────────────

/** A source row with everything the pairing rules read (the duplicate rules' columns plus the skip). */
export type SourceLike = LibraryRow & { skip_reason?: string | null }

export type ReplacementItem = {
  text: SourceLike
  audio: SourceLike | null
  /** `explicit` = named by --pair; `auto` = found by the duplicate rules; `none` = no audio copy found. */
  how: 'explicit' | 'auto' | 'none'
  /** The duplicate rule that matched, for an auto pair. */
  matchDetail: string | null
  state: ReplacementState
}

/**
 * Pair pasted-text rows with the audio copy that replaces them, and say what may be done.
 * `pairs` names the rows to look at (and, when it carries an `audioId`, the exact copy); with
 * no `pairs`, every pasted-text row is listed (a report, never a license to write). An explicit
 * pair always wins over a guess: a text row with no episode number, key or length
 * ("Longevity 101") cannot be matched by the rules and needs one.
 */
export function planPastedTextReplacements(
  rows: readonly SourceLike[],
  opts: { pairs?: readonly { textId: string; audioId?: string | null }[] } = {},
): ReplacementItem[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  const audioLibrary = rows.filter(r => !isPastedText(r))
  const wanted: { textId: string; audioId: string | null }[] = opts.pairs
    ? opts.pairs.map(p => ({ textId: p.textId, audioId: p.audioId ?? null }))
    : rows.filter(isPastedText).map(r => ({ textId: r.id, audioId: null }))
  const out: ReplacementItem[] = []
  for (const w of wanted) {
    const text = byId.get(w.textId)
    if (!text) continue // the caller reports ids that match no row
    let audio: SourceLike | null = null
    let how: ReplacementItem['how'] = 'none'
    let matchDetail: string | null = null
    if (w.audioId) {
      audio = byId.get(w.audioId) ?? null
      how = 'explicit'
      if (!audio) {
        out.push({ text, audio: null, how, matchDetail, state: { state: 'blocked', why: `no source ${w.audioId} to pair it with` } })
        continue
      }
    } else if (isPastedText(text)) {
      const found = findOriginal(text, audioLibrary)
      if (found) {
        audio = found.row as SourceLike
        how = 'auto'
        matchDetail = found.detail
      }
    }
    out.push({ text, audio, how, matchDetail, state: replacementState(text, audio) })
  }
  return out
}
