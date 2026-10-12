/**
 * Ranks the Workbench: the one thing Paul should do now, then the rest in order.
 *
 * Pure and unit-tested (tests/workbench.test.ts). The admin page loads the
 * counts; this module decides the order and writes the copy. Every string here
 * is read by Paul on a phone between cases, so it is plain language, one line,
 * with a realistic time estimate — no file paths, no jargon.
 *
 * Priority, highest first:
 *   P0  the pipeline needs attention (failed / stuck jobs, orphaned sources)
 *   P1  fidelity re-checks — certifies the accuracy judge
 *   P2  topic approvals
 *   P3  accuracy flags
 *   P4  unreviewed topics
 *   P5  merge reviews — currently HELD, see MERGE_REVIEWS_HELD
 *
 * A count of null means "could not be loaded". It is never treated as zero:
 * zero goes to the Clear list, null renders as unknown with a note.
 */

/**
 * Paul's decision 2026-10-11: hold the merge-review queue until the
 * caption-transcript redo has run; 117 of the 213 pending pairs involve claims
 * that redo retires. Flip to false when the redo is done.
 */
export const MERGE_REVIEWS_HELD = true

/**
 * A `running` job whose heartbeat (`locked_at`) is older than this is stuck.
 * The worker reclaims a stale job after 10 minutes on its next tick, so one
 * still untouched at 15 means no tick is running — Claude has to look.
 */
export const STUCK_JOB_MINUTES = 15

export type WorkbenchCounts = {
  /** Pending merge reviews (`merge_reviews.status = 'pending'`). */
  mergeReviews: number | null
  /** Pending topic proposals. */
  topicProposals: number | null
  /** Open accuracy flags (`claim_flags.resolved_at IS NULL`). */
  openFlags: number | null
  /** Active topics not yet reviewed by a human. */
  unreviewedTopics: number | null
  /** Fidelity worksheet pairs with no label yet. */
  fidelityUnlabeled: number | null
  /** Labelled pairs where Paul and the AI judge disagree and he has not re-read it. */
  fidelityRechecks: number | null
  /** Jobs queued or running — the pipeline is working when this is above zero. */
  openJobs: number | null
  /** Jobs that failed permanently. */
  failedJobs: number | null
  /** Running jobs whose heartbeat is older than STUCK_JOB_MINUTES. */
  stuckJobs: number | null
  /** Sources marked `processing` with no queued or running job to finish them. */
  orphanedSources: number | null
}

export type WorkbenchKey = "pipeline" | "fidelity" | "proposals" | "flags" | "topics" | "merges"

export type WorkbenchItem = {
  key: WorkbenchKey
  /** One line, imperative, with the live count when there is one. */
  title: string
  href: string
  /** null = the count could not be loaded. Never conflate with zero. */
  count: number | null
  /** One line on why it matters. */
  why: string
  /** Realistic, in Paul's terms: "about 1 min each". */
  timeEstimate: string
  /** 0 is the most urgent. */
  priority: number
  /** Present when the queue is deliberately parked; a held item is never the top item. */
  held?: { reason: string }
}

