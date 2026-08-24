/**
 * Podcast feed → local audio files + a manifest, ready for transcription.
 *
 * Why this exists: the YouTube path fetches text that already exists (captions).
 * A podcast feed carries only AUDIO, so there is no transcript to fetch — we
 * have to make one. This script does the first half (enumerate + download); the
 * transcriber (MacWhisper watch folder, or a cloud service) does the second.
 *
 *   npx tsx --env-file=.env.local scripts/fetchPodcastFeed.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/fetchPodcastFeed.ts --out ~/Desktop/LifestyleAcademyAudio
 *
 * SECRET HANDLING: the feed URL is a paid-membership credential — the same key
 * is embedded in every episode guid — so it is read from ATTIA_FEED_URL (or
 * --feed-env NAME) and is NEVER printed, never written into the manifest, and
 * never committed. Enclosure URLs carry the key too, so they are stripped from
 * the manifest as well. Anything this script writes to disk is safe to share.
 *
 * THE FILENAME IS THE JOIN KEY. Transcribers keep the base filename on export
 * (`attia-0405.mp3` -> `attia-0405.txt`), and that is the ONLY thing tying a
 * finished transcript back to its episode — the transcript itself contains no
 * episode id. So the name must be stable, unique, and filesystem-safe, and the
 * manifest records the mapping for the ingest side to read back. Renaming files
 * after the fact breaks the join; re-run this script instead.
 *
 * Idempotent: an episode whose file already exists at the expected byte length
 * is skipped, so a killed run resumes by re-running. A partial download is
 * written to `.part` and only renamed on success, so an interrupted transfer can
 * never masquerade as a complete episode.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import path from 'node:path'

type Episode = {
  /** Stable base filename, no extension — the join key described above. */
  key: string
  title: string
  /** ISO date, or null when the feed omits/garbles pubDate. */
  published_at: string | null
  duration_seconds: number | null
  /** Feed guid with the membership key stripped. Stable across re-runs. */
  guid: string
  audio_url: string
  audio_bytes: number | null
  file: string
}

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p
}

