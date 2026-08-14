import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { supabaseAdmin } from "@/lib/supabaseServer"
import fidelityPairs from "@/eval/extraction-eval-pairs.json"

// Counts are live — never serve a cached to-do list.
export const dynamic = "force-dynamic"

/** Supabase free-plan ceiling; the DB goes read-only if it is reached. */
const STORAGE_CAP_MB = 500

/** An unknown count renders as a dash, never as zero. */
const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString())

type Decision = {
  name: string
  href: string
  /** null = the query failed. Never conflate that with zero — see countOf. */
  count: number | null
  description: string
  /** Shown instead of the count when there is nothing to do. */
  emptyLabel: string
}

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

async function loadDashboard() {
  if (!supabaseAdmin) {
    return { decisions: [] as Decision[], stats: [] as Stat[], storage: null, configured: false }
  }
  const db = supabaseAdmin

  const [
    mergeReviews,
    topicProposals,
    openFlags,
    unreviewedTopics,
    fidelityLabeled,
    pendingSources,
    untaggedClaims,
    activeClaims,
    openJobs,
    sizeResult,
  ] = await Promise.all([
    countOf("merge_reviews", q => q.select("id", { count: "exact", head: true }).eq("status", "pending")),
    countOf("topic_proposals", q => q.select("id", { count: "exact", head: true }).eq("status", "pending")),
    countOf("claim_flags", q => q.select("id", { count: "exact", head: true }).is("resolved_at", null)),
    countOf("topics", q =>
      q.select("id", { count: "exact", head: true }).eq("status", "active").eq("reviewed_by_human", false)
    ),
    countOf("fidelity_labels", q => q.select("pair_id", { count: "exact", head: true })),
    countOf("sources", q => q.select("id", { count: "exact", head: true }).eq("processing_status", "pending")),
    countOf("claims", q =>
      q.select("id", { count: "exact", head: true }).eq("status", "active").eq("needs_tagging", true)
    ),
    countOf("claims", q => q.select("id", { count: "exact", head: true }).eq("status", "active")),
    countOf("jobs", q => q.select("id", { count: "exact", head: true }).in("status", ["queued", "running"])),
    db.rpc("database_size_bytes"),
  ])

  const decisions: Decision[] = [
    {
      name: "Merge Reviews",
      href: "/admin/reviews",
      count: mergeReviews,
      description: "Claim pairs the pipeline could not confidently call duplicates. You decide keep-both or merge.",
      emptyLabel: "Queue clear",
    },
    {
      name: "Topic Approvals",
      href: "/admin/topics/proposals",
      count: topicProposals,
      description: "Genuinely new branches the pipeline wants to open. Nothing is created without your approval.",
      emptyLabel: "None proposed",
    },
    {
      name: "Accuracy Flags",
      href: "/admin/flags",
      count: openFlags,
      description: "Claims that may overstate what the transcript actually said. Keep or dismiss each.",
      emptyLabel: "No open flags",
    },
    {
      name: "Unreviewed Topics",
      href: "/admin/topics",
      count: unreviewedTopics,
      description: "Topics the AI created that you have not signed off on yet. Fold thin ones into their parent.",
      emptyLabel: "All reviewed",
    },
    {
      name: "Fidelity Labels",
      href: "/admin/fidelity",
      // Unlabeled pairs remaining; unknown label count keeps this unknown too.
      count: fidelityLabeled === null ? null : Math.max(0, fidelityPairs.length - fidelityLabeled),
      description: "Rule whether extracted insights faithfully reflect the transcript. Certifies the AI accuracy judge.",
      emptyLabel: "All labeled",
    },
  ]

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

  return { decisions, stats, storage: usedMb, configured: true }
}

export default async function AdminHomePage() {
  const { decisions, stats, storage, configured } = await loadDashboard()
  const outstanding = decisions.reduce((sum, d) => sum + (d.count ?? 0), 0)
  // If any count failed, "nothing is waiting on you" would be a lie.
  const anyUnknown = decisions.some(d => d.count === null)
  const storagePct = storage === null ? null : Math.min(100, (storage / STORAGE_CAP_MB) * 100)

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-10">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Workbench</h1>
              <p className="text-muted-foreground mt-2">
                {!configured
                  ? "Database not configured — counts unavailable."
                  : anyUnknown
                    ? `Some counts could not be loaded${outstanding > 0 ? ` — at least ${outstanding.toLocaleString()} waiting` : ""}. Refresh to retry.`
                    : outstanding === 0
                      ? "Nothing is waiting on you right now."
                      : `${outstanding.toLocaleString()} ${outstanding === 1 ? "item needs" : "items need"} your decision.`}
              </p>
            </div>

            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Needs your decision</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {decisions.map(item => {
                  const unknown = item.count === null
                  const active = (item.count ?? 0) > 0
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`block rounded-lg border p-4 transition-colors ${
                        active
                          ? "border-foreground/20 bg-card hover:border-foreground/40"
                          : "border-dashed bg-muted/30 hover:border-foreground/20"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{item.name}</span>
                        {unknown ? (
                          <span className="text-xs text-muted-foreground">Count unavailable</span>
                        ) : active ? (
                          <span className="text-2xl font-bold tabular-nums">{fmt(item.count)}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{item.emptyLabel}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1.5">{item.description}</p>
                    </Link>
                  )
                })}
              </div>
            </section>

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

              {storagePct !== null && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Database storage</CardTitle>
                    <CardDescription>
                      {storage!.toFixed(0)} MB of the {STORAGE_CAP_MB} MB plan limit ({storagePct.toFixed(0)}%).
                      {storagePct >= 90
                        ? " Critical — the database goes read-only at the limit."
                        : storagePct >= 65
                          ? " Extraction will stop before the limit is reached."
                          : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          storagePct >= 90 ? "bg-destructive" : storagePct >= 65 ? "bg-amber-500" : "bg-foreground/60"
                        }`}
                        style={{ width: `${Math.max(2, storagePct)}%` }}
                      />
                    </div>
                  </CardContent>
                </Card>
              )}
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