export type PipelineState = "needs-attention" | "working" | "idle" | "unknown"

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** `3 failed jobs`, `1 stuck job`, … — only the parts that are above zero. */
function describePipelineTrouble(failed: number | null, stuck: number | null, orphaned: number | null): string {
  const parts: string[] = []
  if (failed) parts.push(`${failed} failed ${plural(failed, "job", "jobs")}`)
  if (stuck) parts.push(`${stuck} stuck ${plural(stuck, "job", "jobs")}`)
  if (orphaned) parts.push(`${orphaned} ${plural(orphaned, "source", "sources")} stuck mid-extraction`)
  if (parts.length <= 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/**
 * The P0 count: everything wrong with the pipeline, added up.
 *
 * If no signal loaded the count is unknown. If some loaded and found trouble,
 * that trouble is real even though the rest is unknown. If some loaded and all
 * of them were clear, the answer is still unknown — a missing signal could be
 * hiding the problem.
 */
function pipelineTroubleCount(failed: number | null, stuck: number | null, orphaned: number | null): number | null {
  const known = [failed, stuck, orphaned].filter((n): n is number => n !== null)
  if (known.length === 0) return null
  const total = known.reduce((sum, n) => sum + n, 0)
  if (total === 0 && known.length < 3) return null
  return total
}

function fidelityTitle(unlabeled: number | null, rechecks: number | null): string {
  const u = unlabeled ?? 0
  const r = rechecks ?? 0
  if (u > 0 && r > 0) return `Rule on ${u} ${plural(u, "fact", "facts")} and re-check ${r} the AI judge disagreed with`
  if (u > 0) return `Rule on ${u} ${plural(u, "fact", "facts")}: does each match its transcript?`
  if (r > 0) return `Re-check ${r} ${plural(r, "fact", "facts")} the AI judge disagreed with`
  return "Re-check the facts the AI judge disagreed with"
}

/** `Approve or reject 4 proposed topics`, or the generic form when there is no live count. */
function countedTitle(count: number | null, generic: string, withCount: (n: number) => string): string {
  return count !== null && count > 0 ? withCount(count) : generic
}

/**
 * Where an item sits in the ranked list. Lower sorts first; ties break on priority.
 *   0  actionable — a live count above zero, not held
 *   1  unknown — the count could not be loaded (never shown as clear)
 *   2  held — deliberately parked, whatever its count (unless it is zero)
 *   3  clear — nothing waiting
 */
function bucketOf(item: WorkbenchItem): number {
  if (item.count === 0) return 3
  if (item.held) return 2
  if (item.count === null) return 1
  return 0
}

export function isActionable(item: WorkbenchItem): boolean {
  return bucketOf(item) === 0
}

/**
 * Build every Workbench item from the loaded counts and sort them so the first
 * one is what Paul should do now. Held and unknown items never come first.
 */
export function rankWorkbench(
  counts: WorkbenchCounts,
  options: { mergeReviewsHeld?: boolean } = {}
): WorkbenchItem[] {
  const { mergeReviewsHeld = MERGE_REVIEWS_HELD } = options

  const trouble = pipelineTroubleCount(counts.failedJobs, counts.stuckJobs, counts.orphanedSources)
  const troubleText = describePipelineTrouble(counts.failedJobs, counts.stuckJobs, counts.orphanedSources)

  const fidelityCount =
    counts.fidelityUnlabeled === null || counts.fidelityRechecks === null
      ? null
      : counts.fidelityUnlabeled + counts.fidelityRechecks

  const items: WorkbenchItem[] = [
    {
      key: "pipeline",
      title: "The pipeline needs attention",
      href: "/admin/sources",
      count: trouble,
      why: troubleText
        ? `${troubleText} — you can't fix these from here; tell Claude "check the pipeline".`
        : `Failed or stuck pipeline work — you can't fix it from here; tell Claude "check the pipeline".`,
      timeEstimate: "about 1 min — one message to Claude",
      priority: 0,
    },
    {
      key: "fidelity",
      title: fidelityTitle(counts.fidelityUnlabeled, counts.fidelityRechecks),
      href: "/admin/fidelity",
      count: fidelityCount,
      why: "Settles whether the accuracy judge can be trusted to quarantine facts on its own",
      timeEstimate: "about 2 min each",
      priority: 1,
    },
    {
      key: "proposals",
      title: countedTitle(
        counts.topicProposals,
        "Approve or reject proposed topics",
        n => `Approve or reject ${n} proposed ${plural(n, "topic", "topics")}`
      ),
      href: "/admin/topics/proposals",
      count: counts.topicProposals,
      why: "New sections of the library the AI wants to open — nothing is created until you say yes",
      timeEstimate: "about 1 min each",
      priority: 2,
    },
    {
      key: "flags",
      title: countedTitle(
        counts.openFlags,
        "Keep or dismiss accuracy flags",
        n => `Keep or dismiss ${n} accuracy ${plural(n, "flag", "flags")}`
      ),
      href: "/admin/flags",
      count: counts.openFlags,
      why: "Facts that may overstate what the source actually said",
      timeEstimate: "about 1 min each",
      priority: 3,
    },
    {
      key: "topics",
      title: countedTitle(
        counts.unreviewedTopics,
        "Sign off the topics the AI created",
        n => `Sign off ${n} ${plural(n, "topic", "topics")} the AI created`
      ),
      href: "/admin/topics",
      count: counts.unreviewedTopics,
      why: "Fold thin ones into their parent; the rest just need your OK",
      timeEstimate: "about 1 min each",
      priority: 4,
    },
    {
      key: "merges",
      title: countedTitle(
        counts.mergeReviews,
        "Decide possible duplicate pairs",
        n => `Decide ${n} possible duplicate ${plural(n, "pair", "pairs")}`
      ),
      href: "/admin/reviews",
      count: counts.mergeReviews,
      why: "Fact pairs the pipeline could not confidently call duplicates — keep both, or merge them",
      timeEstimate: "about 1 min each",
      priority: 5,
      ...(mergeReviewsHeld
        ? {
            held: {
              reason:
                "On hold until the caption-transcript redo has run — most of these pairs involve facts that redo will retire (your call, 11 Oct 2026).",
            },
          }
        : {}),
    },
  ]

  return items.sort((a, b) => bucketOf(a) - bucketOf(b) || a.priority - b.priority)
}

export type WorkbenchSections = {
  /** The one thing to do now, or null when nothing actionable loaded. */
  now: WorkbenchItem | null
  /** The remaining actionable items, in order. */
  later: WorkbenchItem[]
  /** Counts that could not be loaded — shown as unknown, never as clear. */
  unknown: WorkbenchItem[]
  /** Deliberately parked, with the reason. */
  held: WorkbenchItem[]
  /** Nothing waiting. */
  clear: WorkbenchItem[]
}

/** Split a ranked list into the sections the page renders. */
export function groupWorkbench(items: WorkbenchItem[]): WorkbenchSections {
  const actionable = items.filter(isActionable)
  return {
    now: actionable[0] ?? null,
    later: actionable.slice(1),
    unknown: items.filter(i => bucketOf(i) === 1),
    held: items.filter(i => bucketOf(i) === 2),
    clear: items.filter(i => bucketOf(i) === 3),
  }
}

/** One line on the pipeline, for when nothing needs Paul. */
export function pipelineState(counts: WorkbenchCounts): { state: PipelineState; label: string } {
  const trouble = pipelineTroubleCount(counts.failedJobs, counts.stuckJobs, counts.orphanedSources)
  if (trouble !== null && trouble > 0) {
    return { state: "needs-attention", label: `The pipeline needs attention — tell Claude "check the pipeline".` }
  }
  if (counts.openJobs === null) {
    return { state: "unknown", label: "The pipeline's status is unknown — the queue count could not be loaded." }
  }
  if (counts.openJobs > 0) {
    return {
      state: "working",
      label: `The pipeline is working — ${counts.openJobs} ${plural(counts.openJobs, "job", "jobs")} in the queue.`,
    }
  }
  return { state: "idle", label: "The pipeline is idle — nothing queued." }
}
