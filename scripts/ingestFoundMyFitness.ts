/**
 * FoundMyFitness episodes → `sources`, with published speaker labels and timing
 * recovered from the episode's YouTube captions.
 *
 *   npx tsx --env-file=.env.local scripts/ingestFoundMyFitness.ts --dry-run --limit 3
 *   npx tsx --env-file=.env.local scripts/ingestFoundMyFitness.ts --limit 20
 *
 * Requires the manifest from `discoverFoundMyFitness.ts` and migration 027
 * (transcript_origin = 'published').
 *
 * WHY THIS SOURCE IS WORTH THE TROUBLE. The speaker attributions are the
 * publisher's own — made by someone who was in the room — which is stronger than
 * anything we could infer, and speaker identity is what the corroboration rule
 * counts. The catch is that the published transcript carries no timestamps, so
 * they are recovered by aligning against YouTube's captions for the same
 * episode (lib/transcriptAlignment.ts). Timing is therefore DERIVED, not
 * measured, and `transcript_origin = 'published'` records that.
 *
 * MOST EPISODES DO NOT QUALIFY, and that is the honest headline. On a 15-episode
 * spread only 3 published a full transcript at all; the rest serve a ~55k-char
 * summary pane that is not dialogue. A full run ingested 8 of 142.
 *
 * An episode is SKIPPED rather than half-ingested when it has no transcript, no
 * linked video, or alignment covers less than most of the episode. A source with
 * plausible but wrong timestamps is worse than an absent one: every claim
 * extracted from it would deep-link to the wrong moment, and nothing downstream
 * would flag it.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile } from 'node:fs/promises'
import { alignTurns, detectSpeakers, splitTurns, type TimedCaption } from '../lib/transcriptAlignment'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const SERIES = 'FoundMyFitness'
const HOST = 'Rhonda Patrick'
/** Below this share of the episode covered by anchors, timing is not trustworthy. */
const MIN_COVERAGE = 0.8
/**
 * Minimum characters for a pane to BE a transcript.
 *
 * Most episodes do not publish one. Measured on a 15-episode spread: only 3 had
 * a transcript pane (92k-138k chars); the other 12 topped out around 55k, which
 * is the summary/timeline content, not dialogue. Anything under this is not a
 * short transcript, it is a different thing entirely — and treating it as one
 * produced the misleading "no speaker labels" skip reason on 125 episodes.
 */
const MIN_TRANSCRIPT_CHARS = 80_000
/** Pace. The caption API returned 429 at roughly one request per second, so this
 *  is deliberately unhurried — an unattended run has time, and being throttled
 *  mid-run corrupts the results rather than merely slowing them. */
const SLOW_MS = Number(process.env.FMF_DELAY_MS) || 6000

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

const strip = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/** The transcript is the largest `class="hidden"` pane: the tabs toggle
 *  visibility, so it ships in the delivered HTML. */
function extractTranscript(html: string): string {
  return html
    .split(/<div[^>]*class="[^"]*hidden/)
    .filter(p => p.length > 20_000)
    .map(strip)
    .sort((a, b) => b.length - a.length)[0] ?? ''
}

function pageTitle(html: string): string {
  const m = html.match(/<title>([^<]{3,200})<\/title>/i)
  return m ? decode(m[1]).replace(/\s*\|\s*FoundMyFitness\s*$/i, '').trim() : ''
}

/** `Episode topic | Dr. Guest Name` → the guest. */
function guestFromTitle(title: string): string[] {
  if (!title.includes('|')) return []
  const tail = title.split('|').pop()?.trim() ?? ''
  const name = tail.replace(/^(dr\.?|prof\.?)\s+/i, '').trim()
  return name.length > 2 && /^[A-Z]/.test(name) ? [name] : []
}

/**
 * The caption API rate-limits (HTTP 429 / Cloudflare 1015) and, when it does,
 * answers with an HTML error page rather than JSON. Both must be handled, and
 * NEITHER may be treated as "this episode has no captions": that would record a
 * throttle as a property of the episode and skip it permanently. A 429 is
 * retried with growing backoff, and exhausting the retries THROWS so the caller
 * skips the episode for a reason that names the throttle.
 */
