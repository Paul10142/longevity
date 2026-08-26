/**
 * Fill in `sources.article_url` — the show's own write-up for each episode.
 *
 *   npx tsx --env-file=.env.local scripts/resolveShowNotes.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/resolveShowNotes.ts --verify 15
 *
 * peterattiamd.com files episodes under topic/guest slugs ('agingclocks',
 * 'ama80') that carry no episode number, so there is nothing in the URL to match
 * on. The archive LISTING pages do print the number beside each card, which
 * turns ~425 page fetches into ~16.
 *
 * THAT SHORTCUT IS ALSO THE RISK. Reading "the nearest #number to this link"
 * across a listing means a number belonging to the adjacent card can be picked
 * up instead, and a confidently wrong show-notes link is exactly the failure
 * that nothing downstream would ever question. So the mapping is VERIFIED: a
 * random sample of episode pages is fetched and their own titles compared
 * against what the listing claimed. `--verify N` reports that agreement rate,
 * and a mismatch means the shortcut is unsafe and the slow path is required.
 *
 * Only fills rows where article_url is null; never overwrites.
 */
export {} // module marker: keep `main` file-scoped (collides with pipeline.ts otherwise)

const BASE = 'https://peterattiamd.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i > -1 ? args[i + 1] : undefined
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Site furniture that also lives under a one-segment path. */
const NAV = new Set([
  'category', 'podcast', 'about', 'subscribe', 'contact', 'newsletter', 'privacy', 'terms',
  'shop', 'topics', 'topic-guide', 'articles-2', 'media', 'disclosures', 'ama', 'join',
  'membership', 'books', 'outlive', 'podcast-2', 'search', 'author', 'tag', 'page',
])

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
const text = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/**
 * slug → episode number, read from a listing page.
 *
 * The number is taken from a window AFTER the link only, not either side: cards
 * render as link-then-title, so looking backwards reaches into the previous
 * card and is where a wrong match would come from.
 */
function parseListing(html: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of html.matchAll(/href="https:\/\/peterattiamd\.com\/([a-z0-9][a-z0-9-]{2,60})\/"/g)) {
    const slug = m[1]
    if (NAV.has(slug)) continue
    if (out.has(slug)) continue
    const after = text(html.slice(m.index ?? 0, (m.index ?? 0) + 500))
    const num = after.match(/#\s*(\d{1,4})/)
    if (!num) continue
    out.set(slug, Number(num[1]))
  }
  return out
}

/** An episode page's own number, from its title — the authority for verification. */
function numberFromPage(html: string): number | null {
  const t = html.match(/<title>([^<]{3,250})<\/title>/i)?.[1] ?? ''
  const m = decode(t).match(/#\s*(\d{1,4})/)
  return m ? Number(m[1]) : null
}

async function main() {
  const dryRun = has('--dry-run')
  const verifyN = Number(val('--verify')) || 12
  const maxPages = Number(val('--pages')) || 40

  const { supabaseAdmin: db } = await import('../lib/supabaseServer')
  if (!db) throw new Error('Supabase not configured')

  // 1. Crawl the listing.
  const bySlug = new Map<string, number>()
  let empty = 0
  for (let page = 2; page <= maxPages; page++) {
    let html: string
    try {
      html = await get(`${BASE}/category/podcast/page/${page}/`)
    } catch {
      break
    }
    const found = parseListing(html)
    const before = bySlug.size
    for (const [s, n] of found) if (!bySlug.has(s)) bySlug.set(s, n)
    const added = bySlug.size - before
    process.stdout.write(`  page ${page}: +${added} (total ${bySlug.size})\n`)
    if (added === 0 && ++empty >= 2) break
    if (added > 0) empty = 0
    await sleep(1200)
  }

  const byNumber = new Map<number, string>()
  for (const [slug, n] of bySlug) if (!byNumber.has(n)) byNumber.set(n, slug)
  process.stdout.write(`\nlisting gave ${bySlug.size} slugs across ${byNumber.size} distinct episode numbers\n`)

  // 2. VERIFY the shortcut before trusting it.
  const sample = [...bySlug.entries()].sort(() => 0.5 - Math.random()).slice(0, verifyN)
  let agree = 0
  let checked = 0
  for (const [slug, claimed] of sample) {
    try {
      const actual = numberFromPage(await get(`${BASE}/${slug}/`))
      if (actual === null) continue
      checked++
      if (actual === claimed) agree++
      else process.stdout.write(`  MISMATCH ${slug}: listing said #${claimed}, page says #${actual}\n`)
    } catch {
      /* a page that will not load tells us nothing either way */
    }
    await sleep(1200)
  }
  const rate = checked ? agree / checked : 0
  process.stdout.write(`verification: ${agree}/${checked} agree (${Math.round(rate * 100)}%)\n`)
  if (checked === 0 || rate < 1) {
    process.stdout.write('\nNOT writing anything: the listing shortcut disagrees with the pages themselves.\n')
    process.stdout.write('Every episode page would have to be fetched individually to do this safely.\n')
    return
  }

  // 3. Fill.
  const { data: rows, error } = await db
    .from('sources')
    .select('id, episode_number')
    .eq('series', 'The Drive')
    .is('article_url', null)
    .not('episode_number', 'is', null)
  if (error) throw new Error(`lookup failed: ${error.message}`)

  const targets = (rows ?? []) as { id: string; episode_number: number }[]
  const matched = targets.filter(r => byNumber.has(r.episode_number))
  process.stdout.write(`\n${targets.length} episode(s) without show notes, ${matched.length} matched\n`)
  if (dryRun) { process.stdout.write('dry run — nothing written\n'); return }

  let updated = 0
  for (const r of matched) {
    const { error: upErr } = await db
      .from('sources')
      .update({ article_url: `${BASE}/${byNumber.get(r.episode_number)}/` })
      .eq('id', r.id)
      .is('article_url', null)
    if (!upErr) updated++
  }
  process.stdout.write(`filled ${updated} show-notes link(s)\n`)
}

main().catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
})
