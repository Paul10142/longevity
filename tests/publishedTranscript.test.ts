import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alignTurns, detectSpeakers, namesFromTitle, resolveSpeakerAliases, splitTurns, type TimedCaption,
} from '../lib/transcriptAlignment'
import { extractTranscript, pageText, pageTitle, parsePublishedTranscript } from '../lib/publishedTranscript'

// Real text from the two FoundMyFitness episodes that were split wrong at ingest on
// 2026-08 (found 2026-11-08): `luc-van-loon` credited all 87 turns to the host
// because "Luc van Loon:" has a lowercase particle, and `robbins-diamandis` labels
// the host "Dr. Patrick" and one guest "Dr. Diamandis" (neither is the full name),
// with the guests' turns hidden inside one long segment. Turns are shortened to
// their opening words; every label, and the odd text in front of it, is verbatim.

const VAN_LOON = [
  `Rhonda Patrick: I'm delighted to be sitting here with Luc van Loon, who is a professor at Maastricht University in Netherlands.`,
  `Luc van Loon: Thank you for having me, it is great to be here today.`,
  `Rhonda Patrick: Balance until they get older. And then it's harder to stay in the balance if you're not getting enough protein.`,
  `Luc van Loon: If they're losing muscle, they're not in balance. But again, then we're talking about muscle. And with the nitrogen balance, you measure on the whole body level.`,
  `Rhonda Patrick: Okay.`,
  `Luc van Loon: And that's one of the reasons why you can't translate the protein requirements directly to what is happening in the muscle.`,
  `Rhonda Patrick: Well, what about you've done some research on dairy versus plant proteins and the muscle response?`,
  `Rhonda Patrick: Yes.`,
  `Luc van Loon: Correct. Potentially. Right.`,
  `Rhonda Patrick: Yeah.`,
  `Luc van Loon: Absolutely.`,
  `Rhonda Patrick: Well, thank you so much, Luc, for coming on the show and talking about your research.`,
  `Luc van Loon: Thanks for having me.`,
]
// The same turns the publisher's page runs together, hidden labels included.
const VAN_LOON_HIDDEN =
  `Rhonda Patrick: Okay. Luc van Loon: Yes. Rhonda Patrick: Okay. Luc van Loon: That's an absolute yes. ` +
  `Potentially. Luc van Loon: Right. Dairy. Rhonda Patrick: Absolutely. Luc van Loon: Yeah. Rhonda Patrick: Correct. Luc van Loon: Fine.`

const ROBBINS = [
  `Dr. Patrick: Hello, friends. This episode has two amazing, amazing guests who need no introduction, Dr. Peter Diamandis and Tony Robbins.`,
  `Tony Robbins: Well, we've been friends for a long time, but this book came together with us together because I had an accident.`,
  `Dr. Diamandis: Thank you, Rhonda. It is great to be here and talk about longevity.`,
  `Dr. Patrick: Right.`,
  `Tony Robbins: Yamanaka factors.`,
  `Tony Robbins: Exactly.`,
  `Dr. Diamandis: Yes.`,
  `Tony Robbins: Right.`,
  `Dr. Patrick: ...the Yamanaka factors, which for people, you know, listening, these are four different transcription factors. Was it 2006? I [crosstalk 00:38:12]`,
  `Dr. Diamandis: Got the Nobel Prize.`,
  `Tony Robbins: Yeah, got the Nobel Prize.`,
  `Dr. Patrick: For figuring out that these transcription factors if you add them to an adult cell.`,
  `Dr. Diamandis: NR.`,
  `Dr. Patrick: ... NR, you know, can increase NAD levels in humans in the blood.`,
  `Dr. Patrick: Right. Well, I think this is a great place to end this episode. You're on Twitter...`,
  `Dr. Diamandis: Yeah, @PeterDiamandis, on Twitter and Instagram.`,
  `Dr. Diamandis: Absolutely. Yes.`,
  `Dr. Patrick: All right. Thank you so much to you both, and hopefully we'll get together again soon.`,
  `Dr. Diamandis: I look forward to it, Rhonda. Be well. Thank you.`,
]

const VAN_LOON_TITLE = 'Dr. Luc van Loon: Optimizing Protein Intake & Distribution for Muscle Growth'
const ROBBINS_TITLE = 'Peter Diamandis, MD, and Tony Robbins: Strategies that promote longevity now – and in the very near future'