async function fetchCaptions(ids: string[]): Promise<TimedCaption[]> {
  const token = process.env.YOUTUBE_TRANSCRIPT_API_TOKEN
  if (!token) throw new Error('YOUTUBE_TRANSCRIPT_API_TOKEN missing')

  let data: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://www.youtube-transcript.io/api/transcripts', {
      method: 'POST',
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (res.status === 429) {
      const wait = 30_000 * 2 ** attempt
      process.stdout.write(`    rate limited — waiting ${Math.round(wait / 1000)}s\n`)
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`caption fetch failed: HTTP ${res.status}`)
    const body = await res.text()
    if (!body.trim().startsWith('[') && !body.trim().startsWith('{')) {
      // An HTML body is the throttle wearing a different hat.
      const wait = 30_000 * 2 ** attempt
      process.stdout.write(`    non-JSON response — waiting ${Math.round(wait / 1000)}s\n`)
      await sleep(wait)
      continue
    }
    data = JSON.parse(body)
    break
  }
  if (data === null) throw new Error('caption API throttled; giving up on this episode for now')
  // The page links clips as well as the episode; the full episode is simply the
  // longest caption track.
  let best: TimedCaption[] = []
  for (const v of Array.isArray(data) ? data : [data]) {
    const segs: TimedCaption[] = (v?.tracks?.[0]?.transcript ?? []).map(
      (s: { start: string | number; text: string }) => ({
        start_ms: Math.round(Number(s.start) * 1000),
        text: String(s.text ?? ''),
      })
    )
    if (segs.length > best.length) best = segs
  }
  return best
}

async function main() {
  const manifestPath = val('--manifest') ?? 'scratchpad/fmf-episodes.json'
  const limit = Number(val('--limit')) || Infinity
  const dryRun = has('--dry-run')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const man = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    episodes: { slug: string; url: string; title: string }[]
  }

  let done = 0
  let skipped = 0
  const reasons = new Map<string, number>()
  const note = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1)

  for (const ep of man.episodes) {
    if (done >= limit) break
    const key = `fmf-${ep.slug}`

    const { data: existing } = await db.from('sources').select('id, processing_status').eq('external_id', key).maybeSingle()
    if (existing) { skipped++; note('already ingested'); continue }

    try {
      const html = await (await fetch(ep.url, { headers: { 'User-Agent': UA } })).text()
      const transcript = extractTranscript(html)
      if (transcript.length < MIN_TRANSCRIPT_CHARS) {
        skipped++
        note('no full transcript published for this episode')
        continue
      }

      const speakers = detectSpeakers(transcript)
      if (speakers.length === 0) { skipped++; note('transcript present but unlabelled'); continue }

      const ids = [...new Set([...html.matchAll(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)].map(m => m[1]))]
      if (ids.length === 0) { skipped++; note('no YouTube video linked'); continue }

      const captions = await fetchCaptions(ids.slice(0, 5))
      if (captions.length < 100) { skipped++; note('no usable captions'); continue }

      const turns = splitTurns(transcript, speakers)
      const { timed, anchors, coverage } = alignTurns(turns, captions)
      if (coverage < MIN_COVERAGE) {
        skipped++
        note(`alignment too sparse (${Math.round(coverage * 100)}%)`)
        continue
      }

      const title = pageTitle(html) || ep.title
      const guests = guestFromTitle(title)
      const durationSec = Math.round((timed[timed.length - 1]?.end_ms ?? 0) / 1000)
      const videoId = ids.find(() => true)

      process.stdout.write(
        `  ${ep.slug}: ${turns.length} turns, speakers ${speakers.slice(0, 3).join(' / ')}, ` +
          `${anchors} anchors, ${Math.round(coverage * 100)}% covered, ${Math.round(durationSec / 60)} min\n`
      )

      if (dryRun) { done++; await sleep(SLOW_MS); continue }

      const { error } = await db.from('sources').insert({
        external_id: key,
        series: SERIES,
        type: 'podcast',
        title,
        authors: [HOST, ...guests],
        url: ep.url,
        youtube_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        article_url: ep.url, // the show's own page IS the write-up here
        media_type: 'audio',
        media_duration_sec: durationSec || null,
        transcript: timed.map(t => t.text).join(' '),
        timed_transcript: timed.map(t => ({ text: t.text, start_ms: t.start_ms, end_ms: t.end_ms })),
        transcript_origin: 'published',
        transcript_quality: 'high',
        authority_tier: 'expert',
        processing_status: 'pending',
      })
      if (error) { skipped++; note(`insert failed: ${error.message.slice(0, 60)}`); continue }
      done++
    } catch (err) {
      skipped++
      note(`error: ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`)
    }
    await sleep(SLOW_MS) // someone else's server, and the caption API throttles
  }

  process.stdout.write(`\n${dryRun ? 'would ingest' : 'ingested'} ${done} | skipped ${skipped}\n`)
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${n.toString().padStart(4)}  ${r}\n`)
  }
  if (!dryRun && done > 0) process.stdout.write('\nthese are pending — run extractDeepgram.ts to draft insights\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
