/**
 * Who may write to the corpus, and when — enforced, not remembered.
 *
 * The project rule since the 2026-07-25 corruption is that only one process
 * writes to the corpus at a time: the overnight supervisor, a corpus sweep, or
 * a maintenance script such as scripts/retireSourceClaims.ts. Until now that
 * rule lived in people's memory. A supervisor started from a phone while a
 * maintenance script was half-way through would have raced it silently.
 *
 * Two kinds of lock (2026-10-18, extract / consolidate lanes — see
 * lib/pipelineLanes.ts and docs/EXTRACTION_RUNBOOK.md):
 *
 *   EXCLUSIVE   `acquireWriterLock(name)`. The supervisor in its default mode,
 *               sweeps, retireSourceClaims, repair scripts. Needs the corpus to
 *               itself: refused while ANY other lock (either kind) is live.
 *   LANE        `acquireLaneLock('extract' | 'consolidate', name)`. One extract-only
 *               run and one consolidate-only run may hold their lanes together;
 *               never two of the same lane, and never alongside an exclusive writer.
 *
 * Why those two lanes may overlap: extraction writes only rows keyed to its own
 * source (raw_insights, chunks, its pipeline_runs row, its sources row) and
 * consolidation of another source never reads or writes those — the proof, and
 * the one shared write that had to be removed, is in docs/EXTRACTION_RUNBOOK.md §9.
 *
 * Each lock is a small JSON file in the home directory that the holder refreshes
 * every minute. A lock older than STALE_MS, or whose process is gone, is treated
 * as abandoned (a killed process cannot release), so a crash never wedges the
 * pipeline. Acquiring creates the file atomically (`wx`), then re-checks the
 * other kind, so two starters racing each other both back off instead of both
 * proceeding.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const STALE_MS = 15 * 60_000
const REFRESH_MS = 60_000

export type LaneName = 'extract' | 'consolidate'
type Kind = 'exclusive' | LaneName
const LANES: LaneName[] = ['extract', 'consolidate']

type Lock = { name: string; pid: number; at: string }

// In the home directory, not the repo: the supervisor runs from the main
// checkout and maintenance scripts often run from a worktree, and a lock that
// lived under either one's scratchpad/ would not be seen by the other. The
// directory is read on every call so tests can point it at a temp folder.
function lockPath(kind: Kind): string {
  const dir = process.env.LIFESTYLE_ACADEMY_LOCK_DIR || homedir()
  // The exclusive file keeps its original name: processes started before the
  // lanes existed (and scripts not yet updated) still honour it.
  return path.join(dir, kind === 'exclusive' ? '.lifestyle-academy-writer.lock' : `.lifestyle-academy-writer.${kind}.lock`)
}

function readLock(kind: Kind): Lock | null {
  try {
    const p = lockPath(kind)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as Lock
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours to signal
  }
}

/** The live holder of this lock if it is another process, else null (absent, abandoned, or ours). */
function liveHolder(kind: Kind): { lock: Lock; ageMs: number } | null {
  const lock = readLock(kind)
  if (!lock) return null
  const ageMs = Date.now() - Date.parse(lock.at)
  if (ageMs > STALE_MS) return null // abandoned
  if (lock.pid === process.pid) return null
  if (!processAlive(lock.pid)) return null // holder is gone; no need to wait out the 15 minutes
  return { lock, ageMs }
}

function describe(kind: Kind, h: { lock: Lock; ageMs: number }): string {
  return `${h.lock.name} (pid ${h.lock.pid}, ${kind === 'exclusive' ? 'exclusive' : `${kind} lane`}, refreshed ${Math.round(h.ageMs / 1000)}s ago)`
}

/** Other locks that a holder of `mine` cannot coexist with. */
function conflictsWith(mine: Kind): Kind[] {
  // An exclusive writer needs everything else idle; a lane needs no exclusive
  // writer and no second run of its own lane (the other lane is allowed).
  return mine === 'exclusive' ? ['exclusive', ...LANES] : ['exclusive', mine]
}

function firstConflict(mine: Kind): string | null {
  for (const k of conflictsWith(mine)) {
    const h = liveHolder(k)
    if (h) return describe(k, h)
  }
  return null
}

function refusal(conflict: string, mine: Kind): Error {
  const where = mine === 'exclusive' ? 'the corpus' : `the ${mine} lane`
  return new Error(
    `another writer holds ${where}: ${conflict}. ` +
      `Wait for it to finish — see docs/EXTRACTION_RUNBOOK.md §9 for what may run together. Lock dir: ${path.dirname(lockPath(mine))}`
  )
}

/** Throws if another live writer holds a lock that conflicts with an exclusive writer. */
export function assertNoOtherWriter(_name: string): void {
  const c = firstConflict('exclusive')
  if (c) throw refusal(c, 'exclusive')
}

/** Throws if an exclusive writer, or another run of this lane, is live. */
export function assertLaneFree(lane: LaneName): void {
  const c = firstConflict(lane)
  if (c) throw refusal(c, lane)
}

/** True while some other process holds this lane (used by the consolidate lane to wait for the extract lane). */
export function laneIsLive(lane: LaneName): boolean {
  return liveHolder(lane) !== null
}

function take(kind: Kind, name: string): () => void {
  const c = firstConflict(kind)
  if (c) throw refusal(c, kind)
  const file = lockPath(kind)
  mkdirSync(path.dirname(file), { recursive: true })
  const body = () => JSON.stringify({ name, pid: process.pid, at: new Date().toISOString() } satisfies Lock)

  // Create atomically. An existing file here is ours, stale or dead (the checks
  // above passed), so clear it and create again; a second EEXIST means someone
  // else got in between, which is a refusal, not a retry loop.
  const create = () => {
    const fd = openSync(file, 'wx')
    try { writeFileSync(fd, body()) } finally { closeSync(fd) }
  }
  try {
    create()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    try { unlinkSync(file) } catch { /* raced with a release */ }
    try {
      create()
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2
      throw refusal(describeFile(kind), kind)
    }
  }

  let released = false
  const onSignal = () => { release(); process.exit(130) }
  const release = () => {
    if (released) return
    released = true
    clearInterval(timer)
    process.removeListener('exit', release)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    const current = readLock(kind)
    if (current && current.pid === process.pid) {
      try { unlinkSync(file) } catch { /* already gone */ }
    }
  }
  const timer = setInterval(() => { try { writeFileSync(file, body()) } catch { /* next tick */ } }, REFRESH_MS)
  timer.unref()

  // Re-check the other side now that our file exists: if a conflicting writer
  // slipped in at the same moment it will see ours too, and both back off.
  const late = firstConflict(kind)
  if (late) {
    release()
    throw refusal(late, kind)
  }

  process.once('exit', release)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return release
}

function describeFile(kind: Kind): string {
  const l = readLock(kind)
  return l ? `${l.name} (pid ${l.pid})` : 'another process'
}

/**
 * Take the whole corpus for this process (exclusive) and keep the lock fresh
 * until `release()` or exit. Returns the release function.
 */
export function acquireWriterLock(name: string): () => void {
  return take('exclusive', name)
}

/** Take one lane (see the file header). Returns the release function. */
export function acquireLaneLock(lane: LaneName, name: string): () => void {
  return take(lane, name)
}
