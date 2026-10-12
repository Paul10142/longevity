import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { supabaseAdmin } from "@/lib/supabaseServer"
import fidelityPairs from "@/eval/extraction-eval-pairs.json"
import judgeRun from "@/eval/extraction-run.json"
import { pendingRechecks, type FidelityLabel } from "@/lib/fidelity"
import {
  STUCK_JOB_MINUTES,
  groupWorkbench,
  pipelineState,
  rankWorkbench,
  type WorkbenchCounts,
  type WorkbenchItem,
} from "@/lib/workbench"

// Counts are live — never serve a cached to-do list.
export const dynamic = "force-dynamic"

/**
 * Supabase Pro includes 8 GB of database disk (the org upgraded 2026-08-14).
 *
 * This was 500 MB — the FREE-plan ceiling, where the database flips to read-only.
 * On Pro neither the number nor the consequence holds: past the included disk
 * Supabase bills for the overage, it does not lock the database. Left stale, the
 * card read "448 MB of the 500 MB plan limit (90%) — Critical", which is a
 * false alarm about a plan that no longer applies.
 */
const STORAGE_CAP_MB = 8 * 1024

/**
 * overnightExtract's default `--max-mb` brake. Extraction halts itself here,
 * well before the included disk runs out, so this is the number that actually
 * governs a run — the cap above is just the billing boundary.
 */
const EXTRACTION_BRAKE_MB = 6000

/** An unknown count renders as a dash, never as zero. */
const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString())

type Stat = { name: string; value: string; description: string }

/**
 * Count rows, or null if the query failed.
 *
 * Deliberately NOT `?? 0`: on a to-do dashboard a swallowed error would render
 * as "Queue clear" and quietly tell the reader there is nothing waiting on them.
 * An unknown count has to look different from an empty one.
 */
async function countOf(
  table: string,
  apply: (q: ReturnType<NonNullable<typeof supabaseAdmin>["from"]>) => unknown
): Promise<number | null> {
  if (!supabaseAdmin) return null
  try {
    // head:true → the row payload is discarded server-side; we only want the count.
    const query = apply(supabaseAdmin.from(table))
    const { count, error } = (await query) as { count: number | null; error: unknown }
    if (error) {
      console.error(`[admin dashboard] count failed for ${table}:`, error)
      return null
    }
    return count ?? 0
  } catch (err) {
    console.error(`[admin dashboard] count threw for ${table}:`, err)
    return null
  }
}

/**
 * Sources marked `processing` that no queued or running job will ever finish.
 *
 * Extraction sets a source to `processing` when it starts and to `succeeded`
 * or `failed` when it ends — but only if the handler gets to run its catch
 * block. A worker killed mid-flight, or a job deleted by hand, leaves the
 * source "Extracting…" forever with nothing behind it. PostgREST cannot express
 * that anti-join as one count, so this is two small reads: the processing
 * sources (a handful at most — they are transient, not a set that grows with
 * the corpus) and the open jobs that point at them. Same rule as countOf: null
 * on any error, never zero.
 */
async function countOrphanedProcessingSources(): Promise<number | null> {
  if (!supabaseAdmin) return null
  try {
    const { data: processing, error } = await supabaseAdmin
      .from("sources")
      .select("id")
      .eq("processing_status", "processing")
    if (error) {
      console.error("[admin dashboard] processing sources read failed:", error)
      return null
    }
    const ids = ((processing ?? []) as { id: string }[]).map(r => r.id)
    if (ids.length === 0) return 0

    const { data: jobs, error: jobsError } = await supabaseAdmin
      .from("jobs")
      .select("payload")
      .in("status", ["queued", "running"])
      .in("payload->>source_id", ids)
    if (jobsError) {
      console.error("[admin dashboard] open jobs by source read failed:", jobsError)
      return null
    }
    const covered = new Set(
      ((jobs ?? []) as { payload: { source_id?: unknown } | null }[]).map(j => j.payload?.source_id)
    )
    return ids.filter(id => !covered.has(id)).length
  } catch (err) {
    console.error("[admin dashboard] orphaned source count threw:", err)
    return null
  }
}

