/**
 * FoundMyFitness episodes → `sources`, with published speaker labels and timing
 * recovered from the episode's YouTube captions.
 *
 *   npx tsx --env-file=.env.local scripts/ingestFoundMyFitness.ts --dry-run --limit 3
 *   npx tsx --env-file=.env.local scripts/ingestFoundMyFitness.ts --limit 20
 *   npx tsx --env-file=.env.local scripts/ingestFoundMyFitness.ts --only luc-van-loon,robbins-diamandis --force --dry-run
 *
 * `--only <slug>[,<slug>]` restricts the run to those episodes. With `--force` an
 * episode that is ALREADY ingested is rebuilt in place — same row id and
 * external_id; only transcript, timed_transcript, authors and duration are
 * rewritten — instead of being skipped. `--force` requires `--only`, so it can
 * never touch an episode that was not named. (Added 2026-11-08 to repair two rows
 * whose speaker labels were split wrong; their old facts are retired separately
 * with `retireSourceClaims.ts --keep-row`.)
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
 * An episode is SKIPPED rather than half-ingested when it has no transcript, no
 * linked video, or alignment covers less than most of the episode. A source with
 * plausible but wrong timestamps is worse than an absent one: every claim
 * extracted from it would deep-link to the wrong moment, and nothing downstream
 * would flag it.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { readFile } from 'node:fs/promises'
import { alignTurns, type TimedCaption } from '../lib/transcriptAlignment'
import { pageTitle, parsePublishedTranscript } from '../lib/publishedTranscript'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const SERIES = 'FoundMyFitness'
const HOST = 'Rhonda Patrick'
/** Below this share of the episode covered by anchors, timing is not trustworthy. */
const MIN_COVERAGE = 0.8
/**
 * Minimum characters to count as a transcript. Low, because a genuinely short
 * episode has a genuinely short transcript — the earlier 80k bar was chosen to
 * work around a broken parser and would have excluded real ones.
 */
const MIN_TRANSCRIPT_CHARS = 20_000
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

/** Share of the words each speaker holds: a quick check that a rebuilt interview did not collapse onto one voice. */
function wordShares(turns: { speaker: string | null; text: string }[]): Record<string, number> {
  const words = new Map<string, number>()
  let total = 0
  for (const t of turns) {
    const n = t.text.split(/\s+/).filter(Boolean).length
    words.set(t.speaker ?? '(none)', (words.get(t.speaker ?? '(none)') ?? 0) + n)
    total += n
  }
  return Object.fromEntries([...words.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, Math.round((1000 * v) / Math.max(1, total)) / 10]))
}

