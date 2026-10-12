/**
 * Deepgram credit arithmetic, shared by the audio downloader
 * (`scripts/fetchPodcastFeed.ts --fit-budget`) and the transcriber
 * (`scripts/transcribeDeepgram.ts`).
 *
 * PURE. No I/O, no env, no network. The spend ledger, the real-balance lookup
 * and the reconcile-against-disk step live in `deepgramSpend.ts`; this module
 * only answers "given this much credit, which of these episodes can we afford,
 * in this order?" — so it can be unit-tested without a feed, a key or a file.
 *
 * WHY GREEDY IN ORDER, NOT BEST-FIT. The caller's order IS the priority
 * (newest first, or a hand-written key list), and an episode that does not fit
 * is SKIPPED rather than ending the walk, so a shorter episode further down can
 * still use what is left. Before this the transcriber stopped at the first
 * unaffordable file and left smaller, affordable episodes untranscribed while
 * credit sat unused. Knapsack-optimal packing would squeeze a little more audio
 * out of the same money but would silently reorder the priorities, and on a
 * $200 budget the difference is a fraction of one episode.
 *
 * WHY A MARGIN. Every cost here is an ESTIMATE: duration tags are rounded, and
 * an episode with no tag is sized from its byte count at an assumed bitrate.
 * Deepgram bills on the audio it actually measures, and a pay-as-you-go account
 * that runs past its prepaid balance bills the card. A quarter-dollar margin
 * (~45 min at the published rate) keeps the last chosen episode from tipping
 * the account past zero. Pass `--margin 0` to spend to the cent.
 */

/** $0.26/h nova-3 + $0.08/h keyterm prompting, pre-recorded pay-as-you-go. */
export const DEEPGRAM_RATE_PER_HOUR = 0.34

/** Safety margin kept unspent so an estimate's rounding error never overspends. */
export const DEFAULT_MARGIN_USD = 0.25

/** Observed constant bitrate of the feed's enclosures; used when no duration tag exists. */
export const ASSUMED_BITRATE_BPS = 128_000

export type BudgetItem = {
  /** Join key (`attia-0239`); only used for reporting. */
  key: string
  /** Estimated audio length. Must be finite and > 0 to be budgetable. */
  hours: number
  /** True when `hours` came from a byte count rather than a duration tag. */
  estimated?: boolean
}

export type SkipReason =
  /** Would take the running total past the spendable amount. */
  | 'over-budget'
  /** No duration tag and no byte count — cannot be priced, so never chosen. */
  | 'no-estimate'

export type ChosenItem<T extends BudgetItem> = T & { estUsd: number; cumulativeUsd: number }
export type SkippedItem<T extends BudgetItem> = T & { estUsd: number; reason: SkipReason }

export type FitResult<T extends BudgetItem> = {
  /** Items that fit, in input order, each with its cost and the running total after it. */
  chosen: ChosenItem<T>[]
  /** Items that did not fit, in input order, with why. */
  skipped: SkippedItem<T>[]
  /** `remainingUsd - marginUsd`, floored at zero: what the walk was allowed to commit. */
  spendableUsd: number
  chosenUsd: number
  chosenHours: number
  /** Cost of the items skipped for budget alone — the top-up that would cover them. */
  overBudgetUsd: number
  overBudgetHours: number
}

export type Verdict =
  | { ok: true; estUsd: number }
  | { ok: false; estUsd: number; reason: SkipReason }

export function estimateCostUsd(hours: number, ratePerHour: number): number {
  return hours * ratePerHour
}

/** Bytes of audio → hours at a constant bitrate. 57.6 MB at 128 kbps is one hour. */
export function hoursFromBytes(bytes: number, bitrateBps = ASSUMED_BITRATE_BPS): number {
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(bitrateBps) || bitrateBps <= 0) return 0
  return (bytes * 8) / bitrateBps / 3600
}

