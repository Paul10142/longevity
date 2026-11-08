/**
 * Turn a publisher's transcript page (FoundMyFitness today) into labelled turns.
 *
 * Split out of scripts/ingestFoundMyFitness.ts on 2026-11-08 so the parts that
 * decide WHO SAID WHAT can be tested against real episode text: the script runs
 * `main()` on import and cannot be loaded from a test.
 *
 * The page is stripped to text, the speaker labels are found in it, and the
 * transcript is the span from the first label to the last. Everything here is
 * pure: no network, no database.
 */
import { detectSpeakers, namesFromTitle, resolveSpeakerAliases, splitTurns, type Turn } from './transcriptAlignment'

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/**
 * A tag, allowing `>` inside quoted attribute values.
 *
 * The first stripper was `<[^>]+>`, which ends a tag at the FIRST `>` — and
 * FoundMyFitness markup has `data-action="hashchange@window->toggle#show"`, an arrow
 * inside an attribute. The rest of such a tag was left behind as text, e.g.
 * `" data-tab-pane-target="content">`, and became the first segment of every one
 * of the 17 ingested episodes (2026-11-08). This pattern walks quoted values whole.
 */
const TAG = /<[a-zA-Z/!][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g

/**
 * Belt and braces: the tail of a tag that still slipped through, `attribute="value">`.
 * It is never transcript speech, so it is removed wherever it appears.
 */
const TAG_RESIDUE = /"?\s*[\w:@.-]+=(?:"[^"]*"|'[^']*')\s*>/g

/** Closing tags that end a block of content. Kept as a marker so the transcript's END can be found. */
const BLOCK_CLOSE = /<\/(?:div|section|article|ul|ol|table|h[1-6])\s*>/gi
const BLOCK_END = '\u001f'

/** Page HTML → plain text with BLOCK_END markers where a block closed. */
function textWithBlocks(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(BLOCK_CLOSE, BLOCK_END)
    .replace(TAG, ' ')
  return decodeEntities(cleaned).replace(TAG_RESIDUE, ' ').replace(/[ \t\r\n\f\v\u00a0]+/g, ' ')
}

const collapse = (s: string) => s.replace(new RegExp(BLOCK_END, 'g'), ' ').replace(/\s+/g, ' ').trim()

/** Page HTML → plain text: scripts, styles and tags dropped, entities decoded, whitespace collapsed. */
export function pageText(html: string): string {
  return collapse(textWithBlocks(html))
}

/** Largest gap, in characters, between two labels of the SAME transcript. A stretch longer than this
 *  with no label is a different part of the page (the longest real gap seen is about 5,400). */
const MAX_LABEL_GAP = 12_000
/** The final turn is cut at its container's end, and never longer than this. */
const MAX_LAST_TURN = 6_000

/**
 * The transcript, located by its SPEAKER LABELS rather than by markup.
 *
 * The first version split the HTML on `<div class="…hidden` and took the largest
 * fragment. That is not parsing — string-splitting a document fragments it at
 * arbitrary points, and the "largest pane" it produced was 55k characters of
 * something else entirely. It reported that most episodes publish no transcript;
 * a browser reading the same page found 228k characters and 379 speaker labels.
 * The site was fine. The parser was wrong.
 *
 * So: take the text of the WHOLE page and find where the labels are densest.
 *
 * Not simply "first label to last label". Once "Luc van Loon:" was a recognised
 * label, the page's own heading — "Dr. Luc van Loon: Optimizing Protein Intake" —
 * was the first hit, and the transcript swallowed the navigation bar, the show
 * notes and the reference list (122k characters became 149k, and alignment
 * coverage fell from 100% to 35%). Labels of one transcript are never more than a
 * few thousand characters apart; a heading and the transcript are 20,000+ apart.
 * So the hits are grouped by distance, the largest group is the transcript, and
 * its last turn ends where the block that holds it closes.
 */
export function extractTranscript(html: string, speakers: string[]): string {
  if (speakers.length === 0) return ''
  const body = textWithBlocks(html)
  const alt = speakers.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`(?<![A-Za-z])(?:${alt}):\\s`, 'g')
  const hits = [...body.matchAll(re)].map(m => m.index ?? 0)
  if (hits.length === 0) return ''

  const groups: number[][] = [[hits[0]]]
  for (let i = 1; i < hits.length; i++) {
    if (hits[i] - hits[i - 1] > MAX_LABEL_GAP) groups.push([])
    groups[groups.length - 1].push(hits[i])
  }
  const best = groups.reduce((a, g) => (g.length > a.length ? g : a))
  if (best.length < 5) return ''

  const first = best[0]
  const last = best[best.length - 1]
  const blockEnd = body.indexOf(BLOCK_END, last)
  const end = Math.min(blockEnd === -1 ? body.length : blockEnd, last + MAX_LAST_TURN)
  return collapse(body.slice(first, end))
}

export function pageTitle(html: string): string {
  const m = html.match(/<title>([^<]{3,200})<\/title>/i)
  return m ? decodeEntities(m[1]).replace(/\s*\|\s*FoundMyFitness\s*$/i, '').trim() : ''
}

/** `Episode topic | Dr. Guest Name` → the guest. Last resort when no guest speaks under a label. */
function guestFromTitleTail(title: string): string[] {
  if (!title.includes('|')) return []
  const tail = title.split('|').pop()?.trim() ?? ''
  const name = tail.replace(/^(dr\.?|prof\.?)\s+/i, '').trim()
  return name.length > 2 && /^[A-Z]/.test(name) ? [name] : []
}

export type ParsedTranscript = {
  /** Every label detected on the page (min 5 uses), as written. */
  labels: string[]
  /** label → canonical speaker, only where they differ ("Dr. Patrick" → "Rhonda Patrick"). */
  aliases: Map<string, string>
  transcript: string
  turns: Turn[]
  /** Canonical speakers that actually have a turn, in order of first appearance. */
  speakers: string[]
  /** [host, ...guests]: what `sources.authors` should hold. */
  authors: string[]
}

/**
 * Page HTML → turns with canonical speaker names.
 *
 * `title` is the page title (names in it help resolve short labels); `host` is the
 * show's host, who is the first author whether or not they speak under that name.
 * `transcript` is '' when the page has no usable labelled transcript — the caller
 * decides what that means (skip the episode).
 */
export function parsePublishedTranscript(html: string, opts: { title: string; host: string }): ParsedTranscript {
  const labels = detectSpeakers(pageText(html), 5)
  const transcript = extractTranscript(html, labels)
  const fullLabels = labels.filter(l => /^[A-Z]/.test(l) && !/^(?:dr|prof|mr|mrs|ms)\.?\s/i.test(l) && l.includes(' '))
  const aliases = resolveSpeakerAliases(labels, [opts.host, ...namesFromTitle(opts.title), ...fullLabels])
  const turns = transcript ? splitTurns(transcript, labels, aliases) : []
  const speakers: string[] = []
  for (const t of turns) if (t.speaker && !speakers.includes(t.speaker)) speakers.push(t.speaker)
  let guests = speakers.filter(s => s !== opts.host)
  if (guests.length === 0) guests = guestFromTitleTail(opts.title)
  return { labels, aliases, transcript, turns, speakers, authors: [opts.host, ...guests] }
}