async function main() {
  const manifestPath = val('--manifest') ?? 'scratchpad/fmf-episodes.json'
  const limit = Number(val('--limit')) || Infinity
  const dryRun = has('--dry-run')
  const force = has('--force')
  const only = val('--only')?.split(',').map(x => x.trim()).filter(Boolean) ?? null
  if (force && !only) throw new Error('--force rebuilds existing rows, so it needs --only <slug>[,<slug>] naming exactly which ones')
  if (only && only.length === 0) throw new Error('--only needs at least one slug')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  const man = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    episodes: { slug: string; url: string; title: string }[]
  }
  const episodes = only ? man.episodes.filter(e => only.includes(e.slug)) : man.episodes
  if (only) {
    const missing = only.filter(slug => !man.episodes.some(e => e.slug === slug))
    if (missing.length) throw new Error(`not in the manifest ${manifestPath}: ${missing.join(', ')}`)
  }

  // One database writer at a time (docs/EXTRACTION_RUNBOOK.md §1). Dry runs only read.
  if (!dryRun) {
    const { acquireWriterLock } = await import('../lib/writerLock')
    acquireWriterLock('ingestFoundMyFitness')
  }

  let done = 0
  let skipped = 0
  const reasons = new Map<string, number>()
  const note = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1)

  for (const ep of episodes) {
    if (done >= limit) break
    const key = `fmf-${ep.slug}`

    const { data: existing } = await db.from('sources')
      .select('id, processing_status, series, transcript_origin, authors, media_duration_sec, transcript, timed_transcript')
      .eq('external_id', key).maybeSingle()
    if (existing && !force) { skipped++; note('already ingested'); continue }
    if (!existing && force) { skipped++; note('--force: no such row to rebuild'); continue }
    if (existing && (existing.series !== SERIES || existing.transcript_origin !== 'published')) {
      skipped++
      note(`--force: row is ${existing.series}/${existing.transcript_origin}, not a published ${SERIES} row`)
      continue
    }

    try {
      const html = await (await fetch(ep.url, { headers: { 'User-Agent': UA } })).text()
      const title = pageTitle(html) || ep.title
      // Speakers first: they are how the transcript is found at all.
      const parsed = parsePublishedTranscript(html, { title, host: HOST })
      if (parsed.labels.length === 0) { skipped++; note('no speaker labels anywhere on the page'); continue }

      const { transcript, turns } = parsed
      if (transcript.length < MIN_TRANSCRIPT_CHARS) {
        skipped++
        note(`transcript too short (${Math.round(transcript.length / 1000)}k chars)`)
        continue
      }
      // Every turn must carry a speaker: a segment with no label cannot be credited to anyone.
      if (turns.some(t => !t.speaker)) { skipped++; note('a turn has no speaker label'); continue }

      const ids = [...new Set([...html.matchAll(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)].map(m => m[1]))]
      if (ids.length === 0) { skipped++; note('no YouTube video linked'); continue }

      const captions = await fetchCaptions(ids.slice(0, 5))
      if (captions.length < 100) { skipped++; note('no usable captions'); continue }

      const { timed, anchors, coverage } = alignTurns(turns, captions)
      if (coverage < MIN_COVERAGE) {
        skipped++
        note(`alignment too sparse (${Math.round(coverage * 100)}%)`)
        continue
      }

      const durationSec = Math.round((timed[timed.length - 1]?.end_ms ?? 0) / 1000)
      const videoId = ids.find(() => true)

      process.stdout.write(
        `  ${ep.slug}: ${turns.length} turns, speakers ${parsed.speakers.join(' / ')}, ` +
          `${anchors} anchors, ${Math.round(coverage * 100)}% covered, ${Math.round(durationSec / 60)} min\n` +
          `    word share ${JSON.stringify(wordShares(turns))}; authors ${JSON.stringify(parsed.authors)}; ` +
          `aliases ${JSON.stringify([...parsed.aliases])}\n`
      )

      if (dryRun) { done++; await sleep(SLOW_MS); continue }

      const transcriptText = timed.map(t => t.text).join(' ')
      const timedRows = timed.map(t => ({ text: t.text, start_ms: t.start_ms, end_ms: t.end_ms }))

      if (existing) {
        // Rebuild in place: same row, same external_id. Keep the old text first.
        const { mkdir, writeFile } = await import('node:fs/promises')
        const dir = process.env.RETIRE_BACKUP_DIR || 'scratchpad/backups'
        await mkdir(dir, { recursive: true })
        const backup = `${dir}/fmf-rebuild-${ep.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        await writeFile(backup, JSON.stringify({ id: existing.id, external_id: key, authors: existing.authors, media_duration_sec: existing.media_duration_sec, transcript: existing.transcript, timed_transcript: existing.timed_transcript }))
        process.stdout.write(`    backup → ${backup}\n`)
        const { error } = await db.from('sources').update({
          authors: parsed.authors,
          media_duration_sec: durationSec || null,
          transcript: transcriptText,
          timed_transcript: timedRows,
        }).eq('id', existing.id)
        if (error) { skipped++; note(`update failed: ${error.message.slice(0, 60)}`); continue }
        done++
        continue
      }

      const { error } = await db.from('sources').insert({
        external_id: key,
        series: SERIES,
        type: 'podcast',
        title,
        authors: parsed.authors,
        url: ep.url,
        youtube_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        article_url: ep.url, // the show's own page IS the write-up here
        media_type: 'audio',
        media_duration_sec: durationSec || null,
        transcript: transcriptText,
        timed_transcript: timedRows,
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

  const verb = force ? 'rebuilt' : 'ingested'
  process.stdout.write(`\n${dryRun ? `would have ${verb}` : verb} ${done} | skipped ${skipped}\n`)
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${n.toString().padStart(4)}  ${r}\n`)
  }
  if (!dryRun && done > 0 && !force) process.stdout.write('\nthese are pending — run extractDeepgram.ts to draft insights\n')
  if (!dryRun && done > 0 && force) process.stdout.write('\ntranscripts replaced — now retire the old facts: retireSourceClaims.ts --source <id> --keep-row\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
