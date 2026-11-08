/**
 * Backfill sources.youtube_url for episodes that have no YouTube link, by matching
 * each episode's title (and length, when known) to the channel's own upload list.
 *
 *   npm run backfill-youtube -- --validate       hold-out check on episodes whose video is already known
 *   npm run backfill-youtube                     DRY RUN: report matches, write nothing  (default)
 *   npm run backfill-youtube -- --apply          write youtube_url for confident matches only
 *   --catalog-dir <dir>   read <handle>.tsv files (id<TAB>title<TAB>seconds) instead of running yt-dlp
 *   --report <file>       write the full JSON report
 *
 * Careful by design (lib/youtubeMatch.ts): a source is matched only when exactly
 * one upload fits; anything doubtful stays blank and is listed in the report with
 * the reason. `--apply` only ever fills an EMPTY youtube_url (never overwrites) and
 * touches no other column. It is idempotent: a second run finds nothing to do.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { matchVideo, parseCatalogTsv, type CatalogVideo } from '../lib/youtubeMatch'

/** series (sources.series) -> the channel's handle. */
const CHANNELS: Record<string, string> = {
  'The Drive': 'PeterAttiaMD',
  FoundMyFitness: 'FoundMyFitness',
  'Huberman Lab': 'hubermanlab',
}

type Src = {
  id: string; title: string | null; series: string | null; episode_number: number | null
  media_duration_sec: number | null; youtube_url: string | null; url: string | null; article_url: string | null
}

const hasVideo = (s: Src) => Boolean(s.youtube_url) || /youtu/.test(s.url ?? '')

function catalogFor(handle: string, dir: string | undefined): CatalogVideo[] {
  const file = dir ? join(dir, `${handle}.tsv`) : null
  if (file && existsSync(file)) return parseCatalogTsv(readFileSync(file, 'utf8'))
  const out = execFileSync(
    'yt-dlp',
    ['--flat-playlist', '--no-warnings', '--print', '%(id)s\t%(title)s\t%(duration)s', `https://www.youtube.com/@${handle}/videos`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return parseCatalogTsv(out)
}

async function main() {
  const args = process.argv.slice(2)
  const arg = (k: string) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : undefined }
  const apply = args.includes('--apply')
  const validate = args.includes('--validate')
  const dir = arg('--catalog-dir')
  const reportPath = arg('--report')

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured — need .env.local')
  const { selectAllPaged } = await import('../lib/pagination')
  const sources = await selectAllPaged<Src>((from, to) =>
    db.from('sources').select('id, title, series, episode_number, media_duration_sec, youtube_url, url, article_url').order('id').range(from, to)
  )

  const catalogs = new Map<string, CatalogVideo[]>()
  for (const handle of new Set(Object.values(CHANNELS))) {
    catalogs.set(handle, catalogFor(handle, dir))
    console.log(`catalog ${handle}: ${catalogs.get(handle)!.length} uploads`)
  }
  const cat = (s: Src) => (s.series && CHANNELS[s.series] ? catalogs.get(CHANNELS[s.series]) ?? [] : [])
  const idOf = (s: Src) => (s.youtube_url ?? s.url ?? '').match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null

  if (validate) {
    // Hide the known video, match, compare: the real-data precision/recall of the matcher.
    let right = 0, wrong = 0, blank = 0
    const wrongs: unknown[] = []
    for (const s of sources.filter(hasVideo)) {
      const known = idOf(s)
      if (!known) continue
      const r = matchVideo({ title: s.title, episodeNumber: s.episode_number, durationSec: s.media_duration_sec }, cat(s))
      if (!('how' in r)) blank++
      else if (r.videoId === known) right++
      else { wrong++; wrongs.push({ title: s.title, known, got: r.videoId, how: r.how }) }
    }
    console.log(`validate: ${right} right, ${wrong} WRONG, ${blank} left blank (of ${right + wrong + blank} with a known video)`)
    if (wrongs.length) console.log(JSON.stringify(wrongs, null, 1))
    return
  }

  const todo = sources.filter(s => !hasVideo(s))
  const matched: { id: string; title: string | null; videoId: string; how: string; score: number }[] = []
  const blanks: { id: string; title: string | null; series: string | null; reason: string }[] = []
  for (const s of todo) {
    if (!s.series || !CHANNELS[s.series]) { blanks.push({ id: s.id, title: s.title, series: s.series, reason: 'no-channel' }); continue }
    const r = matchVideo({ title: s.title, episodeNumber: s.episode_number, durationSec: s.media_duration_sec }, cat(s))
    if ('how' in r) matched.push({ id: s.id, title: s.title, videoId: r.videoId, how: r.how, score: r.score })
    else blanks.push({ id: s.id, title: s.title, series: s.series, reason: r.reason })
  }
  // Second pass for what the titles could not settle: the episode page itself embeds
  // its video. Accepted only when the embedded id is a real upload on the show's own
  // channel (checked against the catalogue), which rules out a "related video" embed
  // from another channel; on 14 of 14 known episodes it agreed with the stored link.
  const { resolveVideoIdFromPage } = await import('../lib/sourceDiscovery')
  const bySrc = new Map(todo.map(s => [s.id, s]))
  for (const b of [...blanks]) {
    const s = bySrc.get(b.id)
    if (!s?.article_url || !s.series || !CHANNELS[s.series] || b.reason === 'video-claimed-twice') continue
    if (!/peterattiamd\.com/.test(s.article_url)) continue // only pages known to embed their own episode
    let id: string | null = null
    try { id = await resolveVideoIdFromPage(s.article_url) } catch { id = null }
    await new Promise(r => setTimeout(r, 300))
    const upload = id ? cat(s).find(v => v.id === id) : undefined
    if (!id || !upload) continue
    if (s.media_duration_sec && upload.durationSec && Math.abs(s.media_duration_sec - upload.durationSec) / upload.durationSec > 0.3) continue
    matched.push({ id: s.id, title: s.title, videoId: id, how: 'episode-page', score: 1 })
    blanks.splice(blanks.indexOf(b), 1)
  }

  // Two sources must never claim one video.
  const byVideo = new Map<string, number>()
  for (const m of matched) byVideo.set(m.videoId, (byVideo.get(m.videoId) ?? 0) + 1)
  const clean = matched.filter(m => byVideo.get(m.videoId) === 1)
  for (const m of matched.filter(m => byVideo.get(m.videoId)! > 1)) blanks.push({ id: m.id, title: m.title, series: null, reason: 'video-claimed-twice' })

  const reasons: Record<string, number> = {}
  for (const b of blanks) reasons[b.reason] = (reasons[b.reason] ?? 0) + 1
  console.log(`\n${todo.length} sources without a video: ${clean.length} matched, ${blanks.length} left blank`, reasons)
  console.log(`  exact-title ${clean.filter(m => m.how === 'exact-title').length}, similar-title ${clean.filter(m => m.how === 'similar-title').length}`)
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ matched: clean, blanks }, null, 1))

  if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply to write the matches.'); return }
  let written = 0
  for (const m of clean) {
    const { data, error } = await db
      .from('sources')
      .update({ youtube_url: `https://www.youtube.com/watch?v=${m.videoId}` })
      .eq('id', m.id)
      .is('youtube_url', null)
      .select('id')
    if (error) throw new Error(`${m.id}: ${error.message}`)
    written += data?.length ?? 0
  }
  console.log(`wrote ${written} youtube_url value(s)`)
}

main().catch(e => { console.error(e); process.exit(1) })
