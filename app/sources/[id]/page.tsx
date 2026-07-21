import { notFound } from "next/navigation"
import Link from "next/link"
import { SourceEditorClient } from "@/components/SourceEditorClient"
import { TranscriptEditorClient } from "@/components/TranscriptEditorClient"
import { SourceRawInsightsClient, type SourceInsightRow } from "@/components/SourceRawInsightsClient"
import { ReprocessSourceButton } from "@/components/ReprocessSourceButton"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { supabaseAdmin } from "@/lib/supabaseServer"

const JOB_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  queued: "secondary",
  done: "outline",
  failed: "destructive",
}

const RUN_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  success: "outline",
  failed: "destructive",
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  })
}

function runStats(stats: Record<string, unknown> | null): string {
  if (!stats) return ""
  const parts: string[] = []
  if (typeof stats.chunks_processed === "number") parts.push(`${stats.chunks_processed} chunks`)
  if (typeof stats.insights_created === "number") parts.push(`${stats.insights_created} insights`)
  if (typeof stats.cost_usd === "number") parts.push(`$${(stats.cost_usd as number).toFixed(2)}`)
  return parts.join(" · ")
}

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  if (!supabaseAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <main>
          <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-4">Configuration Required</h1>
              <p className="text-muted-foreground">
                Please set up your Supabase environment variables in .env.local
              </p>
            </div>
          </div>
        </main>
      </div>
    )
  }

  const { data: source, error: sourceError } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("id", id)
    .single()

  if (sourceError || !source) {
    notFound()
  }

  // v2 layers for this source: immutable raw_insights, their claim membership,
  // pipeline run history, and any queued/running jobs.
  const [insightsRes, membersRes, runsRes, jobsRes] = await Promise.all([
    supabaseAdmin
      .from("raw_insights")
      .select("id, locator, start_ms, statement, context_note, direct_quote, evidence_type, confidence, importance, actionability, insight_type")
      .eq("source_id", id)
      .order("locator", { ascending: true })
      .order("created_at", { ascending: true })
      .range(0, 4999),
    supabaseAdmin
      .from("claim_members")
      .select("raw_insight_id, claims!inner(id, canonical_statement, source_count), raw_insights!inner(source_id)")
      .eq("raw_insights.source_id", id)
      .range(0, 4999),
    supabaseAdmin
      .from("pipeline_runs")
      .select("id, kind, status, stats, error_message, started_at, finished_at")
      .eq("source_id", id)
      .order("started_at", { ascending: false })
      .limit(20),
    supabaseAdmin
      .from("jobs")
      .select("id, type, status, progress, error, created_at, finished_at")
      .eq("payload->>source_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  for (const [label, res] of [
    ["raw_insights", insightsRes],
    ["claim_members", membersRes],
    ["pipeline_runs", runsRes],
    ["jobs", jobsRes],
  ] as const) {
    if (res.error) console.error(`Error fetching ${label} for source ${id}:`, res.error)
  }

  const claimByInsightId = new Map<string, SourceInsightRow["claim"]>()
  membersRes.data?.forEach((m: any) => {
    if (m.claims?.id) {
      claimByInsightId.set(m.raw_insight_id, {
        id: m.claims.id,
        canonical_statement: m.claims.canonical_statement,
        source_count: m.claims.source_count,
      })
    }
  })

  const insights: SourceInsightRow[] = (insightsRes.data || []).map((i: any) => ({
    ...i,
    claim: claimByInsightId.get(i.id) ?? null,
  }))

  const runs = runsRes.data || []
  const jobs = jobsRes.data || []
  const activeJobs = jobs.filter((j: any) => j.status === "queued" || j.status === "running")

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto space-y-6">
            <div>
              <Link
                href="/admin/sources"
                className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1"
              >
                ← Back to Manage Sources
              </Link>
            </div>

            <SourceEditorClient source={source} />

            <TranscriptEditorClient sourceId={source.id} transcript={source.transcript} />

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-lg">
                  Processing
                  {activeJobs.length > 0 && (
                    <span className="text-muted-foreground text-sm font-normal"> · {activeJobs.length} active</span>
                  )}
                </CardTitle>
                {source.transcript && <ReprocessSourceButton sourceId={source.id} />}
              </CardHeader>
              <CardContent className="space-y-4">
                {!source.transcript && (
                  <p className="text-sm text-muted-foreground">
                    Add a transcript to enable extraction.
                  </p>
                )}

                {jobs.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Jobs</p>
                    <div className="space-y-2">
                      {jobs.map((job: any) => (
                        <div key={job.id} className="flex items-center justify-between gap-3 text-sm border-b pb-2 last:border-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge variant={JOB_STATUS_VARIANT[job.status] ?? "outline"}>{job.status}</Badge>
                            <span className="font-mono text-xs truncate">{job.type}</span>
                          </div>
                          <div className="text-xs text-muted-foreground text-right shrink-0">
                            {job.status === "failed" && job.error ? (
                              <span className="text-destructive" title={job.error}>{job.error.slice(0, 60)}</span>
                            ) : (
                              formatDate(job.finished_at ?? job.created_at)
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {runs.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Run history</p>
                    <div className="space-y-2">
                      {runs.map((run: any) => (
                        <div key={run.id} className="flex items-center justify-between gap-3 text-sm border-b pb-2 last:border-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge variant={RUN_STATUS_VARIANT[run.status] ?? "outline"}>{run.status}</Badge>
                            <span className="font-mono text-xs truncate">{run.kind}</span>
                            <span className="text-xs text-muted-foreground truncate">{runStats(run.stats)}</span>
                          </div>
                          <div className="text-xs text-muted-foreground text-right shrink-0">
                            {run.status === "failed" && run.error_message ? (
                              <span className="text-destructive" title={run.error_message}>
                                {run.error_message.slice(0, 60)}
                              </span>
                            ) : (
                              formatDate(run.started_at)
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {jobs.length === 0 && runs.length === 0 && source.transcript && (
                  <p className="text-sm text-muted-foreground">
                    No processing activity recorded for this source yet.
                  </p>
                )}
              </CardContent>
            </Card>

            <SourceRawInsightsClient insights={insights} sourceUrl={source.url} />
          </div>
        </div>
      </main>
    </div>
  )
}
