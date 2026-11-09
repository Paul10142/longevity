/**
 * Unit tests for lib/pastedTextReplacement.ts: replacing a pasted-text copy of an episode with a
 * Deepgram transcript of its audio (Paul, 2026-11-08). Pure functions; no database.
 *
 * The rows mirror the three live Drive cases: #368 and #351 (text rows that hold the feed key, so
 * the audio row is created by `ingestFeedSources.ts --replace`) and "Longevity 101" (a text row with
 * no key, number or length, paired by hand with the Deepgram #311).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isFeedKey } from '../lib/podcastFeed'
import {
  PASTED_TEXT_SKIP_REASON,
  isFullId,
  planPastedTextReplacements,
  replacementPatch,
  replacementState,
  resolveReplaceTargets,
  textKeyFor,
  type ReplacementRow,
  type SourceLike,
} from '../lib/pastedTextReplacement'

const TEXT368 = 'd82e9534-1178-40d2-bb89-30603430889c'
const TEXT351 = 'debd5a41-707c-4f23-9ab6-81d771d32e0a'
const AUDIO368 = '11111111-1111-4111-8111-111111111111'

const textRow = (extra: Partial<ReplacementRow> = {}): ReplacementRow => ({
  id: TEXT368,
  title: '#368 The Protein Debata',
  external_id: 'attia-0368',
  media_type: 'text',
  transcript_origin: 'manual',
  processing_status: 'succeeded',
  duplicate_of: null,
  facts: 156,
  ...extra,
})
const audioRow = (extra: Partial<ReplacementRow> = {}): ReplacementRow => ({
  id: AUDIO368,
  title: '#368 ‒ The protein debate: optimal intake | David Allison, Ph.D.',
  external_id: 'attia-0368',
  media_type: 'audio',
  transcript_origin: 'deepgram',
  processing_status: 'succeeded',
  duplicate_of: null,
  facts: 140,
  ...extra,
})

test('constants: the skip reason and the renamed key', () => {
  assert.equal(PASTED_TEXT_SKIP_REASON, 'pasted text replaced by Deepgram transcript (Paul, 2026-11-08)')
  assert.equal(textKeyFor('attia-0368'), 'text-attia-0368')
  // The renamed key must not read as a feed key, or the ingest would treat the text row as an older id.
  assert.equal(isFeedKey('attia', textKeyFor('attia-0368')), false)
  assert.equal(isFeedKey('attia', 'attia-0368'), true)
})

test('isFullId accepts only whole UUIDs', () => {
  assert.equal(isFullId(TEXT368), true)
  assert.equal(isFullId('d82e9534'), false)
  assert.equal(isFullId('d82e9534-1178-40d2-bb89-30603430889'), false)
  assert.equal(isFullId(null), false)
})

// ── step 1: which ids --replace accepts ───────────────────────────────────────

const showKey = (k: string | null | undefined) => isFeedKey('attia', k)
const resolve = (ids: string[], rows: ReplacementRow[], feedKeys = ['attia-0368', 'attia-0351']) =>
  resolveReplaceTargets({ ids, rows, feedKeys: new Set(feedKeys), isShowKey: showKey })

test('--replace: a live pasted-text row that holds a feed key is accepted', () => {
  const r = resolve([TEXT368], [textRow()])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.targets, [{ id: TEXT368, key: 'attia-0368', title: '#368 The Protein Debata' }])
})

test('--replace: both Drive rows at once', () => {
  const r = resolve([TEXT368, TEXT351], [textRow(), textRow({ id: TEXT351, title: '#351 ‒ Male fertility', external_id: 'attia-0351' })])
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.targets.map(t => t.key), ['attia-0368', 'attia-0351'])
})

test('--replace: never a prefix, never an unknown id, never the same id twice', () => {
  const r = resolve(['d82e9534', '22222222-2222-4222-8222-222222222222', TEXT368, TEXT368], [textRow()])
  assert.equal(r.targets.length, 1)
  assert.equal(r.errors.length, 3)
  assert.match(r.errors[0], /whole source id/)
  assert.match(r.errors[1], /no such source/)
  assert.match(r.errors[2], /given twice/)
})

test('--replace: only pasted text is replaced (an audio row is refused)', () => {
  const r = resolve([AUDIO368], [audioRow()])
  assert.equal(r.targets.length, 0)
  assert.match(r.errors[0], /not a pasted-text row/)
})

test('--replace: a row already skipped, or without a feed key, or whose key the feed lacks, is refused', () => {
  assert.match(resolve([TEXT368], [textRow({ processing_status: 'skipped', duplicate_of: AUDIO368 })]).errors[0], /already skipped/)
  assert.match(resolve([TEXT368], [textRow({ external_id: null })]).errors[0], /holds no feed key/)
  assert.match(resolve([TEXT368], [textRow({ external_id: 'text-attia-0368' })]).errors[0], /holds no feed key/)
  assert.match(resolve([TEXT368], [textRow()], ['attia-0400']).errors[0], /the feed has no episode attia-0368/)
})

test('--replace: refused when the renamed key is already taken by another row', () => {
  const r = resolve([TEXT368], [textRow(), textRow({ id: '33333333-3333-4333-8333-333333333333', external_id: 'text-attia-0368' })])
  assert.equal(r.targets.length, 0)
  assert.match(r.errors[0], /already holds text-attia-0368/)
})

// ── step 3: when a text copy may be retired ───────────────────────────────────

test('ready: the audio copy succeeded, is Deepgram, live, and has facts', () => {
  const s = replacementState(textRow(), audioRow())
  assert.equal(s.state, 'ready')
})

test('TRAP: a pending audio copy (0 facts) leaves the text copy live: waiting, never ready', () => {
  const s = replacementState(textRow(), audioRow({ processing_status: 'pending', facts: 0 }))
  assert.equal(s.state, 'waiting')
  assert.match((s as { why: string }).why, /not yet succeeded/)
})

test('waiting: no audio copy yet, an extraction still running, a failed run, or succeeded with 0 facts', () => {
  assert.equal(replacementState(textRow(), null).state, 'waiting')
  assert.equal(replacementState(textRow(), audioRow({ processing_status: 'processing', facts: 3 })).state, 'waiting')
  assert.equal(replacementState(textRow(), audioRow({ processing_status: 'failed', facts: 0 })).state, 'waiting')
  assert.equal(replacementState(textRow(), audioRow({ facts: 0 })).state, 'waiting')
})

test('waiting: the text copy is being processed right now', () => {
  assert.equal(replacementState(textRow({ processing_status: 'processing' }), audioRow()).state, 'waiting')
})

test('blocked: the other copy is pasted text, skipped, a caption import, or the same row', () => {
  assert.equal(replacementState(textRow(), audioRow({ media_type: 'text' })).state, 'blocked')
  assert.equal(replacementState(textRow(), audioRow({ processing_status: 'skipped', duplicate_of: 'x' })).state, 'blocked')
  assert.equal(replacementState(textRow(), audioRow({ transcript_origin: 'manual' })).state, 'blocked')
  assert.equal(replacementState(textRow(), textRow()).state, 'blocked')
})

test('blocked: the "text" copy is not pasted text at all', () => {
  assert.equal(replacementState(audioRow(), audioRow({ id: 'other' })).state, 'blocked')
})

test('applied: a text row that already carries this replacement is a no-op; another skip is never overwritten', () => {
  const done = textRow({ processing_status: 'skipped', duplicate_of: AUDIO368, skip_reason: PASTED_TEXT_SKIP_REASON })
  assert.equal(replacementState(done, audioRow()).state, 'applied')
  const other = textRow({ processing_status: 'skipped', duplicate_of: AUDIO368, skip_reason: 'something else' })
  assert.equal(replacementState(other, audioRow()).state, 'blocked')
  const elsewhere = textRow({ processing_status: 'skipped', duplicate_of: 'another-audio', skip_reason: PASTED_TEXT_SKIP_REASON })
  assert.equal(replacementState(elsewhere, audioRow()).state, 'blocked')
})

test('the patch writes exactly three fields: status, duplicate_of, skip_reason', () => {
  assert.deepEqual(replacementPatch(AUDIO368), {
    processing_status: 'skipped',
    duplicate_of: AUDIO368,
    skip_reason: PASTED_TEXT_SKIP_REASON,
  })
})

// ── pairing ───────────────────────────────────────────────────────────────────

const src = (r: ReplacementRow & { media_duration_sec?: number | null }, extra: Partial<SourceLike> = {}): SourceLike => ({ series: 'The Drive', authors: ['Dr. Peter Attia'], ...r, title: r.title ?? '', ...extra })

test('pairing: an audio copy with the same title number is found by the duplicate rules', () => {
  const items = planPastedTextReplacements([src(textRow()), src(audioRow({ processing_status: 'pending', facts: 0 }))])
  assert.equal(items.length, 1)
  assert.equal(items[0].how, 'auto')
  assert.equal(items[0].audio?.id, AUDIO368)
  assert.equal(items[0].state.state, 'waiting')
})

test('pairing: with no audio copy in the library the text row is listed as waiting', () => {
  const items = planPastedTextReplacements([src(textRow())])
  assert.equal(items[0].how, 'none')
  assert.equal(items[0].state.state, 'waiting')
})

test('pairing: only pasted-text rows are listed when no pairs are given', () => {
  const items = planPastedTextReplacements([src(textRow()), src(audioRow())])
  assert.deepEqual(items.map(i => i.text.id), [TEXT368])
})

test('pairing: two pasted-text copies of one episode are never each other\'s audio copy', () => {
  const second = textRow({ id: '44444444-4444-4444-8444-444444444444', external_id: null })
  const items = planPastedTextReplacements([src(textRow()), src(second)])
  for (const i of items) assert.equal(i.audio, null)
})

test('pairing: "Longevity 101" has no number, key or length, so it needs an explicit pair', () => {
  const long101 = src({ id: '1ae3e21b-bb04-403a-ba4e-f426b027626f', title: 'Longevity 101', external_id: null, media_type: 'text', transcript_origin: 'manual', processing_status: 'succeeded', facts: 122 })
  const deepgram311 = src({
    id: 'e3e168c4-155f-43ae-bbd9-d944b2a5350b',
    title: "#311 ‒ Longevity 101: a foundational guide to Peter's frameworks for longevity",
    external_id: 'attia-0311',
    media_type: 'audio',
    transcript_origin: 'deepgram',
    processing_status: 'succeeded',
    facts: 111,
    media_duration_sec: 4979,
  })
  const auto = planPastedTextReplacements([long101, deepgram311])
  assert.equal(auto[0].audio, null) // cannot be guessed
  const explicit = planPastedTextReplacements([long101, deepgram311], { pairs: [{ textId: long101.id, audioId: deepgram311.id }] })
  assert.equal(explicit[0].how, 'explicit')
  assert.equal(explicit[0].state.state, 'ready')
})

test('pairing: an explicit audio id that matches no row is blocked, and a text id that matches none is skipped', () => {
  const items = planPastedTextReplacements([src(textRow())], { pairs: [{ textId: TEXT368, audioId: 'nope' }, { textId: 'ghost', audioId: null }] })
  assert.equal(items.length, 1)
  assert.equal(items[0].state.state, 'blocked')
})
