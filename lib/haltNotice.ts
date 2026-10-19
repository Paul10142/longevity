/**
 * What a supervisor does when the CLI circuit breaker trips (lib/llm.ts): print a clear
 * STOP block, exit non-zero, and raise a macOS notification so it is seen without
 * watching the log.
 */
import { execFile } from 'node:child_process'
import { PipelineHaltError, formatHalt } from './usageLimit'

/** AppleScript string literal: backslash and double quote escaped. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function reportHalt(err: PipelineHaltError, log: (msg: string) => void = console.log): void {
  const { block, notification } = formatHalt(err)
  log(block)
  process.exitCode = 1
  if (process.platform !== 'darwin') return
  try {
    execFile(
      'osascript',
      ['-e', `display notification ${appleScriptString(notification)} with title "Lifestyle Academy pipeline STOPPED" sound name "Basso"`],
      { timeout: 10_000 },
      () => {} // a failed notification must never mask the halt itself
    )
  } catch {
    // ignore
  }
}
