/**
 * Writer locks (lib/writerLock.ts): one extract-only and one consolidate-only run
 * may overlap; never two of a lane, and never a lane beside an exclusive writer
 * (retireSourceClaims, repair scripts, the plain supervisor).
 *
 * Locks live in a temp directory (LIFESTYLE_ACADEMY_LOCK_DIR). The process's own
 * lock never conflicts with itself, so "someone else holds it" is simulated with a
 * lock file carrying the parent process's pid (alive, and not us).
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acquireWriterLock, acquireLaneLock, assertNoOtherWriter, assertLaneFree, laneIsLive } from '../lib/writerLock'

let dir = ''
const files = {
  exclusive: () => path.join(dir, '.lifestyle-academy-writer.lock'),
  extract: () => path.join(dir, '.lifestyle-academy-writer.extract.lock'),
  consolidate: () => path.join(dir, '.lifestyle-academy-writer.consolidate.lock'),
}
const releases: Array<() => void> = []
const hold = (file: string, over: { pid?: number; ageMs?: number; name?: string } = {}) =>
  writeFileSync(
    file,
    JSON.stringify({
      name: over.name ?? 'someone-else',
      pid: over.pid ?? process.ppid,
      at: new Date(Date.now() - (over.ageMs ?? 1000)).toISOString(),
    })
  )

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'la-locks-'))
  process.env.LIFESTYLE_ACADEMY_LOCK_DIR = dir
})
afterEach(() => {
  while (releases.length) releases.pop()!()
  delete process.env.LIFESTYLE_ACADEMY_LOCK_DIR
  rmSync(dir, { recursive: true, force: true })
})
const take = <T extends () => void>(release: T) => (releases.push(release), release)

test('an extract-only and a consolidate-only run can hold their lanes together', () => {
  take(acquireLaneLock('extract', 'extractDeepgram:extract-only'))
  take(acquireLaneLock('consolidate', 'extractDeepgram:consolidate-only'))
  assert.ok(existsSync(files.extract()))
  assert.ok(existsSync(files.consolidate()))
})

test('a second run of the same lane is refused', () => {
  hold(files.consolidate())
  assert.throws(() => acquireLaneLock('consolidate', 'second'), /another writer holds the consolidate lane: someone-else/)
  assert.throws(() => assertLaneFree('consolidate'), /consolidate lane/)
  assert.doesNotThrow(() => take(acquireLaneLock('extract', 'other lane is fine')))
})

test('a lane is refused while an exclusive writer (retireSourceClaims, a repair, the plain run) holds the corpus', () => {
  hold(files.exclusive(), { name: 'retireSourceClaims' })
  assert.throws(() => acquireLaneLock('extract', 'x'), /retireSourceClaims/)
  assert.throws(() => acquireLaneLock('consolidate', 'x'), /retireSourceClaims/)
})

test('an exclusive writer is refused while either lane is live, and while another exclusive writer is', () => {
  hold(files.extract(), { name: 'extract-only run' })
  assert.throws(() => acquireWriterLock('retireSourceClaims'), /extract-only run \(pid \d+, extract lane/)
  rmSync(files.extract())
  hold(files.consolidate(), { name: 'consolidate-only run' })
  assert.throws(() => assertNoOtherWriter('repair'), /consolidate lane/)
  rmSync(files.consolidate())
  hold(files.exclusive(), { name: 'sweepCorpus' })
  assert.throws(() => acquireWriterLock('retireSourceClaims'), /sweepCorpus/)
})

test('an exclusive writer can take the corpus when nothing else is live, and blocks the lanes', () => {
  take(acquireWriterLock('retireSourceClaims'))
  assert.ok(existsSync(files.exclusive()))
})

test('abandoned locks do not block: older than 15 minutes, or holder process gone', () => {
  hold(files.exclusive(), { ageMs: 16 * 60_000 })
  take(acquireLaneLock('extract', 'a'))
  hold(files.consolidate(), { pid: 2_999_999 }) // no such process
  take(acquireLaneLock('consolidate', 'b'))
})

test('releasing frees the lane, and only the owner removes the file', () => {
  const release = acquireLaneLock('extract', 'a')
  release()
  assert.equal(existsSync(files.extract()), false)
  const again = take(acquireLaneLock('extract', 'a2'))
  hold(files.extract(), { name: 'taken over by another pid' }) // another process overwrote it
  again()
  assert.ok(existsSync(files.extract()), 'a lock now owned by someone else is not deleted')
})

test('laneIsLive reflects another process holding the lane', () => {
  assert.equal(laneIsLive('extract'), false)
  hold(files.extract())
  assert.equal(laneIsLive('extract'), true)
  assert.equal(laneIsLive('consolidate'), false)
})
