/**
 * One database writer at a time — enforced, not remembered.
 *
 * The project rule since the 2026-07-25 corruption is that only one process
 * writes to the corpus at a time: the overnight supervisor, a corpus sweep, or
 * a maintenance script such as scripts/retireSourceClaims.ts. Until now that
 * rule lived in people's memory. A supervisor started from a phone while a
 * maintenance script was half-way through would have raced it silently.
 *
 * The lock is a small JSON file in scratchpad/ that the holder refreshes every
 * minute. A lock older than STALE_MS is treated as abandoned (a killed process
 * cannot release), so a crash never wedges the pipeline. Everything that writes
 * calls `acquireWriterLock(name)` first and gets a clear refusal if someone
 * else holds it.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// In the home directory, not the repo: the supervisor runs from the main
// checkout and maintenance scripts often run from a worktree, and a lock that
// lived under either one's scratchpad/ would not be seen by the other.
const LOCK_PATH = path.join(homedir(), '.lifestyle-academy-writer.lock')
const STALE_MS = 15 * 60_000
const REFRESH_MS = 60_000

type Lock = { name: string; pid: number; at: string }

function readLock(): Lock | null {
  try {
    if (!existsSync(LOCK_PATH)) return null
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock
  } catch {
    return null
  }
}

/** Throws if another live writer holds the lock. */
export function assertNoOtherWriter(name: string): void {
  const lock = readLock()
  if (!lock) return
  const age = Date.now() - Date.parse(lock.at)
  if (age > STALE_MS) return // abandoned
  if (lock.pid === process.pid) return
  throw new Error(
    `another writer holds the corpus: ${lock.name} (pid ${lock.pid}, refreshed ${Math.round(age / 1000)}s ago). ` +
      `Wait for it to finish — one writer at a time. Lock file: ${LOCK_PATH}`
  )
}

/**
 * Take the lock for this process and keep it fresh until `release()` or exit.
 * Returns the release function.
 */
export function acquireWriterLock(name: string): () => void {
  assertNoOtherWriter(name)
  mkdirSync(path.dirname(LOCK_PATH), { recursive: true })
  const write = () => writeFileSync(LOCK_PATH, JSON.stringify({ name, pid: process.pid, at: new Date().toISOString() } satisfies Lock))
  write()
  const timer = setInterval(write, REFRESH_MS)
  timer.unref()
  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(timer)
    const current = readLock()
    if (current && current.pid === process.pid) {
      try { unlinkSync(LOCK_PATH) } catch { /* already gone */ }
    }
  }
  process.once('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { release(); process.exit(130) })
  }
  return release
}
