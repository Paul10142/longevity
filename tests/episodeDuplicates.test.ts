/**
 * Unit tests for lib/episodeDuplicates.ts: the rules that decide whether a feed
 * row is a copy of an episode the library already holds. Pure functions; no
 * database, no network.
 *
 * The titles are the real ones the library shows (The Drive, Huberman Lab,
 * FoundMyFitness), because the rules exist for their exact quirks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  comparePreference,
  decide,
  findOriginal,
  isRepostTitle,
  looksSimilar,
  nonEpisodeFormat,
  parseEpisodeTitle,
  planNewEpisodes,
  sameEpisode,
  type LibraryRow,
} from '../lib/episodeDuplicates'

const DRIVE = 'The Drive'
const HUBERMAN = 'Huberman Lab'

let n = 0
const row = (title: string, extra: Partial<LibraryRow> = {}): LibraryRow => ({
  id: `row-${++n}`,
  title,
  series: DRIVE,
  ...extra,
})

// ── parseEpisodeTitle ─────────────────────────────────────────────────────────

test('parse: leading #N, Ep. N and bare "N -" are the episode number', () => {
  assert.equal(parseEpisodeTitle('#183 - Building & Changing Habits | James Clear').episodeNumber, 183)
  assert.equal(parseEpisodeTitle('Ep. 183: Habits').episodeNumber, 183)
  assert.equal(parseEpisodeTitle('183 - Habits').episodeNumber, 183)
  assert.equal(parseEpisodeTitle('#183 - Habits').numberLeads, true)
})

test('parse: a number inside a rebroadcast marker is the episode number but does not lead', () => {
  const p = parseEpisodeTitle('Building & Changing Habits | James Clear (#183 rebroadcast)')
  assert.equal(p.episodeNumber, 183)
  assert.equal(p.numberLeads, false)
  assert.equal(p.repost, 'rebroadcast')
})

test('parse: an AMA number is never an episode number', () => {
  const p = parseEpisodeTitle('Building strength (AMA #71 rebroadcast)')
  assert.equal(p.amaNumber, 71)
  assert.equal(p.episodeNumber, null)
  const q = parseEpisodeTitle('#349 - AMA #71: Building strength')
  assert.equal(q.episodeNumber, 349)
  assert.equal(q.amaNumber, 71)
})

test('parse: every spelling of a re-post marker is recognised', () => {
  for (const t of [
    'Topic (rebroadcast)',
    'Topic (#12 rebroadcast)',
    'Topic (re-release)',
    'Topic [Rebroadcast]',
    'Rebroadcast: Topic',
    'Topic - Rebroadcast',
  ]) assert.ok(isRepostTitle(t), t)
  assert.equal(isRepostTitle('Topic: how to broadcast your goals'), false)
})

test('parse: Essentials is a prefix, not a word anywhere', () => {
  assert.equal(parseEpisodeTitle('Essentials: How to Sleep Better').essentials, true)
  assert.equal(parseEpisodeTitle('Essentials - How to Sleep Better').essentials, true)
  assert.equal(parseEpisodeTitle('The Essentials of Sleep').essentials, false)
})

test('parse: the comparison key folds case, diacritics and punctuation', () => {
  const a = parseEpisodeTitle('Longevity 101: A Foundational Guide — with Dr. Peter Attia, M.D.')
  const b = parseEpisodeTitle('LONGEVITY 101 a foundational guide with peter attia')
  assert.equal(a.key, b.key)
  assert.equal(parseEpisodeTitle('Café Résumé').key, parseEpisodeTitle('cafe resume').key)
})

// ── sameEpisode ───────────────────────────────────────────────────────────────

test('rule (a): the same episode number is the same episode', () => {
  const a = row('#183 - Building & Changing Habits | James Clear')
  const b = row('Building & Changing Habits | James Clear (#183 rebroadcast)')
  assert.equal(sameEpisode(a, b)?.kind, 'episode-number')
})

test('rule (a): different episode numbers are never duplicates', () => {
  const a = row('#259 - Sleep: the new science | Matt Walker')
  const b = row('#260 - Sleep: the new science | Matt Walker')
  assert.equal(sameEpisode(a, b), null)
})

test('rule (a): the same number on recordings of very different length is left for a person', () => {
  const a = row('#100 - Topic', { media_duration_sec: 3600 })
  const b = row('#100 - Topic again', { media_duration_sec: 9000 })
  assert.equal(sameEpisode(a, b), null)
})

test('rule (a2): the AMA number ties a rebroadcast to the numbered AMA, not to episode #71', () => {
  const ama = row('#349 - AMA #71: Building strength')
  const repost = row('Building strength (AMA #71 rebroadcast)')
  const realSeventyOne = row('#71 - Katherine Eban | The truth about a vaccine')
  assert.equal(sameEpisode(ama, repost)?.kind, 'ama-number')
  assert.equal(sameEpisode(realSeventyOne, repost), null)
})

test('rule (b): the same title without the number is the same episode', () => {
  const a = row('#311 ‒ Longevity 101: a foundational guide to longevity')
  const b = row('Longevity 101: a foundational guide to longevity')
  assert.equal(sameEpisode(a, b)?.kind, 'same-title')
})

test('rule (b): the same words in a different order (Topic | Guest vs Guest: Topic) match', () => {
  const a = row('Optimizing Protein Intake | Dr. Luc van Loon')
  const b = row('Dr. Luc van Loon: Optimizing Protein Intake')
  assert.equal(sameEpisode(a, b)?.kind, 'same-title')
})

test('rule (b): a very short shared title is not enough', () => {
  assert.equal(sameEpisode(row('Sleep'), row('Sleep')), null)
})

test('rule (c): same guests and a length within 2% match when the topics overlap', () => {
  const a = row('Why we sleep: the science of sleep and dreaming', { authors: ['Matt Walker'], media_duration_sec: 7200 })
  const b = row('The science of sleep and dreaming with Matt Walker', { authors: ['Matt Walker'], media_duration_sec: 7250 })
  assert.equal(sameEpisode(a, b)?.kind, 'same-guests-and-length')
})

test('rule (c): same guest and a near-equal length but a different topic is NOT a duplicate (guest series)', () => {
  const a = row('Muscle and strength: part one, the science of hypertrophy', { authors: ['Andy Galpin'], media_duration_sec: 11105 })
  const b = row('Nutrition for athletes: part four, fueling and recovery', { authors: ['Andy Galpin'], media_duration_sec: 11133 })
  assert.equal(sameEpisode(a, b), null)
})

test('rule (c): same guest but lengths more than 2% apart do not match', () => {
  const a = row('The science of sleep and dreaming', { authors: ['Matt Walker'], media_duration_sec: 7200 })
  const b = row('The science of sleep and dreaming, extended', { authors: ['Matt Walker'], media_duration_sec: 8200 })
  assert.equal(sameEpisode(a, b), null)
})

test('rules never cross shows', () => {
  const a = row('#183 - Habits', { series: DRIVE })
  const b = row('#183 - Habits', { series: HUBERMAN })
  assert.equal(sameEpisode(a, b), null)
})

test('the Huberman skin pair (different recordings) is left alone', () => {
  const a = row('How to Improve Skin Health & Appearance', { series: HUBERMAN, media_duration_sec: 8874 })
  const b = row('How to Improve & Protect Your Skin Health & Appearance | Dr. Teo Soleymani', {
    series: HUBERMAN,
    authors: ['Teo Soleymani'],
    media_duration_sec: 9963,
  })
  assert.equal(sameEpisode(a, b), null)
})

test('looksSimilar is advisory: it flags a contained title but sameEpisode does not decide it', () => {
  const a = row('How to Improve Skin Health & Appearance', { series: HUBERMAN })
  const b = row('How to Improve & Protect Your Skin Health & Appearance | Dr. Teo Soleymani', { series: HUBERMAN })
  assert.equal(looksSimilar(a, b), true)
  assert.equal(sameEpisode(a, b), null)
})

// ── choosing the copy to keep ─────────────────────────────────────────────────

test('preference: an already-extracted copy beats a tidier unextracted one', () => {
  const tidy = row('#183 - Habits | James Clear', { created_at: '2026-01-01', facts: 0, processing_status: 'pending' })
  const extracted = row('Habits | James Clear (#183 rebroadcast)', { created_at: '2026-06-01', facts: 217, processing_status: 'succeeded' })
  assert.ok(comparePreference(extracted, tidy) < 0)
})

test('preference: with nothing extracted, the title that leads with the number wins, then the oldest', () => {
  const lead = row('#183 - Habits', { created_at: '2026-06-01' })
  const marker = row('Habits (#183 rebroadcast)', { created_at: '2026-01-01' })
  assert.ok(comparePreference(lead, marker) < 0)
  const older = row('#1 - A', { created_at: '2026-01-01' })
  const newer = row('#1 - A', { created_at: '2026-02-01' })
  assert.ok(comparePreference(older, newer) < 0)
})

test('preference: the answer does not depend on row order', () => {
  const a = row('#5 - X', { id: 'a', created_at: '2026-01-01' })
  const b = row('#5 - X', { id: 'b', created_at: '2026-01-01' })
  assert.ok(comparePreference(a, b) < 0)
  assert.ok(comparePreference(b, a) > 0)
})

// ── decide / findOriginal ─────────────────────────────────────────────────────

test('decide: a rebroadcast of a held episode is skipped with the number in the reason', () => {
  const original = row('#183 - Building & Changing Habits | James Clear', { facts: 217, processing_status: 'succeeded' })
  const d = decide({ title: 'Building & Changing Habits | James Clear (#183 rebroadcast)', series: DRIVE }, [original])
  assert.equal(d.skip, true)
  if (!d.skip) return
  assert.equal(d.category, 're-post')
  assert.equal(d.reason, 'rebroadcast of #183')
  assert.equal(d.original?.row.id, original.id)
})

test('decide: an Essentials cut of a held episode says so, and points at the full episode', () => {
  const full = row('How to Sleep Better', { series: HUBERMAN })
  const d = decide({ title: 'Essentials: How to Sleep Better', series: HUBERMAN }, [full])
  assert.equal(d.skip, true)
  if (!d.skip) return
  assert.match(d.reason, /^re-cut \(Essentials\) of /)
  assert.equal(d.original?.row.id, full.id)
})

test('decide: a re-post with no original in the library is still skipped (full episodes only)', () => {
  const d = decide({ title: 'Essentials: Something We Never Held', series: HUBERMAN }, [])
  assert.equal(d.skip, true)
  if (!d.skip) return
  assert.equal(d.original, null)
  assert.match(d.reason, /full episodes only/)
  const r = decide({ title: 'Topic (re-release)', series: DRIVE }, [])
  assert.equal(r.skip, true)
})

test('decide: a plain new episode is kept', () => {
  assert.deepEqual(decide({ title: '#400 - A brand new topic | Someone', series: DRIVE }, [row('#399 - Another topic')]), { skip: false })
})

test('decide: a plain copy of a held episode is skipped as the same episode', () => {
  const original = row('#311 - Longevity 101: a foundational guide to longevity', { facts: 111, processing_status: 'succeeded' })
  const d = decide({ title: 'Longevity 101: a foundational guide to longevity', series: DRIVE }, [original])
  assert.equal(d.skip, true)
  if (!d.skip) return
  assert.equal(d.category, 'duplicate')
  assert.match(d.reason, new RegExp(`^same episode as ${original.id}`))
})

test('findOriginal: an Essentials cut that stands alone is not the original of a full episode', () => {
  const cut = row('Essentials: How to Sleep Better', { series: HUBERMAN, processing_status: 'skipped', duplicate_of: null })
  assert.equal(findOriginal({ title: 'How to Sleep Better', series: HUBERMAN }, [cut]), null)
})

test('findOriginal: a skipped duplicate resolves to the copy it points at', () => {
  const root = row('#183 - Habits | James Clear', { facts: 217, processing_status: 'succeeded' })
  const skipped = row('Habits | James Clear (#183 rebroadcast)', { processing_status: 'skipped', duplicate_of: root.id })
  const found = findOriginal({ title: 'Habits | James Clear (#183 rebroadcast, again)', series: DRIVE }, [skipped, root])
  assert.equal(found?.row.id, root.id)
})

// ── planNewEpisodes ───────────────────────────────────────────────────────────

test('planNewEpisodes: a rebroadcast listed before its original does not win', () => {
  // A feed lists newest first, so the rebroadcast arrives first.
  const plans = planNewEpisodes(
    [
      { key: 'drive-rebroadcast', title: 'Habits | James Clear (#183 rebroadcast)', series: DRIVE, published_at: '2026-08-01' },
      { key: 'drive-original', title: '#183 - Habits | James Clear', series: DRIVE, published_at: '2023-01-01' },
    ],
    [],
  )
  const byKey = new Map(plans.map(p => [p.episode.key, p]))
  assert.equal(byKey.get('drive-original')?.decision.skip, false)
  const re = byKey.get('drive-rebroadcast')!
  assert.equal(re.decision.skip, true)
  assert.equal(re.originalKey, 'drive-original')
  // Originals are inserted before the copies that point at them.
  assert.ok(plans.findIndex(p => p.episode.key === 'drive-original') < plans.findIndex(p => p.episode.key === 'drive-rebroadcast'))
})

test('planNewEpisodes: two new copies of one episode in the same batch leave exactly one live', () => {
  const plans = planNewEpisodes(
    [
      { key: 'a', title: 'Longevity 101: a foundational guide to longevity', series: DRIVE, published_at: '2026-05-01' },
      { key: 'b', title: '#311 - Longevity 101: a foundational guide to longevity', series: DRIVE, published_at: '2026-04-01' },
    ],
    [],
  )
  assert.equal(plans.filter(p => !p.decision.skip).length, 1)
})

test('planNewEpisodes: a new episode is checked against the library, not only the batch', () => {
  const lib = [row('#183 - Habits | James Clear', { facts: 10, processing_status: 'succeeded' })]
  const [plan] = planNewEpisodes([{ key: 'k', title: 'Habits | James Clear (#183 rebroadcast)', series: DRIVE }], lib)
  assert.equal(plan.decision.skip, true)
  assert.equal(plan.originalKey, null)
  if (plan.decision.skip) assert.equal(plan.decision.original?.row.id, lib[0].id)
})

test('planNewEpisodes: different numbers in one batch stay apart', () => {
  const plans = planNewEpisodes(
    [
      { key: '259', title: '#259 - Sleep | Matt Walker', series: DRIVE },
      { key: '260', title: '#260 - Sleep | Matt Walker', series: DRIVE },
    ],
    [],
  )
  assert.equal(plans.every(p => !p.decision.skip), true)
})

// ── Q&A items are not full episodes (Paul, 2026-11-08) ────────────────────────

test('nonEpisodeFormat: Huberman AMA and live Q&A titles are recognised', () => {
  const h = (title: string) => nonEpisodeFormat({ title, series: HUBERMAN })
  assert.equal(h('AMA #10: Benefits of Nature & “Grounding,” Hearing Loss Research'), 'AMA')
  assert.equal(h('AMA #1: Leveraging Ultradian Cycles, How to Protect Your Brain'), 'AMA')
  assert.equal(h('Ask Me Anything: Sleep, Light and Focus'), 'AMA')
  assert.equal(h('LIVE EVENT Q&A: Dr. Andrew Huberman at the Chicago Theatre'), 'live Q&A')
  assert.equal(h('Dr. Andrew Huberman at the Sydney Opera House | Q&A'), 'live Q&A')
})

test('nonEpisodeFormat: a normal Huberman episode, and every other show, is untouched', () => {
  assert.equal(nonEpisodeFormat({ title: 'How to Improve Your Sleep | Dr. Matt Walker', series: HUBERMAN }), null)
  assert.equal(nonEpisodeFormat({ title: 'Essentials: How to Sleep Better', series: HUBERMAN }), null)
  // The Drive's AMAs are numbered full episodes.
  assert.equal(nonEpisodeFormat({ title: '#127 - AMA #3 with sleep expert, Matthew Walker, Ph.D.: Fasting, gut health', series: DRIVE }), null)
  assert.equal(nonEpisodeFormat({ title: '#04 - AMA #1: alcohol, best lab tests', series: DRIVE }), null)
  // FoundMyFitness Q&A episodes were not part of Paul's answer.
  assert.equal(nonEpisodeFormat({ title: '#053 COVID-19 Q&A #1 with Rhonda Patrick, Ph.D.', series: 'FoundMyFitness' }), null)
})

test('decide: a Huberman AMA is skipped on its own title with no original', () => {
  const d = decide({ title: 'AMA #14: 2023 Philanthropy, Evening Routine, Light Therapy', series: HUBERMAN }, [])
  assert.equal(d.skip, true)
  if (!d.skip) return
  assert.equal(d.category, 'not-a-full-episode')
  assert.equal(d.original, null)
  assert.match(d.reason, /^AMA: full episodes only/)
})

test('decide: a Huberman live Q&A is skipped, a Drive AMA of a held episode is not treated as Q&A', () => {
  const live = decide({ title: 'LIVE EVENT Q&A: Dr. Andrew Huberman at The Wiltern in Los Angeles', series: HUBERMAN }, [])
  assert.equal(live.skip, true)
  if (live.skip) assert.match(live.reason, /^live Q&A: full episodes only/)
  const drive = decide({ title: '#401 - AMA #66: A brand new topic', series: DRIVE }, [row('#400 - AMA #65: Another topic')])
  assert.deepEqual(drive, { skip: false })
})

test('planNewEpisodes: Huberman AMA and Q&A items in a batch are skipped, the full episode beside them is kept', () => {
  const plan = planNewEpisodes(
    [
      { key: 'huberman-gq1', title: 'AMA #20: Something New', series: HUBERMAN },
      { key: 'huberman-gq2', title: 'LIVE EVENT Q&A: Dr. Andrew Huberman in Denver', series: HUBERMAN },
      { key: 'huberman-gfull', title: 'How to Build Muscle | Dr. Someone', series: HUBERMAN },
    ],
    []
  )
  const byKey = new Map(plan.map(p => [p.episode.key, p.decision.skip]))
  assert.equal(byKey.get('huberman-gq1'), true)
  assert.equal(byKey.get('huberman-gq2'), true)
  assert.equal(byKey.get('huberman-gfull'), false)
})

test('preference: when both copies are extracted the one with more facts wins, whatever its title', () => {
  const numbered = row('#349 - AMA #71: Building strength', { processing_status: 'succeeded', facts: 169 })
  const rebroadcast = row('Building strength (AMA #71 rebroadcast)', { processing_status: 'succeeded', facts: 176 })
  assert.ok(comparePreference(rebroadcast, numbered) < 0)
  assert.ok(comparePreference(numbered, rebroadcast) > 0)
})

test('preference: an extracted rebroadcast beats an unextracted original', () => {
  const original = row('#288 - Some topic | Guest')
  const rebroadcast = row('Some topic | Guest (#288 rebroadcast)', { processing_status: 'succeeded', facts: 66 })
  assert.ok(comparePreference(rebroadcast, original) < 0)
})

test('nonEpisodeFormat: the Huberman welcome trailer is skipped, a trailer-like title on another show is not', () => {
  assert.equal(nonEpisodeFormat({ title: 'Welcome to the Huberman Lab Podcast', series: HUBERMAN }), 'trailer')
  assert.equal(nonEpisodeFormat({ title: 'Huberman Lab Premium Trailer', series: HUBERMAN }), 'trailer')
  assert.equal(nonEpisodeFormat({ title: 'Welcome to the Huberman Lab Podcast', series: DRIVE }), null)
  // A full episode that merely starts with "Welcome" is not the trailer.
  assert.equal(nonEpisodeFormat({ title: 'Welcome to the Huberman Lab Podcast: How Sleep Works | Dr. Someone', series: HUBERMAN }), null)
  const d = decide({ title: 'Welcome to the Huberman Lab Podcast', series: HUBERMAN }, [])
  assert.equal(d.skip, true)
  if (d.skip) assert.match(d.reason, /^trailer: full episodes only/)
})

// ── pasted text loses to audio (Paul, 2026-11-08) ─────────────────────────────

test('ranking: a pending audio copy with 0 facts beats a succeeded pasted-text copy with hundreds', () => {
  const text = row('#368 The Protein Debata', { media_type: 'text', processing_status: 'succeeded', facts: 156 })
  const audio = row('#368 ‒ The protein debate | David Allison, Ph.D.', { media_type: 'audio', processing_status: 'pending', facts: 0 })
  assert.ok(comparePreference(audio, text) < 0)
  assert.ok(comparePreference(text, audio) > 0)
})

test('ranking: still-live beats pasted text beats nothing: a skipped audio copy loses to a live text copy', () => {
  const text = row('#368 The Protein Debata', { media_type: 'text', processing_status: 'succeeded', facts: 156 })
  const skippedAudio = row('#368 ‒ The protein debate', { media_type: 'audio', processing_status: 'skipped' })
  assert.ok(comparePreference(text, skippedAudio) < 0)
})

test('ranking: a pasted-text full episode still beats an Essentials cut (the cut is skipped, not kept)', () => {
  const text = row('The Protein Debate', { series: HUBERMAN, media_type: 'text', processing_status: 'succeeded', facts: 50 })
  const cut = row('Essentials: The Protein Debate', { series: HUBERMAN, media_type: 'audio', processing_status: 'pending' })
  assert.ok(comparePreference(text, cut) < 0)
})

test('ranking: between two pasted-text copies the usual rules still apply (more facts wins)', () => {
  const small = row('#368 The Protein Debate', { media_type: 'text', processing_status: 'succeeded', facts: 10 })
  const big = row('#368 The Protein Debate', { media_type: 'text', processing_status: 'succeeded', facts: 90 })
  assert.ok(comparePreference(big, small) < 0)
})

test('ranking: two audio copies are untouched by the new rule (extracted copy with more facts wins)', () => {
  const a = row('#183 Habits', { media_type: 'audio', processing_status: 'succeeded', facts: 217 })
  const b = row('#183 Habits', { media_type: 'audio', processing_status: 'succeeded', facts: 100 })
  assert.ok(comparePreference(a, b) < 0)
})

test('a new audio episode is skipped as a copy of a pasted-text row in the library, unless that row is named by --replace', () => {
  const text = row('#368 The Protein Debata', { media_type: 'text', processing_status: 'succeeded', facts: 156, external_id: 'attia-0368' })
  const feed = { key: 'attia-0368', title: '#368 ‒ The protein debate: optimal intake | David Allison, Ph.D.', series: DRIVE, external_id: 'attia-0368', authors: ['Dr. Peter Attia', 'David Allison, Ph.D.'], media_duration_sec: 6519 }
  // Blocked by default: this is the safety --replace has to opt out of, one named row at a time.
  const blocked = planNewEpisodes([feed], [text])[0]
  assert.equal(blocked.decision.skip, true)
  // --replace takes that one row out of the library the check sees; the audio row is then a plain new episode.
  const replaced = planNewEpisodes([feed], [])[0]
  assert.equal(replaced.decision.skip, false)
})

test('a new audio episode is still skipped as a copy of ANOTHER live audio copy while a text row is replaced', () => {
  const otherAudio = row('#368 ‒ The protein debate: optimal intake', { media_type: 'audio', processing_status: 'pending', external_id: 'attia-g0abcde' })
  const feed = { key: 'attia-0368', title: '#368 ‒ The protein debate: optimal intake | David Allison, Ph.D.', series: DRIVE, external_id: 'attia-0368', authors: ['Dr. Peter Attia'], media_duration_sec: 6519 }
  assert.equal(planNewEpisodes([feed], [otherAudio])[0].decision.skip, true)
})
