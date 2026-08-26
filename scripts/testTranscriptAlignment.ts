/**
 * Can a published transcript that has NO timestamps be pinned to a timeline
 * using the YouTube captions of the same episode?
 *
 *   npx tsx --env-file=.env.local scripts/testTranscriptAlignment.ts --n 3
 *
 * Read-only: fetches, measures, prints. Writes nothing.
 *
 * THE IDEA (product owner's, 2026-08-25). FoundMyFitness publishes accurate,
 * speaker-labelled transcripts with no per-turn timing, which would leave any
 * claim extracted from them unable to deep-link to the moment it was said.
 * YouTube's auto-captions for the same episode are the mirror image: sloppy
 * words, but timestamped every few seconds. Align the two and each supplies what
 * the other lacks — accurate text and real speakers WITH timing, for free.
 *
 * WHAT IS ACTUALLY BEING MEASURED. Not "do the transcripts match" — they never
 * will, one is human and one is a machine guess. What matters for timing
 * transfer is ANCHORS: exact 6-word sequences common to both. Timing is read off
 * an anchor and interpolated between anchors, so the test is:
 *
 *   1. coverage   — does every part of the episode contain at least one anchor?
 *                   A gap means a stretch with no timing to interpolate from.
 *   2. monotonic  — do anchors advance in time across the episode? Out-of-order
 *                   anchors mean a false match (a repeated phrase), which would
 *                   drag a claim's timestamp to the wrong place entirely.
 *
 * A high overall match rate with a gap in one section is a FAILURE; even
 * coverage at a lower rate is a pass. Read the per-episode lines, not the
 * average.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile } from 'node:fs/promises'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const BINS = 20
const GRAM = 6

const args = process.argv.slice(2)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The transcript is the largest `class="hidden"` pane — the tabs only toggle
 *  visibility, so it is present in the delivered HTML. */
function extractTranscript(html: string): string {
  const panes = [...html.matchAll(/<div[^>]*class="[^"]*hidden[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*hidden)/g)].map(m =>
    stripTags(m[1])
  )
  return panes.sort((a, b) => b.length - a.length)[0] ?? ''
}

type Caption = { start: number; text: string }

async function youtubeCaptions(ids: string[]): Promise<Map<string, Caption[]>> {
  const token = process.env.YOUTUBE_TRANSCRIPT_API_TOKEN
  if (!token) throw new Error('YOUTUBE_TRANSCRIPT_API_TOKEN missing')
  const res = await fetch('https://www.youtube-transcript.io/api/transcripts', {
    method: 'POST',
    headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) throw new Error(`caption fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  const out = new Map<string, Caption[]>()
  for (const v of Array.isArray(data) ? data : [data]) {
    const segs = (v?.tracks?.[0]?.transcript ?? []).map((s: { start: string | number; text: string }) => ({
      start: Number(s.start),
      text: String(s.text ?? ''),
    }))
    out.set(String(v?.id ?? ''), segs)
  }
  return out
}

function align(transcript: string, captions: Caption[]) {
  // word -> first time it appears, indexed by 6-gram
  const ytWords: [string, number][] = []
  for (const c of captions) for (const w of norm(c.text).split(' ').filter(Boolean)) ytWords.push([w, c.start])
  const idx = new Map<string, number>()
  for (let i = 0; i <= ytWords.length - GRAM; i++) {
    const g = ytWords.slice(i, i + GRAM).map(x => x[0]).join(' ')
    if (!idx.has(g)) idx.set(g, ytWords[i][1])
  }

  const words = norm(transcript).split(' ').filter(Boolean)
  const per = Math.floor(words.length / BINS)
  let covered = 0
  let ordered = 0
  let last = -1
  for (let b = 0; b < BINS; b++) {
    let found: number | null = null
    for (let i = b * per; i < Math.min((b + 1) * per, words.length - GRAM); i++) {
      const t = idx.get(words.slice(i, i + GRAM).join(' '))
      if (t !== undefined) { found = t; break }
    }
    if (found !== null) {
      covered++
      if (found >= last) { ordered++; last = found }
    }
  }
  return { covered, ordered, words: words.length, ytWords: ytWords.length }
}

async function main() {
  const n = Number(val('--n')) || 3
  const manifestPath = val('--manifest') ?? 'scratchpad/fmf-episodes.json'
  const man = JSON.parse(await readFile(manifestPath, 'utf8')) as { episodes: { slug: string; url: string; title: string }[] }

  // Spread the sample across the archive rather than taking the newest N: the
  // newest episodes may share a production style, and a format change is exactly
  // what would break alignment.
  const step = Math.max(1, Math.floor(man.episodes.length / n))
  const sample = Array.from({ length: n }, (_, i) => man.episodes[i * step]).filter(Boolean)

  let passes = 0
  for (const ep of sample) {
    process.stdout.write(`\n${ep.slug}\n`)
    try {
      const html = await (await fetch(ep.url, { headers: { 'User-Agent': UA } })).text()
      const transcript = extractTranscript(html)
      if (transcript.length < 5000) { process.stdout.write('  no usable transcript on the page — skipped\n'); continue }

      const ids = [...new Set([...html.matchAll(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)].map(m => m[1]))]
      if (ids.length === 0) { process.stdout.write('  no YouTube video linked — cannot align\n'); continue }

      const caps = await youtubeCaptions(ids.slice(0, 5))
      // The full episode is the longest caption track; the rest are clips.
      let best: Caption[] = []
      for (const segs of caps.values()) if (segs.length > best.length) best = segs
      if (best.length === 0) { process.stdout.write('  no captions on any linked video\n'); continue }

      const r = align(transcript, best)
      const ok = r.covered === BINS && r.ordered === r.covered
      if (ok) passes++
      process.stdout.write(
        `  transcript ${r.words} words | captions ${r.ytWords} words\n` +
          `  anchor coverage ${r.covered}/${BINS} sections | in time order ${r.ordered}/${r.covered} | ${ok ? 'PASS' : 'FAIL'}\n`
      )
    } catch (err) {
      process.stdout.write(`  error: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  process.stdout.write(`\n${passes}/${sample.length} episode(s) fully aligned\n`)
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
