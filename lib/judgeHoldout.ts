/**
 * Hold-out sampling for the fidelity judge (Paul, 2026-10-14, option a).
 *
 * The judge now runs as the last step of every overnight run
 * (scripts/extractDeepgram.ts → scripts/flagClaims.ts fidelity). To keep it
 * measured against human labels, each run sets aside a few of the facts it just
 * judged and files them for Paul at /admin/fidelity (table fidelity_holdout).
 *
 * Pure helpers only: no I/O, so they are unit-tested without a database.
 */

/** How many pairs a run sets aside when nothing says otherwise. */
export const DEFAULT_HOLDOUT = 5

/** Small deterministic PRNG (mulberry32), so a sample can be rebuilt from its seed. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** n items drawn without replacement (Fisher-Yates); same input + seed = same sample. */
export function pickHoldout<T>(items: readonly T[], n: number, seed: number): T[] {
  const count = Math.max(0, Math.min(Math.floor(n), items.length))
  const pool = items.slice()
  const random = seededRandom(seed)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}

/** Hold-out pair ids carry a prefix so they can never collide with the 40 static `extract:<id>` pairs. */
export const HOLDOUT_PREFIX = 'holdout:'
export const holdoutPairId = (claimId: string): string => `${HOLDOUT_PREFIX}${claimId}`
export const isHoldoutPairId = (id: string): boolean => id.startsWith(HOLDOUT_PREFIX)

/** `JUDGE_HOLDOUT_PER_RUN`: a non-negative whole number; blank or junk = the default; 0 = off. */
export function holdoutSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOLDOUT
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_HOLDOUT
}

/** The distinct sources whose consolidation finished during a run (consolidate_source job payloads). */
export function sourceIdsFromJobs(rows: readonly { payload: unknown }[]): string[] {
  const ids = new Set<string>()
  for (const r of rows) {
    const id = (r.payload as { source_id?: unknown } | null)?.source_id
    if (typeof id === 'string' && id) ids.add(id)
  }
  return [...ids]
}