/**
 * The feed's duration rule, in one place: <itunes:duration> when present and
 * non-zero, else enclosure bytes at the assumed bitrate, else nothing. Empty or
 * zero reads as MISSING, not as zero — only 174 of the Attia feed's 425 items
 * carry the tag, and treating the rest as zero once under-reported the
 * catalogue by half. `estimated` says which rule fired so a caller can report
 * how much of a total is measured and how much inferred.
 */
export function estimateHours(
  item: { duration_seconds?: number | null; audio_bytes?: number | null },
  bitrateBps = ASSUMED_BITRATE_BPS
): { hours: number; estimated: boolean } | null {
  if (item.duration_seconds) return { hours: item.duration_seconds / 3600, estimated: false }
  if (item.audio_bytes) return { hours: hoursFromBytes(item.audio_bytes, bitrateBps), estimated: true }
  return null
}

/**
 * One item against what is left. This is THE decision, shared by the plan
 * (`fitEpisodesToBudget`) and by the transcriber's live loop, which re-asks it
 * per file with the real spend so far — so a plan and a run can never disagree
 * about whether a file fits.
 */
export function assessItem(
  item: BudgetItem,
  remainingUsd: number,
  ratePerHour: number,
  marginUsd = DEFAULT_MARGIN_USD
): Verdict {
  if (!Number.isFinite(item.hours) || item.hours <= 0) return { ok: false, estUsd: 0, reason: 'no-estimate' }
  const estUsd = estimateCostUsd(item.hours, ratePerHour)
  const spendable = (Number.isFinite(remainingUsd) ? remainingUsd : 0) - Math.max(0, marginUsd)
  if (estUsd > spendable) return { ok: false, estUsd, reason: 'over-budget' }
  return { ok: true, estUsd }
}

/**
 * Walk `items` in order, choosing each one that still fits `remainingUsd` less
 * the margin and skipping (not stopping at) each one that does not. Zero or
 * negative credit chooses nothing. Items with no usable duration are skipped
 * with `no-estimate` and never counted toward the top-up figure, because there
 * is no price to add.
 */
export function fitEpisodesToBudget<T extends BudgetItem>(
  items: T[],
  remainingUsd: number,
  ratePerHour: number,
  marginUsd = DEFAULT_MARGIN_USD
): FitResult<T> {
  const spendableUsd = Math.max(0, (Number.isFinite(remainingUsd) ? remainingUsd : 0) - Math.max(0, marginUsd))
  const chosen: ChosenItem<T>[] = []
  const skipped: SkippedItem<T>[] = []
  let chosenUsd = 0
  let chosenHours = 0
  let overBudgetUsd = 0
  let overBudgetHours = 0
  let left = remainingUsd

  for (const item of items) {
    const verdict = assessItem(item, left, ratePerHour, marginUsd)
    if (verdict.ok) {
      chosenUsd += verdict.estUsd
      chosenHours += item.hours
      left -= verdict.estUsd
      chosen.push({ ...item, estUsd: verdict.estUsd, cumulativeUsd: chosenUsd })
    } else {
      if (verdict.reason === 'over-budget') {
        overBudgetUsd += verdict.estUsd
        overBudgetHours += item.hours
      }
      skipped.push({ ...item, estUsd: verdict.estUsd, reason: verdict.reason })
    }
  }

  return { chosen, skipped, spendableUsd, chosenUsd, chosenHours, overBudgetUsd, overBudgetHours }
}

/**
 * Spent and remaining credit from the two sources the transcriber trusts, in
 * their order of precedence: the REAL balance from Deepgram when the key can
 * read it, else the ledger's estimate. `budgetUsd` is the cap the operator
 * passed (`--budget`); with a real balance it is "spend at most this much of
 * what is there", with the ledger it is "the account was funded to this".
 * Neither figure can go negative: a balance above the cap reads as nothing
 * spent, and spend past the cap reads as nothing left.
 */
