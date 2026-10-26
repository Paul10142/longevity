/**
 * A counting limiter: at most `max` tasks run at once, the rest wait in arrival order.
 *
 * Why it exists (docs/EXTRACTION_RUNBOOK.md §10, parallel workers). Several extraction jobs may run
 * in one process; each fans out up to EXTRACT_CONCURRENCY Claude CLI calls, so without a
 * process-wide ceiling N workers would launch 16 x N `claude -p` children. The same shape caps the
 * heavy `raw_insights` inserts so N workers do not fill the database's small API pool.
 *
 * Pure and dependency-free so tests/concurrency.test.ts can drive it with fake tasks.
 */
export type Limiter = {
  /** Wait for a free slot and take it. The returned function frees it (safe to call twice). */
  acquire(): Promise<() => void>
  /** Run `fn` inside a slot; the slot is freed when it settles. */
  run<T>(fn: () => Promise<T>): Promise<T>
  readonly max: number
  /** Slots in use right now. */
  readonly active: number
  /** Callers waiting for a slot. */
  readonly waiting: number
  /** The most slots ever in use at once. */
  readonly peak: number
}

export function createLimiter(max: number): Limiter {
  const cap = Math.max(1, Math.floor(max) || 1)
  let active = 0
  let peak = 0
  const queue: Array<() => void> = []

  const take = () => {
    active++
    if (active > peak) peak = active
    let freed = false
    return () => {
      if (freed) return
      freed = true
      active--
      const next = queue.shift()
      if (next) next()
    }
  }

  const acquire = (): Promise<() => void> => {
    if (active < cap) return Promise.resolve(take())
    return new Promise(resolve => {
      // The slot is handed over when someone frees one, in arrival order.
      queue.push(() => resolve(take()))
    })
  }

  return {
    acquire,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const release = await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
    get max() { return cap },
    get active() { return active },
    get waiting() { return queue.length },
    get peak() { return peak },
  }
}

/** A positive whole number from the environment, else `def`. */
export function envLimit(name: string, def: number): number {
  const n = Math.floor(Number(process.env[name]))
  return Number.isFinite(n) && n >= 1 ? n : def
}