async function loadDashboard() {
  if (!supabaseAdmin) {
    return { counts: null, stats: [] as Stat[], storage: null, configured: false }
  }
  const db = supabaseAdmin
  // A running job the worker has not touched for this long is stuck (see lib/workbench).
  const stuckBefore = new Date(Date.now() - STUCK_JOB_MINUTES * 60_000).toISOString()

  const [
    mergeReviews,
    topicProposals,
    openFlags,
    unreviewedTopics,
    fidelityLabels,
    pendingSources,
    untaggedClaims,
    activeClaims,
    openJobs,
    failedJobs,
    stuckJobs,
    orphanedSources,
    sizeResult,
  ] = await Promise.all([
    countOf("merge_reviews", q => q.select("id", { count: "exact", head: true }).eq("status", "pending")),
    countOf("topic_proposals", q => q.select("id", { count: "exact", head: true }).eq("status", "pending")),
    countOf("claim_flags", q => q.select("id", { count: "exact", head: true }).is("resolved_at", null)),
    countOf("topics", q =>
      q.select("id", { count: "exact", head: true }).eq("status", "active").eq("reviewed_by_human", false)
    ),
    // Rows, not a count: the tile also needs which rulings disagree with the judge.
    (async (): Promise<FidelityLabel[] | null> => {
      const { data, error } = await db.from("fidelity_labels").select("pair_id, label, updated_at")
      if (error) {
        console.error("[admin dashboard] fidelity_labels read failed:", error)
        return null
      }
      return (data ?? []) as FidelityLabel[]
    })(),
    countOf("sources", q => q.select("id", { count: "exact", head: true }).eq("processing_status", "pending")),
    countOf("claims", q =>
      q.select("id", { count: "exact", head: true }).eq("status", "active").eq("needs_tagging", true)
    ),
    countOf("claims", q => q.select("id", { count: "exact", head: true }).eq("status", "active")),
    countOf("jobs", q => q.select("id", { count: "exact", head: true }).in("status", ["queued", "running"])),
    // The P0 signals: work the pipeline cannot recover from on its own.
    countOf("jobs", q => q.select("id", { count: "exact", head: true }).eq("status", "failed")),
    countOf("jobs", q =>
      q.select("id", { count: "exact", head: true }).eq("status", "running").lt("locked_at", stuckBefore)
    ),
    countOrphanedProcessingSources(),
    db.rpc("database_size_bytes"),
  ])

  // Labelling every pair is not the end of the worksheet: rulings that disagree
  // with the AI judge need a second look before it can be certified. Counting
  // only unlabelled pairs hid those 9 re-checks under "All labeled" for weeks.
  const fidelityUnlabeled =
    fidelityLabels === null ? null : Math.max(0, fidelityPairs.length - fidelityLabels.length)
  const fidelityRechecks =
    fidelityLabels === null
      ? null
      : pendingRechecks(fidelityLabels, new Map(judgeRun.map(r => [r.id, r.verdict]))).size

  const counts: WorkbenchCounts = {
    mergeReviews,
    topicProposals,
    openFlags,
    unreviewedTopics,
    fidelityUnlabeled,
    fidelityRechecks,
    openJobs,
    failedJobs,
    stuckJobs,
    orphanedSources,
  }

  const sizeBytes = typeof sizeResult === "object" && sizeResult && "data" in sizeResult
    ? Number((sizeResult as { data: unknown }).data ?? 0)
    : 0
  const usedMb = sizeBytes > 0 ? sizeBytes / 1024 / 1024 : null

  const stats: Stat[] = [
    { name: "Sources awaiting extraction", value: fmt(pendingSources), description: "Processed automatically by the pipeline — no action needed from you." },
    { name: "Active claims", value: fmt(activeClaims), description: "Deduplicated facts currently in the library." },
    { name: "Claims awaiting filing", value: fmt(untaggedClaims), description: "Extracted but not yet sorted into topics; a bulk pass handles these." },
    {
      name: "Jobs in the queue",
      value: fmt(openJobs),
      description:
        openJobs === null ? "Queue status unavailable." : openJobs > 0 ? "The pipeline is working." : "The pipeline is idle.",
    },
  ]

  return { counts, stats, storage: usedMb, configured: true }
}