// ---- label detection -------------------------------------------------------------

test('a lowercase particle stays inside the name: "Luc van Loon:" is not "Loon:"', () => {
  const text = [...VAN_LOON, VAN_LOON_HIDDEN].join(' ')
  const speakers = detectSpeakers(text, 5)
  assert.deepEqual([...speakers].sort(), ['Luc van Loon', 'Rhonda Patrick'])
  assert.ok(!speakers.includes('Loon'))
})

test('other surname particles are accepted, and only from the closed list', () => {
  const text =
    `Ursula von der Leyen: One. Anna Maria da Silva: Two. Ursula von der Leyen: Three. Anna Maria da Silva: Four. ` +
    `Ursula von der Leyen: Five. Anna Maria da Silva: Six. Thanks to Rhonda: Seven. Rhonda: Eight.`
  const speakers = detectSpeakers(text, 3)
  assert.deepEqual([...speakers].sort(), ['Anna Maria da Silva', 'Ursula von der Leyen'])
  // "to Rhonda:" must never become "to Rhonda": "to" is not a particle.
  assert.ok(!speakers.some(s => s.toLowerCase().startsWith('to ')))
})

test('single names, honorific names and the existing guards still behave', () => {
  const text =
    `Warning: this is a heading. Rhonda: one. Judith: two. Rhonda: three. Judith: four. Rhonda: five. Judith: six. ` +
    `So. Rhonda: seven. Judith: eight. Dr. Patrick: nine. Dr. Patrick: ten. Dr. Patrick: eleven.`
  const speakers = detectSpeakers(text, 3)
  assert.deepEqual([...speakers].sort(), ['Dr. Patrick', 'Judith', 'Rhonda'])
  assert.ok(!speakers.some(s => /warning|so\./i.test(s)))
})

test('one label alone is a document with headings, not a dialogue', () => {
  assert.deepEqual(detectSpeakers('Luc van Loon: a. Luc van Loon: b. Luc van Loon: c. Luc van Loon: d.', 3), [])
})

// ---- splitting -------------------------------------------------------------------

test('van Loon: every turn gets the right speaker, hidden labels included', () => {
  const text = [...VAN_LOON, VAN_LOON_HIDDEN].join(' ')
  const turns = splitTurns(text, detectSpeakers(text, 5))
  assert.deepEqual([...new Set(turns.map(t => t.speaker))].sort(), ['Luc van Loon', 'Rhonda Patrick'])
  // The hidden labels were split out: no label text is left inside any turn body.
  for (const t of turns) assert.doesNotMatch(t.text, /\b(?:Luc van Loon|Rhonda Patrick):/)
  // 13 turns in the list plus the 8 hidden ones in the run-together block.
  assert.equal(turns.length, 13 + 8 + 1)
  // Alternating speakers, so the interview reads as a conversation.
  assert.equal(turns[0].speaker, 'Rhonda Patrick')
  assert.equal(turns[1].speaker, 'Luc van Loon')
  // The sentence-end swallowed in front of a label stays with the PREVIOUS turn.
  const dairy = turns.find(t => t.text.endsWith('Dairy.'))
  assert.equal(dairy?.speaker, 'Luc van Loon')
})

test('Robbins–Diamandis: "Dr. Patrick" is the host and "Dr. Diamandis" is Peter', () => {
  const text = ROBBINS.join(' ')
  const labels = detectSpeakers(text, 5)
  assert.deepEqual([...labels].sort(), ['Dr. Diamandis', 'Dr. Patrick', 'Tony Robbins'])
  const aliases = resolveSpeakerAliases(labels, ['Rhonda Patrick', ...namesFromTitle(ROBBINS_TITLE)])
  assert.equal(aliases.get('Dr. Patrick'), 'Rhonda Patrick')
  assert.equal(aliases.get('Dr. Diamandis'), 'Peter Diamandis')
  assert.equal(aliases.has('Tony Robbins'), false)
  const turns = splitTurns(text, labels, aliases)
  assert.deepEqual([...new Set(turns.map(t => t.speaker))].sort(), ['Peter Diamandis', 'Rhonda Patrick', 'Tony Robbins'])
  assert.equal(turns.length, ROBBINS.length)
  // "Twitter... Dr. Diamandis:" and "Absolutely. Yes. Dr. Patrick:" are labels, not text.
  const twitter = turns.find(t => t.text.endsWith('Twitter...'))
  assert.equal(twitter?.speaker, 'Rhonda Patrick')
  for (const t of turns) assert.doesNotMatch(t.text, /Dr\. (?:Patrick|Diamandis):/)
})

