/**
 * Deepgram spend STATE — the ledger file, the real-balance lookup and the
 * reconcile-against-disk step. Everything that touches a file or the network
 * is here; the arithmetic is in `deepgramBudget.ts` (pure, tested).
 *
 * Extracted from `scripts/transcribeDeepgram.ts` (which spends) so that
 * `scripts/fetchPodcastFeed.ts --fit-budget` (which sizes a download slice to
 * what is left) reads the SAME remaining-credit figure the transcriber will
 * act on. Two scripts with two notions of "what is left" would let the
 * downloader fetch 9 GB the transcriber then cannot pay for — the problem this
 * module exists to prevent.
 *
 * Node-only (fs, url). Never import from app code.
 */
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEEPGRAM_RATE_PER_HOUR, resolveSpend } from './deepgramBudget'

/**
 * Spend ledger. The API key issued for this project lacks `usage:read`, so the
 * real balance CANNOT be queried — this is a self-tracked ESTIMATE from audio
 * duration times the published rate, and it is only as right as that rate.
 * Verify against the Deepgram dashboard before trusting it near the limit.
 *
 * It is a FILE, not an in-memory counter, because the counter resets to zero
 * every time the script restarts — and a budget that forgets what it already
 * spent is not a budget. Appended after every success, so a crash loses at most
 * the last episode's record.
 *
 * ONE ledger for the whole account, NOT one per output folder. Spend is billed
 * per account, so a per-folder ledger hands every new folder a fresh $200 —
 * which is not a cap, it is a cap-shaped decoration. Lives next to the repo by
 * default; override with DEEPGRAM_LEDGER when transcribing for a different
 * account.
 */
export type LedgerEntry = { key: string; model: string; hours: number; est_usd: number; at: string }

/**
 * `new URL('..', import.meta.url)` already resolves to the repo root from
 * lib/ (as it did from scripts/) — wrapping it in dirname() strips one level
 * too many and put the ledger in the home directory, where it read as $0 spent.
 */
export function defaultLedgerPath(): string {
  return process.env.DEEPGRAM_LEDGER ?? path.join(fileURLToPath(new URL('..', import.meta.url)), '.deepgram-spend.json')
}

/** Write atomically. A plain writeFile that is killed mid-flush leaves a
 *  0-byte file, and a 0-byte ledger is an unreadable ledger — which halts the
 *  next run. Observed exactly that on 2026-08-24 when the run was interrupted.
 *  Temp-then-rename makes the swap atomic, so the ledger is always either the
 *  previous good version or the new one. */
export async function writeLedger(file: string, entries: LedgerEntry[]): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(entries, null, 2))
  await rename(tmp, file)
}

export async function readLedger(file: string): Promise<LedgerEntry[]> {
  if (!existsSync(file)) return []
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LedgerEntry[]
  } catch {
    // A corrupt ledger must NOT read as $0 spent — that would silently uncap the
    // budget. Fail loudly instead.
    throw new Error(`spend ledger at ${file} is unreadable; refusing to run with an unknown balance`)
  }
}

/**
 * Ask Deepgram for the real remaining credit. Preferred over the ledger, which
 * is only an estimate of duration x published rate and has already drifted from
 * reality once (it read $3.31 against a charged $6.26).
 *
 * Returns null when the key lacks the scope — the first key issued for this
 * project could not read usage at all — so the caller falls back to the ledger
 * rather than treating "cannot read" as "nothing left" or "plenty left". Both
 * of those failure modes are worse than an estimate: one halts a funded run,
 * the other spends past the cap.
 */
export async function fetchRealBalance(key: string): Promise<{ balance: number; project: string } | null> {
  try {
    const pRes = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${key}` },
    })
    if (!pRes.ok) return null
    const projects = (await pRes.json())?.projects ?? []
    if (projects.length === 0) return null
    const project = projects[0].project_id as string

    const bRes = await fetch(`https://api.deepgram.com/v1/projects/${project}/balances`, {
      headers: { Authorization: `Token ${key}` },
    })
    if (!bRes.ok) return null
    const balances = (await bRes.json())?.balances ?? []
    if (balances.length === 0) return null
    // Sum every balance: an account can hold more than one (promotional credit
    // alongside pay-as-you-go).
    const total = balances.reduce((sum: number, b: { amount?: number }) => sum + (b.amount ?? 0), 0)
    return { balance: total, project }
  } catch {
    return null
  }
}

/**
 * RECONCILE AGAINST DISK FIRST. Every transcript that exists was BILLED,
 * whether or not the run that made it survived to record the fact. An aborted
 * run therefore leaves spend the ledger cannot see, and the cap silently
 * drifts under the real balance — it read $3.31 against a real $6.26 on
 * 2026-08-24 because four transcripts from killed runs were never recorded.
 * The transcripts on disk are the ground truth; the ledger is a cache of them.
 *
 * Mutates `ledger` in place (appends the recovered entries) and returns how
 * many it added plus the transcripts it could not read. Does NOT write the
 * ledger — the caller decides (a dry run must not).
 */
