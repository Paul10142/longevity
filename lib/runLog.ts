/**
 * Tee console output of an unattended run to a log file.
 *
 * The 2026-08-27/28 extraction crawled for 16 hours and died; nothing was
 * written to disk, the jobs table keeps only the LAST error per job, and the
 * terminal scrollback was gone. The post-mortem six weeks later could only say
 * "the AI-call path stalled" without knowing how. Every supervisor now calls
 * this once at startup, so the next stall leaves a record.
 *
 * Logging must never kill the run it documents: a write failure is swallowed.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function startRunLog(name: string, dir = 'scratchpad/runs'): string {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const path = join(dir, `${name}-${stamp}.log`)

  const render = (a: unknown): string => {
    if (a instanceof Error) return a.stack ?? a.message
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }
  const write = (level: string, args: unknown[]) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${args.map(render).join(' ')}\n`)
    } catch {
      // Never let the log take the run down.
    }
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      write(level.toUpperCase().padEnd(5), args)
    }
  }
  console.log(`[runlog] writing to ${path}`)
  return path
}
