/**
 * Unit tests for lib/guestNames.ts: the prompt, the reply reader, the deterministic
 * check that disposes of what Claude proposes, the batch runner, and the plan that
 * `scripts/refreshGuests.ts --apply` refuses to run when it is stale.
 *
 * The model is a stub throughout: these tests never call Claude, the database or the
 * network. (The live accuracy number comes from scripts/evalGuestNames.ts against
 * tests/fixtures/guest-gold.json; the fixture's shape is checked at the bottom.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BATCH_SIZE,
  GuestReplyError,
  appearsIn,
  buildGuestPrompt,
  buildPlan,
  checkPlan,
  chunk,
  cleanDescription,
  decideEpisode,
  fallbackGuests,
  foldForMatch,
  literalSpelling,
  notANameReason,
  parseGuestReply,
  parsePlan,
  resolveGuests,
  sameAuthors,
  sameGuestSet,
  sharedSurname,
  stopKindOf,
  stripHonorifics,
  titleSpelling,
  validateGuests,
  type GuestEpisode,
  type GuestLlm,
  type GuestPlan,
  type SourceRow,
} from '../lib/guestNames'
import { parseGuests } from '../lib/podcastFeed'
import { isHostName, showByPrefix, type Show } from '../lib/shows'
import { PipelineHaltError, UsageLimitError } from '../lib/usageLimit'

const attia = showByPrefix('attia') as Show
const fmf = showByPrefix('fmf') as Show

const ep = (id: string, title: string, description: string | null = null): GuestEpisode => ({ id, title, description })

/** An error that `resolveGuests` recognises by name (the real classes live in lib/llm.ts, which loads the SDK). */
const named = (name: string, message: string) => Object.assign(new Error(message), { name })