/** "3 items", "1 item" — or "unknown" when the count could not be loaded. */
function countLabel(item: WorkbenchItem): string {
  if (item.count === null) return "unknown"
  return `${fmt(item.count)} ${item.count === 1 ? "item" : "items"}`
}

/**
 * One ranked queue as a row. `tone` dims parked and unknown queues so the live
 * ones stand out; `note` is the small print under the title.
 */
function QueueRow({
  item,
  index,
  tone,
  note,
}: {
  item: WorkbenchItem
  index?: number
  tone: "live" | "muted"
  note: string
}) {
  const live = tone === "live"
  return (
    <li>
      <Link
        href={item.href}
        className={`block rounded-lg border p-4 transition-colors ${
          live ? "bg-card hover:border-foreground/40" : "border-dashed bg-muted/30 hover:border-foreground/20"
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className={`font-semibold ${live ? "" : "text-muted-foreground"}`}>
            {index !== undefined && <span className="mr-2 tabular-nums text-muted-foreground">{index}.</span>}
            {item.title}
          </span>
          {item.count === null ? (
            <span className="text-xs text-muted-foreground whitespace-nowrap">unknown</span>
          ) : (
            <span className={`text-xl font-bold tabular-nums ${live ? "" : "text-muted-foreground"}`}>
              {fmt(item.count)}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">{note}</p>
      </Link>
    </li>
  )
}

export default async function AdminHomePage() {
  const { counts, stats, storage, configured } = await loadDashboard()
  const sections = groupWorkbench(counts ? rankWorkbench(counts) : [])
  const { now, later, unknown, held, clear } = sections
  const pipeline = counts ? pipelineState(counts) : null

  const outstanding = [...(now ? [now] : []), ...later].reduce((sum, i) => sum + (i.count ?? 0), 0)
  const heldTotal = held.reduce((sum, i) => sum + (i.count ?? 0), 0)
  const storagePct = storage === null ? null : Math.min(100, (storage / STORAGE_CAP_MB) * 100)

  // The one-line summary under the title. Unknown counts are named, never
  // folded into "nothing is waiting" — that sentence would be a lie.
  const summary = (() => {
    if (!configured) return "Database not configured — counts unavailable."
    const parts: string[] = []
    if (outstanding > 0) {
      parts.push(`${outstanding.toLocaleString()} ${outstanding === 1 ? "item needs" : "items need"} you`)
    } else if (unknown.length === 0) {
      parts.push("Nothing is waiting on you right now")
    }
    if (unknown.length > 0) {
      parts.push(`${unknown.length} ${unknown.length === 1 ? "count" : "counts"} could not be loaded — refresh to retry`)
    }
    if (heldTotal > 0) parts.push(`${heldTotal.toLocaleString()} on hold`)
    return `${parts.join(" · ")}.`
  })()

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-10">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Workbench</h1>
              <p className="text-muted-foreground mt-2">{summary}</p>
            </div>

            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Do this now</h2>
              {now ? (
                <Card className={now.priority === 0 ? "border-destructive/60" : "border-foreground/30"}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-xl leading-snug">{now.title}</CardTitle>
                    <CardDescription>{now.why}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Button asChild>
                      <Link href={now.href}>Open</Link>
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      {countLabel(now)} · {now.timeEstimate}
                    </span>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-xl leading-snug">
                      {!configured
                        ? "Counts unavailable"
                        : unknown.length > 0
                          ? "Nothing we could count needs you right now"
                          : "Nothing needs you right now"}
                    </CardTitle>
                    <CardDescription>
                      {!configured
                        ? "The database is not configured, so nothing could be checked."
                        : pipeline?.label}
                      {configured && unknown.length > 0 && " Some counts could not be loaded — see below."}
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </section>

            {later.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">After that</h2>
                <ol className="space-y-2">
                  {later.map((item, i) => (
                    <QueueRow
                      key={item.key}
                      item={item}
                      index={i + 2}
                      tone="live"
                      note={`${item.why} · ${item.timeEstimate}`}
                    />
                  ))}
                </ol>
              </section>
            )}

            {unknown.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">Could not be checked</h2>
                <ul className="space-y-2">
                  {unknown.map(item => (
                    <QueueRow
                      key={item.key}
                      item={item}
                      tone="muted"
                      note="The count could not be loaded, so this may still be waiting on you. Refresh to retry."
                    />
                  ))}
                </ul>
              </section>
            )}

            {held.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">On hold</h2>
                <ul className="space-y-2">
                  {held.map(item => (
                    <QueueRow key={item.key} item={item} tone="muted" note={item.held?.reason ?? "On hold."} />
                  ))}
                </ul>
              </section>
            )}

            {clear.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                  {clear.length} {clear.length === 1 ? "queue is" : "queues are"} clear — nothing waiting ▸
                </summary>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {clear.map(item => (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        className="flex items-baseline justify-between gap-3 rounded-lg border border-dashed bg-muted/30 p-3 text-sm transition-colors hover:border-foreground/20"
                      >
                        <span className="font-medium">{item.title}</span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">Clear</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Pipeline status</h2>
              <Card>
                <CardContent className="grid gap-4 sm:grid-cols-2 pt-6">
                  {stats.map(stat => (
                    <div key={stat.name}>
                      <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
                      <div className="text-sm font-medium mt-0.5">{stat.name}</div>
                      <p className="text-xs text-muted-foreground mt-0.5">{stat.description}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {storagePct !== null && (() => {
                // Storage is a background fact on Pro, not a decision — so it
                // tucks under a toggle like a cleared queue, with the number on
                // the summary line so it never needs opening to be read. It
                // springs open on its own once the extraction brake is in sight,
                // which is the point where it stops being background.
                const atBrake = storage! >= EXTRACTION_BRAKE_MB
                const nearBrake = storage! >= EXTRACTION_BRAKE_MB * 0.8
                return (
                  <details className="group" open={nearBrake}>
                    <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                      Database storage — {storage!.toFixed(0)} MB of {(STORAGE_CAP_MB / 1024).toFixed(0)} GB (
                      {storagePct.toFixed(0)}%) ▸
                    </summary>
                    <Card className="mt-3">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">Database storage</CardTitle>
                        <CardDescription>
                          {storage!.toFixed(0)} MB of the {(STORAGE_CAP_MB / 1024).toFixed(0)} GB included with
                          Supabase Pro ({storagePct.toFixed(0)}%).{" "}
                          {atBrake
                            ? `Extraction has stopped — it brakes at ${EXTRACTION_BRAKE_MB.toLocaleString()} MB. Pass a higher --max-mb to continue.`
                            : nearBrake
                              ? `Extraction brakes itself at ${EXTRACTION_BRAKE_MB.toLocaleString()} MB, which is close.`
                              : "Past the included disk Supabase bills for the overage — the database does not go read-only."}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              atBrake ? "bg-destructive" : nearBrake ? "bg-amber-500" : "bg-foreground/60"
                            }`}
                            style={{ width: `${Math.max(2, storagePct)}%` }}
                          />
                        </div>
                      </CardContent>
                    </Card>
                  </details>
                )
              })()}
            </section>

            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Browse &amp; edit</h2>
              <div className="flex flex-wrap gap-3">
                {[
                  { name: "Sources", href: "/admin/sources", description: "Ingested sources and the processing queue" },
                  { name: "Topics", href: "/admin/topics", description: "The AI-managed taxonomy (audit / edit)" },
                  { name: "Raw Insights", href: "/admin/insights/review", description: "Browse raw extractions" },
                  { name: "New Knowledge", href: "/admin/novelty", description: "What each source added that was new" },
                ].map(item => (
                  <Button key={item.href} asChild variant="outline" className="h-auto flex-col items-stretch py-3 px-4">
                    <Link href={item.href}>
                      <span className="font-semibold">{item.name}</span>
                      <span className="text-xs font-normal text-muted-foreground mt-0.5 max-w-[14rem] text-left">
                        {item.description}
                      </span>
                    </Link>
                  </Button>
                ))}
              </div>
            </section>

            <p className="text-xs text-muted-foreground">
              <Link href="/" className="underline underline-offset-2 hover:text-foreground">
                Back to public site
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