/** Strip the membership key from anything we persist or print. */
function redact(s: string): string {
  return s.replace(/([?&](?:key|token|auth)=)[^&\s"']+/gi, '$1<redacted>')
}

// ── minimal RSS reading ──────────────────────────────────────
// A dependency-free reader is deliberate: podcast RSS is a flat, predictable
// shape and adding an XML parser to the app's bundle for one offline script is
// not worth it. Only the fields below are read; anything else is ignored.

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? decodeEntities(m[1]) : null
}

/** "01:13:59" | "44:10" | "2650" → seconds. */
function parseDuration(raw: string | null): number | null {
  if (!raw) return null
  const parts = raw.split(':').map(p => Number(p.trim()))
  if (parts.some(n => !Number.isFinite(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 1) return parts[0]
  return null
}

/**
 * Build the join key. Episode numbers are preferred because they are what a
 * human recognises and what the show notes are filed under, but they are NOT
 * guaranteed unique or present (AMAs, specials, re-releases), so a guid-derived
 * suffix disambiguates. Never derive the key from the title alone: titles get
 * edited in the feed, which would silently orphan an already-transcribed file.
 */
function buildKey(prefix: string, title: string, guid: string, seen: Set<string>): string {
  const num = title.match(/#\s*(\d{1,4})/)?.[1]
  const short = Buffer.from(guid).toString('hex').slice(-6)
  let key = num ? `${prefix}-${num.padStart(4, '0')}` : `${prefix}-g${short}`
  if (seen.has(key)) key = `${key}-${short}`
  seen.add(key)
  return key
}

function parseFeed(xml: string, prefix: string): Episode[] {
  const out: Episode[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]
    const enclosure = block.match(/<enclosure\b[^>]*>/i)?.[0] ?? ''
    const audio_url = enclosure.match(/url\s*=\s*"([^"]+)"/i)?.[1] ?? ''
    if (!audio_url) continue // no audio → nothing to transcribe

    const lengthAttr = Number(enclosure.match(/length\s*=\s*"(\d+)"/i)?.[1])
    const title = tag(block, 'title') ?? '(untitled)'
    const guid = tag(block, 'guid') ?? audio_url
    const pub = tag(block, 'pubDate')
    const parsedDate = pub ? new Date(pub) : null

    const key = buildKey(prefix, title, guid, seen)
    out.push({
      key,
      title,
      published_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      duration_seconds: parseDuration(tag(block, 'itunes:duration')),
      guid: redact(guid),
      audio_url,
      audio_bytes: Number.isFinite(lengthAttr) ? lengthAttr : null,
      file: `${key}.mp3`,
    })
  }
  return out
}

async function download(url: string, dest: string): Promise<number> {
  const part = `${dest}.part`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  // Stream to `.part` and rename only on success — a half-written file that
  // carried the real name would be skipped as "already downloaded" forever.
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(part))
  const { size } = await stat(part)
  await rename(part, dest)
  return size
}

async function main() {
  const feedEnv = val('--feed-env') ?? 'ATTIA_FEED_URL'
  const feedUrl = process.env[feedEnv]
  if (!feedUrl) throw new Error(`${feedEnv} is not set (put it in .env.local — it is a credential)`)

  const prefix = val('--prefix') ?? 'attia'
  const outDir = expandHome(val('--out') ?? '~/Desktop/LifestyleAcademyAudio')
  const limit = Number(val('--limit')) || Infinity
  const dryRun = has('--dry-run')

  process.stdout.write(`reading feed from $${feedEnv}…\n`)
  const res = await fetch(feedUrl)
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`)
  const episodes = parseFeed(await res.text(), prefix)
  if (episodes.length === 0) throw new Error('feed parsed to 0 episodes — aborting rather than writing an empty manifest')

  const totalSecs = episodes.reduce((s, e) => s + (e.duration_seconds ?? 0), 0)
  process.stdout.write(
    `  ${episodes.length} episodes | ${(totalSecs / 3600).toFixed(0)} h audio | ` +
      `${episodes[episodes.length - 1]?.published_at?.slice(0, 10)} → ${episodes[0]?.published_at?.slice(0, 10)}\n`
  )

  await mkdir(outDir, { recursive: true })

  // The manifest is the ingest side's map from transcript filename back to
  // episode. Written BEFORE downloading so a dry run still produces it, and
  // rewritten after so byte counts reflect what actually landed.
  const manifestPath = path.join(outDir, 'manifest.json')
  const manifest = episodes.map(({ audio_url: _drop, ...rest }) => rest)
  await writeFile(manifestPath, JSON.stringify({ prefix, generated_at: new Date().toISOString(), episodes: manifest }, null, 2))
  process.stdout.write(`  manifest → ${manifestPath} (audio URLs stripped — safe to share)\n`)

  if (dryRun) {
    process.stdout.write('\ndry run — nothing downloaded. Sample of the join keys:\n')
    episodes.slice(0, 5).forEach(e => process.stdout.write(`  ${e.file}  ${e.title.slice(0, 64)}\n`))
    return
  }

  const existing = new Set(await readdir(outDir))
  let done = 0
  let skipped = 0
  let failed = 0
  const queue = episodes.slice(0, limit === Infinity ? episodes.length : limit)

  for (const [i, ep] of queue.entries()) {
    const dest = path.join(outDir, ep.file)
    if (existing.has(ep.file)) {
      // Trust the feed's byte length when it has one: a file that is the wrong
      // size is a truncated earlier run, not a finished download.
      const { size } = await stat(dest)
      if (ep.audio_bytes == null || size === ep.audio_bytes) { skipped++; continue }
      process.stdout.write(`  [${i + 1}/${queue.length}] ${ep.file} wrong size (${size} ≠ ${ep.audio_bytes}) — refetching\n`)
      await unlink(dest)
    }
    try {
      const bytes = await download(ep.audio_url, dest)
      done++
      process.stdout.write(`  [${i + 1}/${queue.length}] ${ep.file} ${(bytes / 1e6).toFixed(1)} MB\n`)
    } catch (err) {
      failed++
      // Never surface the raw error: fetch puts the full URL (with the
      // membership key) into its message.
      process.stdout.write(`  [${i + 1}/${queue.length}] ${ep.file} FAILED: ${redact(err instanceof Error ? err.message : String(err))}\n`)
    }
  }

  process.stdout.write(`\ndownloaded ${done}, already present ${skipped}, failed ${failed}\n`)
  if (failed > 0) process.stdout.write('re-run to retry the failures (completed files are skipped)\n')
  process.stdout.write(`point the transcriber's watch folder at ${outDir}\n`)
}

main().catch(e => {
  process.stderr.write(redact(e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
