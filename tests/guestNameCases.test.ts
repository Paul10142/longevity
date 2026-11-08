/**
 * The cases the first credentials PR left open (Paul, 2026-11-08): a short first name
 * the model writes longer (`Bill` / `William`), a surname only the notes give (`Dr.
 * Darya` / `Darya Rose`), a pseudonymous guest who keeps his channel name, the list of
 * guest lists a person set by hand, and the per-batch step that reads only unread rows.
 * The model is a stub; nothing here touches Claude, the database or the network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPlan,
  channelAliasForm,
  checkPlan,
  fallbackGuests,
  fullerName,
  isUnreadRow,
  overrideDecision,
  parsePlan,
  pseudonymForm,
  resolveGuests,
  validateGuests,
  withOverrides,
  type GuestEpisode,
  type GuestLlm,
  type SourceRow,
} from '../lib/guestNames'
import { GUEST_OVERRIDES, overridesByKey } from '../lib/guestOverrides'
import { bareName, isCredentialOnly } from '../lib/personName'
import { isHostName, showByPrefix, SHOWS, type Show } from '../lib/shows'

const attia = showByPrefix('attia') as Show
const fmf = showByPrefix('fmf') as Show

const ep = (id: string, title: string, description: string | null = null): GuestEpisode => ({ id, title, description })

const T068 = '#068 Dr. Bill Harris on the Omega-3 Index: Increasing Omega-3 to Promote Longevity & Transform Health'
const T019 = '#019 Dr. Darya and Kevin Rose Talk Meditation Retreats, Diet, Seasonal Eating, and More'
const N019 = 'In this episode Darya Rose and Kevin Rose join Rhonda Patrick to talk about meditation retreats and diet.'
const T274 = '#274 - Performance-enhancing drugs and hormones: risks, rewards, and broader implications for the public | Derek: More Plates, More Dates'
const T291 = '#291 ‒ The role of testosterone in males and females, performance-enhancing drugs, sustainable fat loss, supplements, and more | Derek, More Plates More Dates Pt.2'

function guestsOf(show: Show, e: GuestEpisode, proposed: string[]): string[] {
  const v = validateGuests(show, e, proposed)
  assert.ok(v.ok, v.ok ? '' : v.reason)
  return v.ok ? v.guests : []
}

// ---------------------------------------------------------------------------
// 1. A short first name takes the title's spelling BEFORE the appears-in-text check
// ---------------------------------------------------------------------------

test('William Harris is accepted as the title\'s Dr. Bill Harris, not rejected for being absent from the text', () => {
  assert.deepEqual(guestsOf(fmf, ep('fmf-0068', T068), ['William Harris']), ['Dr. Bill Harris'])
  assert.deepEqual(guestsOf(fmf, ep('fmf-0068', T068), ['Dr. William Harris']), ['Dr. Bill Harris'])
  assert.deepEqual(guestsOf(fmf, ep('fmf-0068', T068), ['Bill Harris']), ['Dr. Bill Harris'])
})

test('the rule that a name must appear in the title or notes still holds', () => {
  const v = validateGuests(fmf, ep('fmf-0001', 'Sleep with Matt Walker'), ['William Harris'])
  assert.equal(v.ok, false)
  assert.match(v.ok ? '' : v.reason, /not in the title or description/)
  // Same surname, a different first name that is not a short form of it: not the title's person.
  const w = validateGuests(fmf, ep('fmf-0001', T068), ['Alice Harris'])
  assert.equal(w.ok, false)
})

// ---------------------------------------------------------------------------
// 2. The surname the title leaves off comes from the notes, with the title's Dr.
// ---------------------------------------------------------------------------

test('Dr. Darya in the title and Darya Rose in the notes is Dr. Darya Rose', () => {
  const e = ep('fmf-0019', T019, N019)
  assert.deepEqual(guestsOf(fmf, e, ['Dr. Darya', 'Kevin Rose']), ['Dr. Darya Rose', 'Kevin Rose'])
  assert.deepEqual(guestsOf(fmf, e, ['Darya', 'Kevin Rose']), ['Dr. Darya Rose', 'Kevin Rose'])
  assert.deepEqual(guestsOf(fmf, e, ['Darya Rose', 'Kevin Rose']), ['Dr. Darya Rose', 'Kevin Rose'])
})

test('fullerName only extends a first name the notes complete the same way every time', () => {
  // Notes complete it: yes.
  assert.equal(fullerName('Darya', ep('x', T019, N019)), 'Darya Rose')
  // Title Case in the title does not make `Matt Talks` a name: only the notes are read.
  assert.equal(fullerName('Matt', ep('x', 'Matt Talks Sleep And Memory', 'Matt Walker joins the host.')), 'Matt Walker')
  assert.equal(fullerName('Matt', ep('x', 'Matt Talks Sleep And Memory', 'Nothing about him here.')), 'Matt')
  // Two different continuations: ambiguous, so the first name stays.
  assert.equal(fullerName('Matt', ep('x', 'Matt on sleep', 'Matt Walker and Matt Damon are not the same person.')), 'Matt')
  // Punctuation or a lower-case word after the first name means a pseudonym or a channel, not a surname.
  assert.equal(fullerName('Derek', ep('x', 'Topic | Derek from MPMD', 'Derek from More Plates More Dates joins.')), 'Derek')
  assert.equal(fullerName('Derek', ep('x', 'Topic | Derek: More Plates', 'Derek: More Plates, More Dates joins.')), 'Derek')
  // A two-word name is already whole.
  assert.equal(fullerName('Kevin Rose', ep('x', T019, N019)), 'Kevin Rose')
})

// ---------------------------------------------------------------------------
// 3. A pseudonymous guest keeps the channel name the show attaches
// ---------------------------------------------------------------------------

test('pseudonymForm writes the first name, a comma and the channel, and nothing else qualifies', () => {
  assert.equal(pseudonymForm('Derek: More Plates, More Dates'), 'Derek, More Plates More Dates')
  assert.equal(pseudonymForm('Derek, More Plates More Dates Pt.2'), 'Derek, More Plates More Dates')
  assert.equal(pseudonymForm('Derek, More Plates More Dates'), 'Derek, More Plates More Dates')
  assert.equal(pseudonymForm('Derek - More Plates More Dates (Part II)'), 'Derek, More Plates More Dates')
  for (const no of ['Derek', 'Derek from MPMD', 'Derek, MPMD', 'Sam, M.D.', 'Sam Doe, M.D.', 'Pat Lee, Ph.D.', 'Jane Roe, Acme Fitness', 'Derek, more plates more dates']) {
    assert.equal(pseudonymForm(no), null, no)
  }
})

test('Drive #274 and #291: the guest is Derek, More Plates More Dates, however the model punctuates it', () => {
  const e274 = ep('attia-0274', T274)
  for (const said of ['Derek, More Plates More Dates', 'Derek: More Plates, More Dates', 'Derek, More Plates, More Dates']) {
    assert.deepEqual(guestsOf(attia, e274, [said]), ['Derek, More Plates More Dates'], said)
  }
  const e291 = ep('attia-0291', T291)
  for (const said of ['Derek, More Plates More Dates Pt.2', 'Derek, More Plates More Dates']) {
    assert.deepEqual(guestsOf(attia, e291, [said]), ['Derek, More Plates More Dates'], said)
  }
  // The channel travels like a credential: the speaker label is the bare first name, `authors` holds the whole.
  assert.equal(bareName('Derek, More Plates More Dates'), 'Derek')
  assert.equal(isCredentialOnly('More Plates More Dates'), false)
})

const T106 = '#106 How To Increase Your Testosterone Levels Naturally | Derek from MPMD'
const N106 = 'In this episode, Derek from More Plates More Dates highlights common pitfalls that suppress testosterone.'

test('FoundMyFitness #106: Derek from MPMD is the same Derek, written with the channel (Paul, 2026-11-08)', () => {
  const e106 = ep('fmf-0106', T106, N106)
  for (const said of ['Derek', 'Derek from MPMD']) {
    assert.deepEqual(guestsOf(fmf, e106, [said]), ['Derek, More Plates More Dates'], said)
  }
  // Only the title carries the initials: the same result.
  assert.deepEqual(guestsOf(fmf, ep('fmf-0106', T106), ['Derek']), ['Derek, More Plates More Dates'])
  // The channel written out after "from" in the notes is enough on its own.
  assert.deepEqual(guestsOf(fmf, ep('fmf-0106', 'Testosterone Naturally', N106), ['Derek']), ['Derek, More Plates More Dates'])
  // Two ways of saying one guest are one guest.
  assert.deepEqual(guestsOf(fmf, e106, ['Derek', 'Derek from MPMD']), ['Derek, More Plates More Dates'])
})

test('channelAliasForm only joins a first name to a confirmed channel the text writes beside it', () => {
  assert.equal(channelAliasForm('Derek', 'Topic | Derek (MPMD)'), 'Derek, More Plates More Dates')
  assert.equal(channelAliasForm('Derek', 'Topic | Derek, MPMD'), 'Derek, More Plates More Dates')
  // No channel beside the name: left to the normal path.
  assert.equal(channelAliasForm('Derek', 'Topic | Derek'), null)
  // The initials are in the text but beside someone else.
  assert.equal(channelAliasForm('Sam', 'Topic | Derek from MPMD'), null)
  // A surname, a credential, a channel nobody confirmed, other initials.
  assert.equal(channelAliasForm('Derek Smith', 'Topic | Derek Smith from MPMD'), null)
  assert.equal(channelAliasForm('Derek, M.D.', 'Topic | Derek from MPMD'), null)
  assert.equal(channelAliasForm('Derek from XYZ', 'Topic | Derek from XYZ'), null)
  assert.equal(channelAliasForm('Derek from MPMD', 'Topic | Derek from XYZ'), null)
  // A lower-case look-alike is not the initials.
  assert.equal(channelAliasForm('Derek', 'Topic | Derek from mpmd'), null)
})

test('a channel the text does not hold next to the first name is still rejected', () => {
  const v = validateGuests(attia, ep('attia-0274', T274), ['Derek, Some Other Channel'])
  assert.equal(v.ok, false)
})

// ---------------------------------------------------------------------------
// 5. The hand-set list
// ---------------------------------------------------------------------------

test('every override is well formed: a registered show, a four-digit key, a unique key, real names, never the host', () => {
  const prefixes = SHOWS.map(s => s.prefix)
  const seen = new Set<string>()
  for (const o of GUEST_OVERRIDES) {
    const m = /^([a-z]+)-(\d{4})$/.exec(o.key)
    assert.ok(m, `${o.key} is not a feed key`)
    assert.ok(prefixes.includes((m as RegExpExecArray)[1]), `${o.key}: unknown show`)
    assert.ok(!seen.has(o.key), `${o.key} listed twice`)
    seen.add(o.key)
    assert.ok(o.why.length > 20, `${o.key}: say who decided and why`)
    const show = showByPrefix((m as RegExpExecArray)[1]) as Show
    for (const g of o.guests) {
      assert.ok(g.trim().length > 1 && !isCredentialOnly(g), `${o.key}: "${g}" is not a name`)
      assert.ok(!isHostName(show, g), `${o.key}: "${g}" is the host, who is added by the plan`)
    }
    assert.equal(new Set(o.guests).size, o.guests.length, `${o.key}: a guest listed twice`)
  }
})

test('the override list holds the rows Paul confirmed on 2026-11-08', () => {
  const by = overridesByKey()
  assert.deepEqual(by.get('fmf-0108')?.guests, ['Brady Holmer'])
  assert.deepEqual(by.get('fmf-0098')?.guests, ['Brady Holmer'])
  assert.deepEqual(by.get('fmf-0044')?.guests, ['Mike Maser'])
  assert.deepEqual(by.get('fmf-0052')?.guests, ['Kevin Rose'])
  assert.deepEqual(by.get('fmf-0068')?.guests, ['Dr. Bill Harris'])
  assert.deepEqual(by.get('fmf-0019')?.guests, ['Dr. Darya Rose', 'Kevin Rose'])
  assert.deepEqual(by.get('fmf-0069')?.guests, ['Roger Seheult', 'Kyle Allred'])
  assert.deepEqual(by.get('fmf-0073')?.guests, ['Kyle Allred'])
  assert.deepEqual(by.get('fmf-0106')?.guests, ['Derek, More Plates More Dates'])
  assert.deepEqual(by.get('attia-0274')?.guests, ['Derek, More Plates More Dates'])
  assert.deepEqual(by.get('attia-0291')?.guests, ['Derek, More Plates More Dates'])
})

test('resolveGuests does not ask the model about a hand-set episode, and says so', async () => {
  const asked: string[] = []
  const llm: GuestLlm = async (_system, user) => {
    asked.push(user)
    return { episodes: [{ id: 'fmf-0200', guests: ['Jane Roe'] }] }
  }
  const r = await resolveGuests(fmf, [ep('fmf-0108', '#108 Something | Dr. Brady Holmer'), ep('fmf-0200', 'X | Jane Roe')], llm)
  assert.equal(asked.length, 1)
  assert.ok(!asked[0].includes('fmf-0108'), 'the hand-set episode was not sent to the model')
  assert.ok(asked[0].includes('fmf-0200'))
  const d = r.decisions.get('fmf-0108')
  assert.deepEqual(d?.guests, ['Brady Holmer'])
  assert.equal(d?.decided_by, 'override')
  assert.match(d?.reason ?? '', /set by hand/)
  assert.equal(r.decisions.get('fmf-0200')?.decided_by, 'claude')
})

test('a run where every episode is hand-set makes no model call at all', async () => {
  const llm: GuestLlm = async () => { throw new Error('the model must not be called') }
  const r = await resolveGuests(fmf, [ep('fmf-0073', '#073 Sauna with Dr. Rhonda Patrick & MedCram')], llm)
  assert.deepEqual(r.decisions.get('fmf-0073')?.guests, ['Kyle Allred'])
  assert.equal(r.batches.total, 0)
})

function planWith(rowAuthors: Record<string, string[] | null>, decided: Record<string, string[]>) {
  const keys = Object.keys(rowAuthors)
  const episodes = keys.map(k => ep(k, `${k} title`))
  const decisions = new Map(keys.map(k => [k, { guests: decided[k] ?? [], decided_by: 'claude' as const, reason: 'x' }]))
  const rows = new Map<string, SourceRow>()
  keys.forEach((k, i) => { if (rowAuthors[k] !== undefined) rows.set(k, { id: `src-${i}`, external_id: k, authors: rowAuthors[k] }) })
  const plan = buildPlan({ show: fmf, episodes, decisions, rowsByKey: rows, model: 'm', madeAt: '2026-11-08T12:00:00.000Z', stopped: null })
  return { plan, rows }
}
const byId = (rows: Map<string, SourceRow>) => new Map([...rows.values()].map(r => [r.id, r]))

test('withOverrides writes the hand-set list over an older plan that proposed host only', () => {
  const { plan } = planWith({ 'fmf-0044': [fmf.host], 'fmf-0300': [fmf.host] }, { 'fmf-0044': [], 'fmf-0300': ['Jane Roe'] })
  assert.equal(plan.rows[0].changed, false, 'the old plan proposed host only, which is what the row holds')
  const { plan: next, replaced } = withOverrides(plan, fmf)
  assert.equal(replaced.length, 1)
  assert.deepEqual(next.rows[0].proposed_authors, [fmf.host, 'Mike Maser'])
  assert.equal(next.rows[0].decided_by, 'override')
  assert.equal(next.rows[0].changed, true)
  assert.equal(next.rows[1], plan.rows[1], 'a row with no override is the same object')
  assert.equal(next.counts.override, 1)
  assert.equal(next.counts.changed, 2)
  // And the plan stays a valid plan file.
  assert.doesNotThrow(() => parsePlan(JSON.parse(JSON.stringify(next))))
})

test('after withOverrides the stale-plan guard still protects a row someone changed since the plan', () => {
  const { plan, rows } = planWith({ 'fmf-0044': [fmf.host] }, { 'fmf-0044': [] })
  const { plan: next } = withOverrides(plan, fmf)
  assert.deepEqual(checkPlan(next, fmf, byId(rows)).toUpdate.map(r => r.key), ['fmf-0044'])

  const hand = new Map(rows)
  hand.set('fmf-0044', { ...(rows.get('fmf-0044') as SourceRow), authors: [fmf.host, 'Somebody Else'] })
  const stale = checkPlan(next, fmf, byId(hand))
  assert.equal(stale.toUpdate.length, 0)
  assert.equal(stale.stale.length, 1)

  const done = new Map(rows)
  done.set('fmf-0044', { ...(rows.get('fmf-0044') as SourceRow), authors: [fmf.host, 'Mike Maser'] })
  const again = checkPlan(next, fmf, byId(done))
  assert.deepEqual(again.alreadyApplied.map(r => r.key), ['fmf-0044'])
})

test('a row already holding the hand-set list is not rewritten', () => {
  const { plan } = planWith({ 'fmf-0044': [fmf.host, 'Mike Maser'] }, { 'fmf-0044': [] })
  const { plan: next } = withOverrides(plan, fmf)
  assert.equal(next.rows[0].changed, false)
})

test('overrideDecision gives the plan a reason a reader can follow', () => {
  const d = overrideDecision({ key: 'fmf-0001', guests: ['Jane Roe'], why: 'set by hand, confirmed by Paul 2026-11-08' })
  assert.deepEqual(d.guests, ['Jane Roe'])
  assert.equal(d.decided_by, 'override')
  assert.match(d.reason, /lib\/guestOverrides\.ts/)
})

// ---------------------------------------------------------------------------
// 4. The per-batch step reads only the rows nobody has read
// ---------------------------------------------------------------------------

test('isUnreadRow: a freshly ingested, not yet extracted row whose guests are the title rule\'s', () => {
  const title = 'A | Jane Roe'
  const fb = fallbackGuests(attia, title)
  assert.ok(fb.length > 0)
  const fresh = { id: 'a', external_id: 'attia-0500', authors: [attia.host, ...fb], processing_status: 'pending' }
  assert.equal(isUnreadRow(attia, fresh, title), true)
  assert.equal(isUnreadRow(attia, { ...fresh, processing_status: null }, title), true)
})

test('isUnreadRow leaves alone an extracted row, a corrected row and a row with no authors', () => {
  const title = 'A | Jane Roe'
  const fb = fallbackGuests(attia, title)
  const fresh = { id: 'a', external_id: 'attia-0500', authors: [attia.host, ...fb], processing_status: 'pending' }
  assert.equal(isUnreadRow(attia, { ...fresh, processing_status: 'succeeded' }, title), false)
  assert.equal(isUnreadRow(attia, { ...fresh, authors: [attia.host, 'Somebody Corrected'] }, title), false)
  assert.equal(isUnreadRow(attia, { ...fresh, authors: [attia.host] }, title), false)
  assert.equal(isUnreadRow(attia, { ...fresh, authors: null }, title), false)
  assert.equal(isUnreadRow(attia, { ...fresh, authors: ['Not The Host', ...fb] }, title), false)
})

test('isUnreadRow counts a title-rule row whose credentials were attached as unread, and a row with no guest in the title too', () => {
  const t = '#200 Topic | Jane Roe, M.D.'
  const fb = fallbackGuests(attia, t)
  assert.equal(isUnreadRow(attia, { id: 'a', external_id: 'attia-0200', authors: [attia.host, ...fb], processing_status: 'pending' }, t), true)
  const solo = 'AMA #50: a solo episode'
  assert.equal(isUnreadRow(attia, { id: 'b', external_id: 'attia-0050', authors: [attia.host], processing_status: 'pending' }, solo), true)
})