test('a label that is the tail of another word does not split ("Anthony:" is not "Tony:")', () => {
  const text = 'Tony: a. Anthony: not a label. Judith: b. Tony: c. Judith: d. Tony: e. Judith: f.'
  const turns = splitTurns(text, ['Tony', 'Judith'])
  assert.equal(turns.length, 6)
  assert.match(turns[0].text, /Anthony: not a label/)
})

// ---- aliases ---------------------------------------------------------------------

test('aliases resolve only when exactly one trusted name matches', () => {
  const known = ['Rhonda Patrick', 'Peter Diamandis', 'Tony Robbins']
  const a = resolveSpeakerAliases(['Dr. Patrick', 'Rhonda', 'Peter', 'Robbins', 'Dr. Smith', 'Tony Robbins'], known)
  assert.equal(a.get('Dr. Patrick'), 'Rhonda Patrick')
  assert.equal(a.get('Rhonda'), 'Rhonda Patrick')
  assert.equal(a.get('Peter'), 'Peter Diamandis')
  assert.equal(a.get('Robbins'), 'Tony Robbins')
  assert.equal(a.has('Dr. Smith'), false) // unknown: left exactly as written
  assert.equal(a.has('Tony Robbins'), false)

  // Two trusted names share "Smith": "Dr. Smith" is ambiguous, so it is NOT guessed.
  const ambiguous = resolveSpeakerAliases(['Dr. Smith'], ['Ann Smith', 'Bob Smith'])
  assert.equal(ambiguous.has('Dr. Smith'), false)

  // "Dr. Rhonda Patrick" is the same person as "Rhonda Patrick".
  assert.equal(resolveSpeakerAliases(['Dr. Rhonda Patrick'], known).get('Dr. Rhonda Patrick'), 'Rhonda Patrick')
})

test('names are read from titles: both guests, credentials dropped, the "| Guest" form', () => {
  assert.deepEqual(namesFromTitle(ROBBINS_TITLE), ['Peter Diamandis', 'Tony Robbins'])
  assert.deepEqual(namesFromTitle(VAN_LOON_TITLE), ['Luc van Loon'])
  assert.deepEqual(namesFromTitle('Sulforaphane and cancer | Dr. Jed Fahey'), ['Jed Fahey'])
  assert.deepEqual(namesFromTitle('Sulforaphane: how it works'), [])
})

// ---- the page -------------------------------------------------------------------

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Show note number ${i} describes a study.`).join(' ')

function page(title: string, heading: string, turns: string[]): string {
  return `<html><head><title>${title.replace(/&/g, '&amp;')} | FoundMyFitness</title></head><body>
<nav data-action="click->mobile-navigation#close" class="nav"><a href="/episodes">Episodes</a> <a href="/topics">Topics</a></nav>
<h1>${heading.replace(/&/g, '&amp;')}</h1>
<div class="references" data-controller="toggle" data-action="hashchange@window->toggle#show:prevent toggle:show->scroller#scrollToHash">
<p>${filler(450)}</p></div>
<div class="hidden" data-tab-pane-target="content">
  <div class="container"><div class='episode_tabs-content'>
${turns.map(t => `    <p>${t.replace(/'/g, '&#39;')}</p>`).join('\n')}
  </div>
</div>
</div>
<div class="hidden" data-tab-pane-target="content">
  <div class="episode_tabs-content"><div class="font-bold">Ad libitum</div><p>Latin for &quot;at one&#39;s pleasure&quot;. ${filler(40)}</p></div>
