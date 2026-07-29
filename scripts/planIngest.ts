/**
 * Plan a back-catalog ingest of Peter Attia "The Drive" from the channel dump.
 *
 * Joins:
 *   - the non-AMA rows of the Notion CSV (episode #, title, air date, guest)
 *   - the yt-dlp channel dump (videoId | title), matched by episode number
 *   - the live `sources` table (external_id, date) to skip already-ingested
 *     episodes and to build a date-backfill map for the ones missing a date.
 *
 * Writes scratchpad/ingest-plan.json:
 *   { toIngest: [{episode, videoId, title, date}], backfillDates: [{source_id, date}], stats }
 *
 * Read-only (no DB writes). AMA episodes are excluded (they truncate on YouTube).
 *
 *   npx tsx --env-file=.env.local scripts/planIngest.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

const CSV = process.env.CSV_PATH ||
  '/Users/paulclancy/Downloads/Private & Shared/TheDrive Podcast List 1764c1a1e9078036b12dda386adacfdf.csv'
const DUMP = 'scratchpad/attia_ids.txt'
const OUT = 'scratchpad/ingest-plan.json'

// ── minimal CSV parser (quoted fields, embedded commas & quotes) ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += ch
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') { row.push(field); field = '' }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (ch === '\r') { /* skip */ }
      else field += ch
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const isAma = (topic: string, guest: string): boolean =>
  /\bAMA\b/i.test(guest) || /^\s*(special\s+)?ama\b/i.test(topic) || /\bAMA\s*#?\d/i.test(topic)

/** Leading episode number of a title: "399 - …", "#396 – …", "373 – …". */
function epNum(s: string): number | null {
  const m = s.match(/^\s*#?\s*(\d{1,4})\s*[–\-‒—]/)
  return m ? Number(m[1]) : null
}

async function main() {
  // 1. CSV → non-AMA episodes with a numeric episode #.
  const csv = parseCsv(readFileSync(CSV, 'utf8'))
  const header = csv[0].map(h => h.replace(/^﻿/, '').trim())
  const col = (name: string) => header.findIndex(h => h.toLowerCase() === name.toLowerCase())
  const [cTopic, cNum, cDate, cGuest] = [col('Topic'), col('#'), col('Date'), col('Guest')]

  type Ep = { episode: number; title: string; date: string | null; guest: string }
  const nonAma: Ep[] = []
  let amaCount = 0, noNum = 0
  for (const r of csv.slice(1)) {
    if (r.length <= cNum) continue
    const topic = (r[cTopic] || '').trim()
    const guest = (r[cGuest] || '').trim()
    if (isAma(topic, guest)) { amaCount++; continue }
    const numRaw = (r[cNum] || '').replace(/[^\d]/g, '')
    if (!numRaw) { noNum++; continue }
    nonAma.push({ episode: Number(numRaw), title: topic, date: normDate(r[cDate]), guest })
  }

  // 2. Dump → episode# → videoId.
  const dump = readFileSync(DUMP, 'utf8').split('\n').filter(Boolean)
  const idByEp = new Map<number, { videoId: string; title: string }>()
  for (const line of dump) {
    const bar = line.indexOf('|')
    if (bar < 0) continue
    const videoId = line.slice(0, bar).trim()
    const title = line.slice(bar + 1).trim()
    if (/\bAMA\b/i.test(title)) continue // skip AMA sneak-peek / rebroadcast clips
    const n = epNum(title)
    if (n != null && !idByEp.has(n)) idByEp.set(n, { videoId, title })
  }

  // 3. Live sources → skip already-ingested; build backfill map.
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured')
  const { data: sources } = await supabaseAdmin.from('sources').select('id, external_id, title, date')
  const srcRows = (sources ?? []) as { id: string; external_id: string | null; title: string; date: string | null }[]
  const ingestedVideoIds = new Set(srcRows.map(s => s.external_id).filter(Boolean) as string[])

  // 4. Build ingest list.
  const toIngest: { episode: number; videoId: string; title: string; date: string | null }[] = []
  const noVideo: number[] = []
  for (const ep of nonAma) {
    const hit = idByEp.get(ep.episode)
    if (!hit) { noVideo.push(ep.episode); continue }
    if (ingestedVideoIds.has(hit.videoId)) continue
    toIngest.push({ episode: ep.episode, videoId: hit.videoId, title: ep.title, date: ep.date })
  }
  toIngest.sort((a, b) => b.episode - a.episode) // newest first

  // 5. Date backfill for already-ingested sources missing a date: match by
  //    episode number parsed from the stored source title against the CSV date.
  const dateByEp = new Map(nonAma.map(e => [e.episode, e.date]))
  const backfillDates: { source_id: string; date: string; title: string }[] = []
  for (const s of srcRows) {
    if (s.date) continue
    const n = epNum(s.title)
    const d = n != null ? dateByEp.get(n) : null
    if (d) backfillDates.push({ source_id: s.id, date: d, title: s.title })
  }

  const plan = {
    stats: {
      csv_rows: csv.length - 1,
      non_ama: nonAma.length,
      ama_excluded: amaCount,
      no_episode_num: noNum,
      channel_numbered_videos: idByEp.size,
      already_ingested: srcRows.length,
      to_ingest: toIngest.length,
      non_ama_without_channel_video: noVideo.length,
      backfill_dates: backfillDates.length,
    },
    toIngest,
    backfillDates,
    noVideoEpisodes: noVideo.sort((a, b) => b - a),
  }
  writeFileSync(OUT, JSON.stringify(plan, null, 2) + '\n')
  console.log(JSON.stringify(plan.stats, null, 2))
  console.log(`\n→ ${OUT}`)
  console.log(`Newest 8 to ingest:`)
  for (const t of toIngest.slice(0, 8)) console.log(`  #${t.episode}  ${t.videoId}  ${t.date ?? 'no-date'}  ${t.title.slice(0, 56)}`)
}

/** Notion dates are m/d/yy or m/d/yyyy → ISO yyyy-mm-dd. */
function normDate(s: string | undefined): string | null {
  if (!s) return null
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return null
  let [, mo, d, y] = m
  if (y.length === 2) y = '20' + y
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
