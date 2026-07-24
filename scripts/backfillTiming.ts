/**
 * One-time timing backfill for the seed YouTube source (Phase 1 timestamp demo).
 * The Attia "NON-NEGOTIABLES" source was ingested as a PASTED transcript, so its
 * per-caption timing was never captured. It has a real YouTube URL, so we re-fetch
 * the captions (with timing) and store them on `sources.timed_transcript`. The next
 * re-extraction then chunks from these segments and stamps start_ms through to
 * raw_insights. Only writes `timed_transcript` — touches nothing else.
 *
 *   npm run backfill-timing   (add the script alias) or:
 *   tsx --env-file=.env.local scripts/backfillTiming.ts
 */
import { normalizeYouTubeSegments, extractApiSegments } from '../lib/transcriptSegments'
import { supabaseAdmin } from '../lib/supabaseServer'

const VIDEO_ID = 's-qapZuy0GY'
const SOURCE_ID = 'e24fe6c5-3d32-4cd6-95e6-d71f585e1635'

async function main() {
  const token = process.env.YOUTUBE_TRANSCRIPT_API_TOKEN
  if (!token) throw new Error('YOUTUBE_TRANSCRIPT_API_TOKEN missing')
  if (!supabaseAdmin) throw new Error('Supabase admin not configured')

  console.log(`Fetching captions for ${VIDEO_ID} …`)
  const res = await fetch('https://www.youtube-transcript.io/api/transcripts', {
    method: 'POST',
    headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [VIDEO_ID] }),
  })
  if (!res.ok) throw new Error(`caption fetch failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const videoData = Array.isArray(data) ? data[0] : data
  const rawSegments = extractApiSegments(videoData)
  const timed = normalizeYouTubeSegments(rawSegments)
  console.log(`  ${rawSegments.length} raw segments → ${timed.length} timed segments`)
  if (timed.length === 0) throw new Error('no timed segments returned — aborting so we never store empty timing')
  console.log(`  first: ${JSON.stringify(timed[0])}`)
  console.log(`  last:  ${JSON.stringify(timed[timed.length - 1])}`)

  const { error } = await supabaseAdmin.from('sources').update({ timed_transcript: timed }).eq('id', SOURCE_ID)
  if (error) throw new Error(`update failed: ${error.message}`)
  console.log(`✓ sources.timed_transcript set for ${SOURCE_ID} (${timed.length} segments)`)
  console.log('Next: re-extract this source only, then work the queue.')
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
