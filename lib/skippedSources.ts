/**
 * Which feed keys are marked skipped in `sources` (migration 038): re-posts,
 * rebroadcasts, "Essentials" cuts and copies of an episode we already hold.
 *
 * The audio downloader and the Deepgram transcriber work from FILES, not from the
 * database, so they cannot see `processing_status`. Deepgram bills per minute, so a
 * skipped episode must not be downloaded or transcribed in the first place: both
 * scripts ask this one function which of their keys to leave out. The key is the
 * audio file's name and the row's `external_id` (`attia-0183`, `huberman-g0b1c2d`).
 */

/** What the lookup needs from a Supabase client: the chainable select it already has. */
type Db = {
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, values: string[]) => {
        eq: (col: string, value: string) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
      }
    }
  }
}

export type SkippedKey = { key: string; reason: string | null }

/** Keys per request: keeps the URL short (a 36-character key times 100 is well under any limit). */
const CHUNK = 100

/**
 * The subset of `keys` whose source row is skipped, with the stored reason.
 * Throws on a database error — a caller that is about to spend money must not
 * carry on as if nothing were skipped. Before migration 038 there is no
 * `skip_reason` column and no row can be skipped, so the answer is empty.
 */
export async function lookupSkippedKeys(db: Db, keys: readonly string[]): Promise<Map<string, SkippedKey>> {
  const out = new Map<string, SkippedKey>()
  const unique = [...new Set(keys)]
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    let res = await db.from('sources').select('external_id, skip_reason').in('external_id', chunk).eq('processing_status', 'skipped')
    if (res.error && /skip_reason|column/i.test(res.error.message)) {
      res = await db.from('sources').select('external_id').in('external_id', chunk).eq('processing_status', 'skipped')
    }
    if (res.error) throw new Error(`skipped-source lookup failed: ${res.error.message}`)
    for (const r of (res.data ?? []) as { external_id: string; skip_reason?: string | null }[]) {
      out.set(r.external_id, { key: r.external_id, reason: r.skip_reason ?? null })
    }
  }
  return out
}

/** `n file(s)` lines for a log: the first few keys with their reasons. */
export function describeSkipped(skipped: ReadonlyMap<string, SkippedKey>, show = 8): string[] {
  const lines: string[] = []
  for (const s of [...skipped.values()].slice(0, show)) lines.push(`    ${s.key}${s.reason ? ` — ${s.reason}` : ''}`)
  if (skipped.size > show) lines.push(`    … and ${skipped.size - show} more`)
  return lines
}
