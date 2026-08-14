/**
 * Full-corpus claim dedup sweep.
 *
 * Walks every active claim and matches it against the WHOLE corpus via
 * match_claims, auto-merging confident duplicates and queueing borderline pairs
 * for human review. Consolidation only compares a new insight against claims
 * that existed at that moment, so it structurally cannot catch a duplicate that
 * arrives in a later source — that is what this pass is for.
 *
 * Pass `--since <timestamp>` to seed the keyset cursor and sweep only claims
 * created after it (much faster when you know the tail is what needs checking).
 * Omit it to sweep everything.
 *
 * Runs on the local subscription CLI, where the adjudicator works.
 *
 *   caffeinate -dimsu npx tsx --env-file=.env.local scripts/sweepCorpus.ts [--since '2026-07-31 23:59:59+00']
 */
export {}

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const MAX_CONSECUTIVE_FAILURES = 5
const now = () => new Date().toISOString().slice(11, 19)

async function main() {
  const args = process.argv.slice(2)
  const sinceIdx = args.indexOf('--since')
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null

  const { sweepClaims } = await import('../lib/consolidation')

  let checkpoint: Record<string, unknown> = {
    processed: 0,
    total: 0,
    merged: 0,
    // Null cursor = start at the oldest claim and sweep everything.
    cursor_created_at: since,
    cursor_id: since ? ZERO_UUID : null,
  }

  console.log(`[${now()}] sweep — ${since ? `claims created after ${since}` : 'FULL CORPUS'}`)

  // Transient `TypeError: fetch failed` blips do happen on long runs — one killed
  // a 95%-complete sweep once. The checkpoint lives in this process, so dying
  // means rescanning from the top; retry the tick instead, resuming from the last
  // good cursor. Only consecutive failures with no progress give up.
  let consecutiveFailures = 0

  for (let tick = 1; ; tick++) {
    let result
    try {
      result = await sweepClaims(
        async () => {}, // full checkpoint is persisted here between ticks, not by the heartbeat
        220_000,
        checkpoint as never
      )
      consecutiveFailures = 0
    } catch (err) {
      consecutiveFailures++
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw err
      const backoff = consecutiveFailures * 15_000
      console.log(
        `[${now()}] tick ${tick} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ` +
          `${err instanceof Error ? err.message : err} — retrying in ${backoff / 1000}s from the last cursor`
      )
      await new Promise(r => setTimeout(r, backoff))
      continue
    }
    const cp = result.checkpoint
    console.log(
      `[${now()}] tick ${tick}: processed ${cp.processed}/${cp.total}, merged ${cp.merged}` +
        (result.done ? ' — DONE' : '')
    )
    if (result.done) {
      console.log(`[${now()}] sweep complete — ${cp.merged} merges over ${cp.processed} claims`)
      return
    }
    checkpoint = cp as unknown as Record<string, unknown>
  }
}

main().catch(err => { console.error('sweep failed:', err); process.exit(1) })