export async function reconcileLedgerFromDisk(
  ledger: LedgerEntry[],
  outDir: string
): Promise<{ recovered: number; unreadable: string[] }> {
  const known = new Set(ledger.map(e => `${e.key}|${e.model}`))
  const onDisk = (await readdir(outDir)).filter(f => f.endsWith('.deepgram.json'))
  let recovered = 0
  const unreadable: string[] = []
  for (const f of onDisk) {
    try {
      const d = JSON.parse(await readFile(path.join(outDir, f), 'utf8')) as {
        key?: string
        model?: string
        duration_seconds?: number
      }
      // The file records the SERVER's model name (`medical-nova-3`); the ledger
      // keys on the requested one, so normalise via the filename suffix.
      const m = f.includes('.nova-3-medical.') ? 'nova-3-medical' : (d.model ?? 'unknown')
      const id = `${d.key ?? f}|${m}`
      if (known.has(id)) continue
      const hours = (d.duration_seconds ?? 0) / 3600
      ledger.push({ key: d.key ?? f, model: m, hours, est_usd: hours * DEEPGRAM_RATE_PER_HOUR, at: new Date().toISOString() })
      known.add(id)
      recovered++
    } catch {
      // An unreadable transcript is not evidence of no spend, but it gives no
      // duration to charge either. Surface it rather than silently ignoring.
      unreadable.push(f)
    }
  }
  return { recovered, unreadable }
}

/** True when a transcript for `key` (any model suffix) already sits in `dirListing`. */
export function hasTranscript(dirListing: Iterable<string>, key: string): boolean {
  for (const f of dirListing) {
    if (f === `${key}.deepgram.json`) return true
    if (f.startsWith(`${key}.`) && f.endsWith('.deepgram.json')) return true
  }
  return false
}

export type CreditReport = {
  budgetUsd: number
  spentUsd: number
  remainingUsd: number
  /** Which figure `spentUsd` came from. */
  source: 'deepgram' | 'ledger'
  /** The ledger's own estimate, for the "would have said" line when the real balance won. */
  ledgerEstimateUsd: number
  ledgerPath: string
  /** The ledger as loaded (and reconciled); the transcriber keeps appending to this array. */
  ledger: LedgerEntry[]
  recovered: number
  unreadable: string[]
  /** Whether the recovered entries were written back (false on a dry run). */
  persisted: boolean
  real: { balance: number; project: string } | null
  /** Whether a key was available to ask Deepgram at all (false = ledger by necessity). */
  lookedUp: boolean
}

/**
 * Remaining credit, the way the transcriber computes it, for any caller:
 * load the ledger → reconcile it against the transcripts in `reconcileDir`
 * (persisting the recovered entries unless told not to) → ask Deepgram for the
 * real balance when a key is available → real balance wins, ledger is the
 * fallback (see `resolveSpend`).
 */
export async function remainingCredit(opts: {
  budgetUsd: number
  apiKey?: string
  ledgerPath?: string
  reconcileDir?: string
  /** False for a dry run: recovered entries are counted but the ledger file is left alone. */
  persistReconcile?: boolean
}): Promise<CreditReport> {
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath()
  const ledger = await readLedger(ledgerPath)

  let recovered = 0
  let unreadable: string[] = []
  let persisted = false
  if (opts.reconcileDir && existsSync(opts.reconcileDir)) {
    ;({ recovered, unreadable } = await reconcileLedgerFromDisk(ledger, opts.reconcileDir))
    if (recovered > 0 && opts.persistReconcile !== false) {
      await writeLedger(ledgerPath, ledger)
      persisted = true
    }
  }

  const ledgerEstimateUsd = ledger.reduce((s, e) => s + e.est_usd, 0)
  const real = opts.apiKey ? await fetchRealBalance(opts.apiKey) : null
  const { spentUsd, remainingUsd, source } = resolveSpend({
    budgetUsd: opts.budgetUsd,
    ledgerEstimateUsd,
    realBalanceUsd: real?.balance ?? null,
  })

  return {
    budgetUsd: opts.budgetUsd,
    spentUsd,
    remainingUsd,
    source,
    ledgerEstimateUsd,
    ledgerPath,
    ledger,
    recovered,
    unreadable,
    persisted,
    real,
    lookedUp: Boolean(opts.apiKey),
  }
}

/** The lines both scripts print to say where the remaining-credit figure came from. */
export function describeCredit(c: CreditReport): string[] {
  const lines: string[] = []
  for (const f of c.unreadable) lines.push(`  warning: could not read ${f} while reconciling spend`)
  if (c.recovered > 0) {
    lines.push(
      c.persisted
        ? `reconciled ${c.recovered} untracked transcript(s) into the spend ledger`
        : `dry run: ${c.recovered} untracked transcript(s) counted as spent but not written to the ledger`
    )
  }
  if (c.real) {
    lines.push(
      `REAL balance from Deepgram: $${c.real.balance.toFixed(2)} remaining` +
        ` (ledger estimate would have said $${Math.max(0, c.budgetUsd - c.ledgerEstimateUsd).toFixed(2)})`
    )
    if (c.real.balance > c.budgetUsd) {
      lines.push(`capped at --budget $${c.budgetUsd.toFixed(2)} — raise it to spend more of the balance`)
    }
  } else {
    lines.push(
      `budget $${c.budgetUsd.toFixed(2)} | spent ~$${c.spentUsd.toFixed(2)} | remaining ~$${c.remainingUsd.toFixed(2)}`
    )
    lines.push(
      c.lookedUp
        ? `(ESTIMATE from duration x $${DEEPGRAM_RATE_PER_HOUR}/h — this key cannot read real usage; ` +
            `an owner key would replace this with the real balance)`
        : `(ESTIMATE from duration x $${DEEPGRAM_RATE_PER_HOUR}/h — no DEEPGRAM_API_KEY in the environment, ` +
            `so the real balance was not looked up)`
    )
    if (c.ledger.length === 0) {
      lines.push(
        `WARNING: the ledger at ${c.ledgerPath} is empty and no real balance could be read, ` +
          `so remaining credit is assumed to equal --budget. Check the Deepgram dashboard first.`
      )
    }
  }
  return lines
}