export function resolveSpend(opts: {
  budgetUsd: number
  ledgerEstimateUsd: number
  realBalanceUsd: number | null
}): { spentUsd: number; remainingUsd: number; source: 'deepgram' | 'ledger' } {
  const budget = Math.max(0, Number.isFinite(opts.budgetUsd) ? opts.budgetUsd : 0)
  const ledger = Math.max(0, Number.isFinite(opts.ledgerEstimateUsd) ? opts.ledgerEstimateUsd : 0)
  if (opts.realBalanceUsd != null && Number.isFinite(opts.realBalanceUsd)) {
    const spentUsd = Math.max(0, budget - opts.realBalanceUsd)
    return { spentUsd, remainingUsd: Math.max(0, budget - spentUsd), source: 'deepgram' }
  }
  return { spentUsd: ledger, remainingUsd: Math.max(0, budget - ledger), source: 'ledger' }
}

/**
 * The `--budget` that would let a later run cover what this one skipped:
 * everything spent so far, plus the skipped items, plus the margin, rounded UP
 * to the cent so the figure printed is one that actually works.
 */
export function budgetToCover(runningUsd: number, extraUsd: number, marginUsd = DEFAULT_MARGIN_USD): number {
  const total = Math.max(0, runningUsd) + Math.max(0, extraUsd) + Math.max(0, marginUsd)
  // toFixed first so floating-point noise (12.340000000000002) does not round up a cent.
  return Math.ceil(Number((total * 100).toFixed(6))) / 100
}

const usd = (n: number) => `$${n.toFixed(2)}`
const hrs = (item: BudgetItem) => `${item.estimated ? '~' : ''}${item.hours.toFixed(2)}`

/**
 * The plan as printable lines (indented two spaces, no trailing newline).
 * `label` adds per-item context such as a title — never anything that could
 * carry a URL.
 */
export function describeFit<T extends BudgetItem>(
  fit: FitResult<T>,
  opts: { ratePerHour: number; label?: (item: T) => string } = { ratePerHour: DEEPGRAM_RATE_PER_HOUR }
): string[] {
  const lines: string[] = []
  const keyWidth = Math.max(3, ...fit.chosen.map(c => c.key.length), ...fit.skipped.map(s => s.key.length))
  lines.push(
    `  spendable ${usd(fit.spendableUsd)} at $${opts.ratePerHour}/h` +
      ` (~ = hours estimated from file size at ${ASSUMED_BITRATE_BPS / 1000} kbps)`
  )
  if (fit.chosen.length === 0) {
    lines.push('  nothing fits')
  } else {
    lines.push(`  ${'#'.padStart(4)}  ${'key'.padEnd(keyWidth)}  ${'hours'.padStart(7)}  ${'est $'.padStart(7)}  ${'running $'.padStart(10)}`)
    fit.chosen.forEach((c, i) => {
      const extra = opts.label ? `  ${opts.label(c)}` : ''
      lines.push(
        `  ${String(i + 1).padStart(4)}  ${c.key.padEnd(keyWidth)}  ${hrs(c).padStart(7)}  ` +
          `${c.estUsd.toFixed(2).padStart(7)}  ${c.cumulativeUsd.toFixed(2).padStart(10)}${extra}`
      )
    })
    lines.push(`  chosen: ${fit.chosen.length} episode(s), ${fit.chosenHours.toFixed(1)} h, ~${usd(fit.chosenUsd)}`)
  }
  const over = fit.skipped.filter(s => s.reason === 'over-budget')
  if (over.length > 0) {
    lines.push(
      `  skipped for budget: ${over.length} episode(s), ${fit.overBudgetHours.toFixed(1)} h, ~${usd(fit.overBudgetUsd)}`
    )
    for (const s of over) {
      const extra = opts.label ? `  ${opts.label(s)}` : ''
      lines.push(`        ${s.key.padEnd(keyWidth)}  ${hrs(s).padStart(7)}  ${s.estUsd.toFixed(2).padStart(7)}${extra}`)
    }
  }
  const unpriced = fit.skipped.filter(s => s.reason === 'no-estimate')
  if (unpriced.length > 0) {
    lines.push(`  skipped, no duration or size to price them: ${unpriced.map(s => s.key).join(', ')}`)
  }
  return lines
}