/** A stub that answers from a map of id -> guests, and records every call. */
function stub(answers: Record<string, string[]>) {
  const calls: { system: string; user: string }[] = []
  const llm: GuestLlm = async (system, user) => {
    calls.push({ system, user })
    const ids = [...user.matchAll(/^ID: (.+)$/gm)].map(m => m[1])
    return { episodes: ids.filter(id => id in answers).map(id => ({ id, guests: answers[id] })) }
  }
  return { llm, calls }
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

test('cleanDescription drops paragraphs that are only links, keeps links inside a sentence, decodes entities', () => {
  const html =
    '<p><a href="https://x.example/join">Discover my premium podcast</a></p>' +
    '<p><a href="https://x.example/s">Sponsor</a> <a href="https://x.example/t">Another</a></p>' +
    '<p>In this episode my guest is <a href="https://x.example/g">Dr. Jane Roe</a> &amp; we talk about sleep&#8217;s role.</p>'
  assert.equal(cleanDescription(html), 'In this episode my guest is Dr. Jane Roe & we talk about sleep’s role.')
})

test('cleanDescription cuts to the window with an ellipsis, and tolerates empty input', () => {
  assert.equal(cleanDescription(null), '')
  assert.equal(cleanDescription(undefined), '')
  assert.equal(cleanDescription(''), '')
  const long = 'word '.repeat(300)
  const out = cleanDescription(long, 50)
  assert.ok(out.endsWith('…'))
  assert.ok(out.length <= 51)
})

test('foldForMatch folds case, accents, special letters and punctuation', () => {
  assert.equal(foldForMatch('Dominic D’Agostino'), 'dominic d agostino')
  assert.equal(foldForMatch('Tadej Pogačar'), 'tadej pogacar')
  assert.equal(foldForMatch('Søberg'), foldForMatch('Soberg'))
  assert.equal(foldForMatch('  Iñigo   San-Millán '), 'inigo san millan')
})

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

test('the prompt names the show and its host, and gives one block per episode', () => {
  const { system, user } = buildGuestPrompt(attia, [
    ep('attia-0001', 'Habits | Jane Roe (#1 rebroadcast)', '<p>Notes about <b>habits</b>.</p>'),
    ep('attia-0002', 'Ask me anything', null),
  ])
  assert.ok(system.includes(attia.series))
  assert.ok(system.includes(attia.host))
  assert.match(system, /\{"episodes":\[\{"id":/)
  const blocks = user.split('\n\n---\n\n')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0], 'ID: attia-0001\nTITLE: Habits | Jane Roe (#1 rebroadcast)\nNOTES: Notes about habits .')
  assert.equal(blocks[1], 'ID: attia-0002\nTITLE: Ask me anything\nNOTES: (none)')
})

test('the prompt carries no real guest names (the gold set must test generalisation, not memory)', () => {
  const { system } = buildGuestPrompt(fmf, [])
  for (const real of ['James Clear', 'Matt Walker', 'Kyle Allred', 'Annie Duke', 'Ric Elias']) assert.ok(!system.includes(real), real)
})

// ---------------------------------------------------------------------------
// Reading the reply
// ---------------------------------------------------------------------------

test('parseGuestReply reads an object, a bare array, fenced JSON and JSON inside prose', () => {
  const want = new Map([['a', ['Jane Roe']], ['b', []]])
  const obj = { episodes: [{ id: 'a', guests: ['Jane Roe'] }, { id: 'b', guests: [] }] }
  assert.deepEqual(parseGuestReply(obj), want)
  assert.deepEqual(parseGuestReply(obj.episodes), want)
  assert.deepEqual(parseGuestReply('```json\n' + JSON.stringify(obj) + '\n```'), want)
  assert.deepEqual(parseGuestReply('Here you go:\n' + JSON.stringify(obj) + '\nHope that helps.'), want)
  assert.deepEqual(parseGuestReply(JSON.stringify(obj.episodes)), want)
})

test('parseGuestReply throws GuestReplyError on text that is not the requested JSON', () => {
  for (const bad of ['', '   ', 'I could not find any guests.', '{"episodes": [', '{"nope": 1}', 42, null]) {
    assert.throws(() => parseGuestReply(bad), GuestReplyError, JSON.stringify(bad))
  }
  // Entries present but none readable: the reply is unusable, not "everyone has no guest".
  assert.throws(() => parseGuestReply({ episodes: [{ id: 5, guests: [] }, { id: 'a', guests: 'Jane Roe' }] }), GuestReplyError)
})

test('parseGuestReply leaves out malformed entries and ids that appear twice, so those episodes fall back', () => {
  const m = parseGuestReply({
    episodes: [
      { id: 'a', guests: ['Jane Roe'] },
      { id: 'b', guests: 'Sam Doe' },
      { id: 'c', guests: ['Sam Doe', 7] },
      { id: 'd', guests: ['First'] },
      { id: 'd', guests: ['Second'] },
      null,
      'x',
      { guests: ['No Id'] },
    ],
  })
  assert.deepEqual([...m.keys()], ['a'])
  assert.deepEqual(parseGuestReply({ episodes: [] }), new Map())
})

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test('stripHonorifics removes titles and credentials but keeps Jr., II and surnames that look like credentials', () => {
  assert.equal(stripHonorifics('Dr. Vivek Murthy, M.D.'), 'Vivek Murthy')
  assert.equal(stripHonorifics('Prof. Jane Roe, Ph.D., M.P.H.'), 'Jane Roe')
  assert.equal(stripHonorifics('Sam Doe PhD'), 'Sam Doe')
  assert.equal(stripHonorifics('Martin Luther King Jr.'), 'Martin Luther King Jr.')
  assert.equal(stripHonorifics('Tran Do'), 'Tran Do')
  assert.equal(stripHonorifics('Jane Roe, DO'), 'Jane Roe')
  assert.equal(stripHonorifics('  Jane   Roe  '), 'Jane Roe')
})

test('notANameReason rejects brackets, numbers, episode notes, joined names and runs of words', () => {
  assert.equal(notANameReason('Jane Roe'), null)
  assert.equal(notANameReason('Iñigo San-Millán'), null)
  assert.equal(notANameReason("Dominic D'Agostino"), null)
  for (const bad of ['Jane Roe (#183 rebroadcast)', 'Quarterly Podcast Summary', 'Jane Roe Pt. 2', 'Q&A', '#12', 'Derek from MPMD', 'Erica and Justin Sonnenburg', 'Jane & Sam', 'M.P.H.', '', 'x '.repeat(40)]) {
    assert.notEqual(notANameReason(bad), null, bad)
  }
})

test('appearsIn matches whole words, ignoring case, accents and punctuation', () => {
  assert.ok(appearsIn('Matt Walker', 'GUEST SERIES | Dr. Matt Walker: sleep'))
  assert.ok(appearsIn('Tadej Pogacar', 'Tadej Pogačar reveals'))
  assert.ok(!appearsIn('Matt Walker', 'Matthew Walker on sleep'))
  assert.ok(!appearsIn('Ann', 'Joanne Doe'))
  assert.ok(!appearsIn('', 'anything'))
})

test('sharedSurname accepts "Mark and Chris Bell" as Mark Bell and Chris Bell, and nothing looser', () => {
  const t = '#28 – Mark and Chris Bell: steroids, powerlifting'
  assert.ok(sharedSurname('Mark Bell', t))
  assert.ok(sharedSurname('Mark Bell', '#28 – Mark & Chris Bell: steroids'))
  assert.ok(!sharedSurname('Chris Bell', t), 'Chris Bell is written out, so appearsIn handles it')
  assert.ok(!sharedSurname('Mark Smith', t))
  assert.ok(!sharedSurname('Mark Bell', 'Mark with Chris Bell'))
  assert.ok(!sharedSurname('Mark J Bell', t))
})

test('literalSpelling gives the text its own punctuation and accents, but not its capitals', () => {
  assert.equal(literalSpelling("Dominic D'Agostino", '#375 - Dominic D’Agostino: the keto diet'), 'Dominic D’Agostino')
  assert.equal(literalSpelling('Tadej Pogacar', 'Tadej Pogačar reveals'), 'Tadej Pogačar')
  assert.equal(literalSpelling('Matt Walker', 'DR. MATT WALKER ON SLEEP'), 'Matt Walker')
  assert.equal(literalSpelling('Sam Doe', 'Nothing here'), 'Sam Doe')
})

test('literalSpelling keeps the periods that belong to a name (initials, Jr.) and drops the punctuation around it', () => {
  assert.equal(literalSpelling('George A. Brooks', '#312 - A masterclass in lactate | George A. Brooks, Ph.D.'), 'George A. Brooks')
  assert.equal(literalSpelling('D.A. Wallach', '#06 – D.A. Wallach: music, medicine'), 'D.A. Wallach')
  assert.equal(literalSpelling('Martin Luther King Jr.', 'A talk with Martin Luther King Jr. on justice'), 'Martin Luther King Jr.')
  assert.equal(literalSpelling('Jane Roe', 'Today we talk to Jane Roe. She is a professor.'), 'Jane Roe')
  assert.equal(literalSpelling('Jane Roe', '(Jane Roe), a professor'), 'Jane Roe')
})

test('the prompt tells the model that a rebroadcast or tribute of an interview has that person as its guest', () => {
  assert.match(buildGuestPrompt(attia, []).system, /rebroadcast or tribute of an earlier interview/)
})

test('titleSpelling lets the title win over a longer or shorter spelling of the same person', () => {
  assert.equal(titleSpelling('Matthew Walker', 'GUEST SERIES | Dr. Matt Walker: The Biology of Sleep'), 'Matt Walker')
  assert.equal(titleSpelling('David A. Sinclair', '#049 Dr. David Sinclair on the Informational Theory of Aging'), 'David Sinclair')
  assert.equal(titleSpelling('Samuel Doe', 'Dr. Sam Doe on sleep'), 'Sam Doe')
  // Not the same person: a different first name, or no surname in the title.
  assert.equal(titleSpelling('Jane Roe', 'Sam Roe on sleep'), 'Jane Roe')
  assert.equal(titleSpelling('Bill Harris', '#83 - Bill Harris, Ph.D.: Omega-3'), 'Bill Harris')
  assert.equal(titleSpelling('Derek', 'x'), 'Derek')
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateGuests keeps names that are in the title or notes, and strips credentials', () => {
  const e = ep('attia-1', '#317 ‒ Reforming medicine | Marty Makary, M.D., M.P.H.')
  assert.deepEqual(validateGuests(attia, e, ['Dr. Marty Makary, M.D.']), { ok: true, guests: ['Marty Makary'], droppedHost: [] })
})

test('validateGuests accepts a guest named only in the notes (the title is a series label)', () => {
  const e = ep('huberman-g1', 'GUEST SERIES | The Biology of Sleep', '<p>My guest is Dr. Jane Roe, a professor of sleep science.</p>')
  const v = validateGuests(showByPrefix('huberman') as Show, e, ['Jane Roe'])
  assert.deepEqual(v, { ok: true, guests: ['Jane Roe'], droppedHost: [] })
})

test('validateGuests rejects the whole episode when any name is not in the text it was shown', () => {
  const e = ep('attia-2', 'Habits | Jane Roe', 'A talk about habits.')
  const v = validateGuests(attia, e, ['Jane Roe', 'Invented Person'])
  assert.equal(v.ok, false)
  assert.match((v as { reason: string }).reason, /Invented Person.*not in the title or description/)
})

test('validateGuests rejects bracket text, episode notes, joined names and empty names', () => {
  const e = ep('attia-3', 'Habits | Jane Roe (#183 rebroadcast)')
  for (const bad of ['Jane Roe (#183 rebroadcast)', 'Quarterly Podcast Summary #6', 'Jane Roe and Sam Doe', 'Dr.', '']) {
    assert.equal(validateGuests(attia, e, [bad]).ok, false, bad)
  }
})

test('validateGuests drops the host without complaint, in any of the ways the host is written', () => {
  const e = ep('attia-4', 'Journal club with Dr. Peter Attia and Jane Roe', 'Peter Attia, M.D. and Jane Roe discuss a paper.')
  for (const hostForm of ['Peter Attia', 'Dr. Peter Attia', 'Peter Attia, M.D.']) {
    const v = validateGuests(attia, e, [hostForm, 'Jane Roe'])
    assert.deepEqual(v, { ok: true, guests: ['Jane Roe'], droppedHost: [hostForm] })
  }
})

test('validateGuests normalises spelling to the text and removes duplicates', () => {
  const e = ep('fmf-1', 'Dr. Dominic D’Agostino on the ketogenic diet', 'Dominic D’Agostino, Ph.D. joins Rhonda.')
  assert.deepEqual(validateGuests(fmf, e, ["Dominic D'Agostino", 'Dr. Dominic D’Agostino']), {
    ok: true,
    guests: ['Dominic D’Agostino'],
    droppedHost: [],
  })
  const m = ep('attia-5', 'Matt Walker on sleep', 'Dr. Matthew Walker explains.')
  assert.deepEqual((validateGuests(attia, m, ['Matthew Walker']) as { guests: string[] }).guests, ['Matt Walker'])
})

test('validateGuests accepts shared-surname guests and an empty list', () => {
  const e = ep('attia-6', '#28 – Mark and Chris Bell: steroids, powerlifting')
  assert.deepEqual(validateGuests(attia, e, ['Mark Bell', 'Chris Bell']), { ok: true, guests: ['Mark Bell', 'Chris Bell'], droppedHost: [] })
  assert.deepEqual(validateGuests(attia, ep('attia-7', 'Quarterly Podcast Summary #6'), []), { ok: true, guests: [], droppedHost: [] })
})

test('validateGuests rejects more than six guests', () => {
  const names = ['Ann Aa', 'Bob Bb', 'Cat Cc', 'Dan Dd', 'Eve Ee', 'Fay Ff', 'Gus Gg']
  const e = ep('attia-8', `Panel | ${names.join(', ')}`)
  const v = validateGuests(attia, e, names)
  assert.equal(v.ok, false)
  assert.match((v as { reason: string }).reason, /more than 6/)
})

// ---------------------------------------------------------------------------
// Deciding an episode
// ---------------------------------------------------------------------------

test('fallbackGuests is the title rule with the host removed and duplicates folded', () => {
  const t = 'Building & Changing Habits | James Clear (#183 rebroadcast)'
  assert.deepEqual(fallbackGuests(attia, t), parseGuests(t, attia.strictGuests))
  for (const title of [t, '#307 ‒ Exercise for aging people | Peter Attia', 'Dr. Peter Attia | Jane Roe']) {
    for (const g of fallbackGuests(attia, title)) assert.ok(!isHostName(attia, g), `${title} -> ${g}`)
  }
})

test('decideEpisode: Claude when the answer validates, the title rule (with the reason) when it does not', () => {
  const e = ep('attia-9', 'Habits | Jane Roe (#1 rebroadcast)')
  const ok = decideEpisode(attia, e, ['Jane Roe'])
  assert.deepEqual([ok.guests, ok.decided_by], [['Jane Roe'], 'claude'])

  const solo = decideEpisode(attia, ep('attia-10', 'Ask me anything'), [])
  assert.deepEqual([solo.guests, solo.decided_by, solo.reason], [[], 'claude', 'no guest'])

  const rejected = decideEpisode(attia, e, ['Somebody Else'])
  assert.equal(rejected.decided_by, 'fallback')
  assert.match(rejected.reason, /rejected.*Somebody Else/)
  assert.deepEqual(rejected.guests, fallbackGuests(attia, e.title))

  const missing = decideEpisode(attia, e, undefined)
  assert.equal(missing.decided_by, 'fallback')
  assert.match(missing.reason, /no usable answer/)
})

// ---------------------------------------------------------------------------
// Running the batches
// ---------------------------------------------------------------------------

test('chunk splits into batches of at most the given size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 3), [])
  assert.equal(BATCH_SIZE, 20)
})

test('stopKindOf recognises the failures every later call would repeat', () => {
  assert.equal(stopKindOf(new UsageLimitError('reached', null)), 'usage-limit')
  assert.equal(stopKindOf(new PipelineHaltError(3, 'logged out')), 'halt')
  assert.equal(stopKindOf(named('CliUnavailableError', 'no claude')), 'cli-unavailable')
  assert.equal(stopKindOf(named('ModelRefusalError', 'declined')), null)
  assert.equal(stopKindOf(new Error('boom')), null)
  assert.equal(stopKindOf('text'), null)
})

test('resolveGuests asks in batches and decides each episode from its own answer', async () => {
  const episodes = [ep('attia-1', 'A | Jane Roe'), ep('attia-2', 'B | Sam Doe'), ep('attia-3', 'Solo episode')]
  const { llm, calls } = stub({ 'attia-1': ['Jane Roe'], 'attia-2': ['Sam Doe'], 'attia-3': [] })
  const seen: [number, number][] = []
  const r = await resolveGuests(attia, episodes, llm, { batchSize: 2, onBatch: (d, t) => seen.push([d, t]) })
  assert.equal(calls.length, 2)
  assert.deepEqual(seen, [[1, 2], [2, 2]])
  assert.equal(r.stopped, null)
  assert.deepEqual(r.batches, { total: 2, asked: 2, failed: 0 })
  assert.deepEqual([...r.decisions].map(([id, d]) => [id, d.guests, d.decided_by]), [
    ['attia-1', ['Jane Roe'], 'claude'],
    ['attia-2', ['Sam Doe'], 'claude'],
    ['attia-3', [], 'claude'],
  ])
})

test('resolveGuests retries an unreadable reply once, then sends that batch to the title rule', async () => {
  let n = 0
  const llm: GuestLlm = async () => { n++; return 'sorry, no JSON today' }
  const r = await resolveGuests(attia, [ep('attia-1', 'A | Jane Roe')], llm)
  assert.equal(n, 2)
  assert.deepEqual(r.batches, { total: 1, asked: 1, failed: 1 })
  const d = r.decisions.get('attia-1')
  assert.equal(d?.decided_by, 'fallback')
  assert.match(d?.reason ?? '', /call failed/)
})

test('resolveGuests recovers when the retry reads', async () => {
  let n = 0
  const llm: GuestLlm = async () => (++n === 1 ? 'not json' : { episodes: [{ id: 'attia-1', guests: ['Jane Roe'] }] })
  const r = await resolveGuests(attia, [ep('attia-1', 'A | Jane Roe')], llm)
  assert.equal(n, 2)
  assert.equal(r.batches.failed, 0)
  assert.equal(r.decisions.get('attia-1')?.decided_by, 'claude')
})

test('resolveGuests does not retry a safety refusal, and only that batch falls back', async () => {
  const episodes = [ep('attia-1', 'A | Jane Roe'), ep('attia-2', 'B | Sam Doe')]
  let n = 0
  const llm: GuestLlm = async (_s, user) => {
    n++
    if (user.includes('attia-1')) throw named('ModelRefusalError', 'declined')
    return { episodes: [{ id: 'attia-2', guests: ['Sam Doe'] }] }
  }
  const r = await resolveGuests(attia, episodes, llm, { batchSize: 1 })
  assert.equal(n, 2, 'one call per batch, no retry on the refusal')
  assert.equal(r.stopped, null)
  assert.deepEqual(r.batches, { total: 2, asked: 2, failed: 1 })
  assert.equal(r.decisions.get('attia-1')?.decided_by, 'fallback')
  assert.equal(r.decisions.get('attia-2')?.decided_by, 'claude')
})

test('resolveGuests stops cleanly on a usage limit: the rest use the title rule and the run says why', async () => {
  const episodes = [ep('attia-1', 'A | Jane Roe'), ep('attia-2', 'B | Sam Doe'), ep('attia-3', 'C | Kim Poe')]
  let n = 0
  const llm: GuestLlm = async () => {
    n++
    if (n === 1) return { episodes: [{ id: 'attia-1', guests: ['Jane Roe'] }] }
    throw new UsageLimitError('reached', null)
  }
  const r = await resolveGuests(attia, episodes, llm, { batchSize: 1 })
  assert.equal(n, 2, 'no retry, no third call after the stop')
  assert.equal(r.stopped?.kind, 'usage-limit')
  assert.deepEqual(r.batches, { total: 3, asked: 1, failed: 0 })
  assert.equal(r.decisions.size, 3, 'every episode still gets a decision')
  assert.equal(r.decisions.get('attia-1')?.decided_by, 'claude')
  for (const id of ['attia-2', 'attia-3']) {
    const d = r.decisions.get(id)
    assert.equal(d?.decided_by, 'fallback')
    assert.match(d?.reason ?? '', /not asked/)
  }
})

test('resolveGuests stops on a halted or missing CLI too', async () => {
  const halt = await resolveGuests(attia, [ep('attia-1', 'A')], async () => { throw new PipelineHaltError(3, 'logged out') })
  assert.equal(halt.stopped?.kind, 'halt')
  const gone = await resolveGuests(attia, [ep('attia-1', 'A')], async () => { throw named('CliUnavailableError', 'no claude') })
  assert.equal(gone.stopped?.kind, 'cli-unavailable')
  assert.equal(gone.decisions.get('attia-1')?.decided_by, 'fallback')
})

test('resolveGuests sends an episode the reply forgot to the title rule', async () => {
  const { llm } = stub({ 'attia-1': ['Jane Roe'] })
  const r = await resolveGuests(attia, [ep('attia-1', 'A | Jane Roe'), ep('attia-2', 'B | Sam Doe')], llm)
  assert.equal(r.decisions.get('attia-1')?.decided_by, 'claude')
  assert.equal(r.decisions.get('attia-2')?.decided_by, 'fallback')
})

// ---------------------------------------------------------------------------
// Comparing guest lists
// ---------------------------------------------------------------------------

test('sameAuthors is exact and ordered; sameGuestSet ignores order, case and accents', () => {
  assert.ok(sameAuthors(['Dr. Peter Attia', 'Jane Roe'], ['Dr. Peter Attia', 'Jane Roe']))
  assert.ok(sameAuthors(null, []))
  assert.ok(!sameAuthors(['a', 'b'], ['b', 'a']))
  assert.ok(sameGuestSet(['Tadej Pogačar', 'jane roe'], ['Jane Roe', 'Tadej Pogacar']))
  assert.ok(!sameGuestSet(['Jane Roe'], ['Jane Roe', 'Sam Doe']))
})

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const MADE_AT = '2026-11-08T12:00:00.000Z'

/** A plan for three Drive episodes: one to change, one already right, one with no library row yet. */
function samplePlan() {
  const episodes = [ep('attia-1', 'Habits | Jane Roe (#1 rebroadcast)'), ep('attia-2', 'Ask me anything'), ep('attia-3', 'New | Sam Doe')]
  const decisions = new Map([
    ['attia-1', { guests: ['Jane Roe'], decided_by: 'claude' as const, reason: '1 guest read from the title and notes' }],
    ['attia-2', { guests: [] as string[], decided_by: 'claude' as const, reason: 'no guest' }],
    ['attia-3', { guests: ['Sam Doe'], decided_by: 'fallback' as const, reason: 'Claude not asked' }],
  ])
  const rows: SourceRow[] = [
    { id: 'src-1', external_id: 'attia-1', authors: [attia.host, 'Jane Roe (#1 rebroadcast)'] },
    { id: 'src-2', external_id: 'attia-2', authors: [attia.host] },
  ]
  const plan = buildPlan({ show: attia, episodes, decisions, rowsByKey: new Map(rows.map(r => [r.external_id as string, r])), model: 'test-model', madeAt: MADE_AT, stopped: null })
  return { plan, rows }
}
const byId = (rows: SourceRow[]) => new Map(rows.map(r => [r.id, r]))

test('buildPlan puts the host first, counts what Claude and the fallback decided, and marks only real changes', () => {
  const { plan } = samplePlan()
  assert.equal(plan.version, 1)
  assert.equal(plan.show, 'attia')
  assert.equal(plan.host, attia.host)
  assert.equal(plan.made_at, MADE_AT)
  assert.deepEqual(plan.counts, { episodes: 3, claude: 2, fallback: 1, no_row: 1, changed: 1 })
  const [one, two, three] = plan.rows
  assert.deepEqual(one.proposed_authors, [attia.host, 'Jane Roe'])
  assert.deepEqual(one.current_authors, [attia.host, 'Jane Roe (#1 rebroadcast)'])
  assert.equal(one.changed, true)
  assert.equal(two.changed, false, 'host only, and host only is already there')
  assert.equal(three.source_id, null)
  assert.equal(three.changed, false, 'no library row: nothing to apply until it is ingested')
  assert.deepEqual(three.proposed_authors, [attia.host, 'Sam Doe'])
})

test('buildPlan records nothing but names: no audio URL, no notes text', () => {
  const { plan } = samplePlan()
  assert.deepEqual(Object.keys(plan.rows[0]).sort(), ['changed', 'current_authors', 'decided_by', 'key', 'proposed_authors', 'reason', 'source_id', 'title'])
  assert.ok(!JSON.stringify(plan).includes('http'))
})

test('parsePlan accepts a plan read back from JSON and rejects other shapes', () => {
  const { plan } = samplePlan()
  assert.deepEqual(parsePlan(JSON.parse(JSON.stringify(plan))), plan)
  for (const bad of [null, 'x', {}, { ...plan, version: 2 }, { ...plan, rows: 'nope' }, { ...plan, show: 5 }]) {
    assert.throws(() => parsePlan(bad), /not a guest plan/, JSON.stringify(bad)?.slice(0, 60))
  }
  const noHost = { ...plan, rows: [{ ...plan.rows[0], proposed_authors: [] }] }
  assert.throws(() => parsePlan(noHost), /malformed/)
  const badAuthors = { ...plan, rows: [{ ...plan.rows[0], proposed_authors: [attia.host, 7] }] }
  assert.throws(() => parsePlan(badAuthors), /malformed/)
})

test('checkPlan: rows still as planned are updated', () => {
  const { plan, rows } = samplePlan()
  const c = checkPlan(plan, attia, byId(rows))
  assert.equal(c.refusal, null)
  assert.deepEqual(c.stale, [])
  assert.deepEqual(c.alreadyApplied, [])
  assert.deepEqual(c.toUpdate.map(r => r.key), ['attia-1'])
})

test('checkPlan: a plan applied twice is a no-op, not an error', () => {
  const { plan, rows } = samplePlan()
  rows[0] = { ...rows[0], authors: [attia.host, 'Jane Roe'] }
  const c = checkPlan(plan, attia, byId(rows))
  assert.deepEqual(c.toUpdate, [])
  assert.deepEqual(c.alreadyApplied.map(r => r.key), ['attia-1'])
  assert.deepEqual(c.stale, [])
})

test('checkPlan: a row corrected by hand since the plan was made is stale, so the plan is not applied', () => {
  const { plan, rows } = samplePlan()
  rows[0] = { ...rows[0], authors: [attia.host, 'Jane Q. Roe'] }
  const c = checkPlan(plan, attia, byId(rows))
  assert.deepEqual(c.toUpdate.map(r => r.key), [])
  assert.equal(c.stale.length, 1)
  assert.equal(c.stale[0].row.key, 'attia-1')
  assert.match(c.stale[0].reason, /changed since the plan/)
})

test('checkPlan: a deleted row, or a row now holding another episode, is stale', () => {
  const { plan, rows } = samplePlan()
  const gone = checkPlan(plan, attia, byId(rows.slice(1)))
  assert.match(gone.stale[0].reason, /no longer exists/)
  const swapped = checkPlan(plan, attia, byId([{ ...rows[0], external_id: 'attia-9' }, rows[1]]))
  assert.match(swapped.stale[0].reason, /external_id attia-9/)
})

test('checkPlan: a plan with no source id, a first author who is not the host, or another show’s key is stale', () => {
  const { plan, rows } = samplePlan()
  const edit = (patch: Partial<GuestPlan['rows'][number]>): GuestPlan => ({ ...plan, rows: [{ ...plan.rows[0], ...patch }, ...plan.rows.slice(1)] })
  assert.match(checkPlan(edit({ source_id: null }), attia, byId(rows)).stale[0].reason, /no source id/)
  assert.match(checkPlan(edit({ proposed_authors: ['Someone Else', 'Jane Roe'] }), attia, byId(rows)).stale[0].reason, /not the host/)
  assert.match(checkPlan(edit({ key: 'fmf-1' }), attia, byId(rows)).stale[0].reason, /not this show/)
})

test('checkPlan refuses a plan from another show', () => {
  const { plan, rows } = samplePlan()
  const c = checkPlan(plan, fmf, byId(rows))
  assert.match(c.refusal ?? '', /plan is for "attia", not "fmf"/)
  assert.deepEqual(c.toUpdate, [])
})

test('checkPlan refuses a plan the run stopped partway through', () => {
  const { plan, rows } = samplePlan()
  const stopped: GuestPlan = { ...plan, stopped: { kind: 'usage-limit', message: 'usage limit reached' } }
  const c = checkPlan(stopped, attia, byId(rows))
  assert.match(c.refusal ?? '', /incomplete/)
  assert.deepEqual(c.toUpdate, [])
})

test('checkPlan touches only the rows the plan changes: an unrelated row that moved on is not its business', () => {
  const { plan, rows } = samplePlan()
  rows[1] = { ...rows[1], authors: [attia.host, 'Hand Edited'] }
  const c = checkPlan(plan, attia, byId(rows))
  assert.equal(c.refusal, null)
  assert.deepEqual(c.stale, [])
  assert.deepEqual(c.toUpdate.map(r => r.key), ['attia-1'])
})

// ---------------------------------------------------------------------------
// The gold set
// ---------------------------------------------------------------------------

test('the gold set is well formed: unique keys, known shows, expected guests never include the host', () => {
  const gold = JSON.parse(readFileSync(resolve('tests/fixtures/guest-gold.json'), 'utf8')) as {
    episodes: { show: string; key: string; title: string; notes: string; expected: string[]; unsure?: boolean }[]
  }
  assert.ok(gold.episodes.length >= 60)
  const keys = new Set<string>()
  for (const g of gold.episodes) {
    const show = showByPrefix(g.show)
    assert.ok(show, `unknown show ${g.show}`)
    assert.ok(g.key.startsWith(`${g.show}-`), g.key)
    assert.ok(!keys.has(g.key), `duplicate ${g.key}`)
    keys.add(g.key)
    assert.ok(g.title && Array.isArray(g.expected))
    for (const name of g.expected) assert.ok(!isHostName(show as Show, name), `${g.key} lists the host ${name}`)
    // Show notes carry public sponsor and donation links; a link with a key in it would be a leaked credential.
    assert.ok(!/[?&](?:key|token|secret|auth|apikey|api_key|sig|signature)=/i.test(g.notes), `${g.key}: notes carry a credential-looking URL`)
    assert.ok(!/\.(?:mp3|m4a|xml|rss)\b/i.test(g.notes), `${g.key}: notes carry an audio or feed URL`)
  }
})
