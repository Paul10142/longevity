/**
 * Re-run deduplication over the claims the broken Vercel cron added without it.
 *
 * Context: Aug 2-13 2026 the daily Vercel cron ran consolidation on the API
 * backend, whose key is out of credit, so every adjudicator call failed —
 * ~1,500 claims landed with NO dedup (merged_into frozen at 265). See the
 * 2026-08-14 BACKLOG handoff block.
 *
 * Scoped, not a full sweep: seeds sweepClaims' keyset cursor just before the
 * cron era, so it walks only those claims (~1,550) instead of all 9,925. Each
 * one is still matched against the WHOLE corpus via match_claims, so duplicates
 * are caught in both directions — the scoping only limits which claims we
 * iterate, not what they are compared to.
 *
 * Runs on the local subscription CLI (claude-code), where the adjudicator works.
 *
 *   caffeinate -dimsu npx tsx --env-file=.env.local scratchpad/sweepCronEra.ts
 */
export {}

process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'

// Just before the first cron-era write (2026-08-01 06:28). All-zero UUID so the
// keyset predicate `created_at > ts OR (created_at = ts AND id > uuid)` reduces
// to a clean "everything after this timestamp".
const CURSOR_TS = '2026-07-31 23:59:59+00'
const CURSOR_ID = '00000000-0000-0000-0000-000000000000'

const now = () => new Date().toISOString().slice(11, 19)

async function main() {
  const { sweepClaims } = await import('../lib/consolidation')

  let checkpoint: Record<string, unknown> = {
    processed: 0,
    total: 0,
    merged: 0,
    cursor_created_at: CURSOR_TS,
    cursor_id: CURSOR_ID,
  }

  console.log(`[${now()}] scoped sweep — claims created after ${CURSOR_TS}`)

  for (let tick = 1; ; tick++) {
    const result = await sweepClaims(
      async () => {}, // no-op: we persist the full checkpoint ourselves between ticks
      220_000,
      checkpoint as never
    )
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

main().catch(err => {
  console.error('sweep failed:', err)
  process.exit(1)
})