</div>
</body></html>`
}

test('the page heading is not mistaken for the transcript: it starts at the first spoken turn', () => {
  const html = page(VAN_LOON_TITLE, VAN_LOON_TITLE, [...VAN_LOON, VAN_LOON_HIDDEN])
  // The heading "Dr. Luc van Loon: Optimizing…" is itself a label hit, 20,000+ characters before the transcript.
  const text = pageText(html)
  assert.ok(text.indexOf('Luc van Loon: Optimizing') < 400)
  const out = extractTranscript(html, ['Rhonda Patrick', 'Luc van Loon'])
  assert.ok(out.startsWith("Rhonda Patrick: I'm delighted to be sitting here"), out.slice(0, 80))
  assert.ok(out.endsWith('Luc van Loon: Fine.'), out.slice(-80))
  assert.doesNotMatch(out, /Show note number|Ad libitum|Episodes Topics/)
})

test('no tag residue survives: an arrow inside an attribute does not leave text behind', () => {
  const html = page(VAN_LOON_TITLE, VAN_LOON_TITLE, [...VAN_LOON, VAN_LOON_HIDDEN])
  const text = pageText(html)
  assert.doesNotMatch(text, /data-tab-pane-target|toggle#show|scroller#scrollToHash|mobile-navigation#close|data-action/)
  // The exact fragment found at the front of all 17 stored FoundMyFitness transcripts.
  const junk = `<p>" data-tab-pane-target="content"> Rhonda Patrick: Hello there.</p>`
  assert.doesNotMatch(pageText(junk), /data-tab-pane-target/)
  assert.match(pageText(junk), /^Rhonda Patrick: Hello there\.$/)
})

test('a first segment of tag residue is stripped even when it reaches the text stage', () => {
  const out = pageText(`<div>&quot; data-tab-pane-target=&quot;content&quot;&gt; Rhonda Patrick: Hello.</div>`)
  assert.equal(out, 'Rhonda Patrick: Hello.')
})

test('van Loon page: speakers, authors, and every aligned segment starts with its label', () => {
  const html = page(VAN_LOON_TITLE, VAN_LOON_TITLE, [...VAN_LOON, VAN_LOON_HIDDEN])
  const p = parsePublishedTranscript(html, { title: pageTitle(html), host: 'Rhonda Patrick' })
  assert.equal(pageTitle(html), VAN_LOON_TITLE)
  assert.deepEqual([...p.speakers].sort(), ['Luc van Loon', 'Rhonda Patrick'])
  assert.deepEqual(p.authors, ['Rhonda Patrick', 'Luc van Loon'])
  assert.equal(p.turns.length, 13 + 8 + 1)
  assertAlignsWithLabels(p.turns, p.speakers)
})

test('Robbins–Diamandis page: three speakers under their full names, host first', () => {
  const html = page(ROBBINS_TITLE, ROBBINS_TITLE, ROBBINS)
  const p = parsePublishedTranscript(html, { title: pageTitle(html), host: 'Rhonda Patrick' })
  assert.deepEqual([...p.speakers].sort(), ['Peter Diamandis', 'Rhonda Patrick', 'Tony Robbins'])
  assert.deepEqual(p.authors[0], 'Rhonda Patrick')
  assert.deepEqual([...p.authors].sort(), ['Peter Diamandis', 'Rhonda Patrick', 'Tony Robbins'])
  assert.equal(p.turns.length, ROBBINS.length)
  assert.ok(p.transcript.startsWith('Dr. Patrick: Hello, friends.'))
  assertAlignsWithLabels(p.turns, p.speakers)
})

test('a page with no labelled dialogue yields no transcript (the episode is skipped, not half-ingested)', () => {
  const html = `<html><body><h1>Heat: a topic</h1><p>${filler(300)}</p></body></html>`
  const p = parsePublishedTranscript(html, { title: 'Heat: a topic', host: 'Rhonda Patrick' })
  assert.equal(p.transcript, '')
  assert.equal(p.turns.length, 0)
})

/** Captions that reproduce the transcript words, timed every 12 words — enough to prove the labels survive alignment. */
function assertAlignsWithLabels(turns: { speaker: string | null; text: string }[], speakers: string[]) {
  const words = turns.flatMap(t => t.text.split(/\s+/))
  const captions: TimedCaption[] = []
  for (let i = 0; i < words.length; i += 12) captions.push({ start_ms: (i / 12) * 4000, text: words.slice(i, i + 12).join(' ') })
  const { timed, coverage } = alignTurns(turns, captions)
  assert.ok(coverage >= 0.8, `coverage ${coverage}`)
  assert.equal(timed.length, turns.length)
  for (const seg of timed) {
    assert.ok(seg.speaker, 'every segment has a speaker')
    assert.ok(seg.text.startsWith(`${seg.speaker}: `), seg.text.slice(0, 40))
    assert.ok(speakers.includes(seg.speaker!))
  }
  // Timing only moves forward.
  for (let i = 1; i < timed.length; i++) assert.ok(timed[i].start_ms >= timed[i - 1].start_ms)
}
