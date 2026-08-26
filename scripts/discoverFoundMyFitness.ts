/**
 * FoundMyFitness episode discovery — READ ONLY, writes a JSON manifest.
 *
 *   npx tsx scripts/discoverFoundMyFitness.ts --out scratchpad/fmf-episodes.json
 *   npx tsx scripts/discoverFoundMyFitness.ts --pages 3          # sample first
 *
 * Writes nothing to the database. Ingestion is a separate, later step so the
 * list can be reviewed before anything is committed to.
 *
 * WHY THIS IS A STATIC SCRAPE. The transcript looked JS-loaded at first: the
 * page has a "Transcription" tab and no transcript text under the obvious
 * selectors. It is actually present in the delivered HTML inside a
 * `class="hidden"` pane (~132k chars on the sample episode) — the tabs just
 * toggle visibility. So no browser is needed; the earlier "needs a headless
 * browser" reading was wrong.
 *
 * Speaker labels are `<strong>` elements carrying `Name:`, which is what makes
 * this source worth having: they are human-published attributions rather than
 * anything we inferred.
 *
 * ⚠ THESE TRANSCRIPTS CARRY NO PER-TURN TIMESTAMPS. The timestamps on the page
 * belong to the Timeline tab, not the transcript. So a claim extracted from a
 * FoundMyFitness source can name its speaker but cannot deep-link to the moment
 * it was said — `start_ms`/`end_ms` will be null. That is a real downgrade from
 * the Deepgram path and the reason ingestion is left as a separate decision:
 * the alternative is paying to transcribe audio we can already read for free.
 *
 * Full episodes only, per the product owner. NOTE: `?type=interviews` in the URL
 * is IGNORED by the site — a first pass trusted it and collected 370 items that
 * turned out to be 146 Aliquot episodes and 82 Q&As alongside 142 interviews.
 * Filtering is therefore done here, on the slug, which carries a stable prefix
 * for the formats we do not want. Verify the counts after any site redesign.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BASE = 'https://www.foundmyfitness.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const args = process.argv.slice(2)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}

type Episode = { slug: string; url: string; title: string }

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/** Episode links on a listing page. Deduped: a card links to the same slug more
 *  than once (thumbnail and title are separate anchors). */
/** Formats that are not full interviews. The Aliquot is a separate members'
 *  podcast and Q&As are short-form; neither is the long-form episode wanted
 *  here, and both use a stable slug prefix. */
function isInterview(slug: string): boolean {
  return !/^(aliquot|qa-|q-and-a|ama-)/.test(slug) && !/(^|-)(clip|clips|highlight|highlights|short|shorts|trailer|preview)(-|$)/.test(slug)
}

function parseListing(html: string): Episode[] {
  const seen = new Set<string>()
  const out: Episode[] = []
  for (const m of html.matchAll(/<a[^>]+href="\/episodes\/([a-z0-9-]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const slug = m[1]
    if (seen.has(slug)) continue
    if (!isInterview(slug)) continue
    const title = decode(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
    if (!title) continue // thumbnail-only anchor; the titled one follows
    seen.add(slug)
    out.push({ slug, url: `${BASE}/episodes/${slug}`, title })
  }
  return out
}

async function main() {
  const outPath = val('--out') ?? 'scratchpad/fmf-episodes.json'
  const maxPages = Number(val('--pages')) || 30

  const episodes = new Map<string, Episode>()
  let emptyStreak = 0

  for (let page = 1; page <= maxPages; page++) {
    // No type filter in the URL — the site ignores it (see the header).
    const url = `${BASE}/episodes?page=${page}`
    let html: string
    try {
      html = await get(url)
    } catch (err) {
      process.stdout.write(`  page ${page} failed: ${err instanceof Error ? err.message : String(err)}\n`)
      break
    }
    const found = parseListing(html)
    const before = episodes.size
    for (const e of found) episodes.set(e.slug, e)
    const added = episodes.size - before
    process.stdout.write(`  page ${page}: ${found.length} link(s), ${added} new (total ${episodes.size})\n`)

    // Stop when pages stop contributing: pagination past the end returns the
    // last page again rather than a 404, so counting pages is not enough.
    if (added === 0) {
      if (++emptyStreak >= 2) { process.stdout.write('  two pages with nothing new — stopping\n'); break }
    } else {
      emptyStreak = 0
    }
    await sleep(1200) // be a considerate client; this is someone else's server
  }

  const list = [...episodes.values()]
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify({ generated_at: new Date().toISOString(), count: list.length, episodes: list }, null, 2))
  process.stdout.write(`\n${list.length} interview episode(s) → ${outPath}\n`)
  process.stdout.write('nothing written to the database; ingestion is a separate step\n')
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
