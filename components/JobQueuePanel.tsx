"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type Job = {
  id: string
  type: string
  status: "queued" | "running" | "done" | "failed"
  progress: Record<string, unknown>
  attempts: number
  error: string | null
  created_at: string
  finished_at: string | null
  source_id: string | null
  target_name: string | null
}

const STATUS_VARIANT: Record<Job["status"], "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  queued: "secondary",
  done: "outline",
  failed: "destructive",
}

// Friendly names for the raw job types, plus a one-line "what is this" for the
// ones whose name isn't self-explanatory (e.g. "references").
const TYPE_LABEL: Record<string, string> = {
  extract_source: "Extract insights",
  consolidate_source: "Consolidate / dedup",
  extract_references: "Extract references",
  resolve_references: "Resolve references",
  tag_claims: "Tag claims to topics",
  claim_sweep: "Dedup sweep",
  discover_topics: "Discover topics",
  generate_topic: "Generate article",
  update_topic: "Update article",
}
const TYPE_HINT: Record<string, string> = {
  extract_references: "Pulls the studies & papers cited in the source",
  resolve_references: "Matches cited studies to real references across the corpus",
  claim_sweep: "Second-pass check for near-duplicate claims that slipped through",
  tag_claims: "Files each deduplicated claim under its topics",
}

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ")
}

const GENERAL_GROUP = "Corpus-wide steps"

function progressLabel(job: Job): string {
  const p = job.progress || {}
  const idx = p.chunk_index as number | undefined
  const total = p.total_chunks as number | undefined
  const created = p.insights_created as number | undefined
  if (typeof idx === "number" && typeof total === "number") {
    // chunk_index is 0-based ("next chunk to process"): while running it's the
    // count already done, so the chunk in flight is idx + 1.
    const pos = job.status === "done" ? `${total} chunks` : `chunk ${Math.min(idx + 1, total)} of ${total}`
    return `${pos}${typeof created === "number" ? ` · ${created} insights` : ""}`
  }
  const processed = p.processed as number | undefined
  const totalItems = p.total as number | undefined
  if (typeof processed === "number" && typeof totalItems === "number") {
    const merged = p.merged as number | undefined
    const claims = p.claims_created as number | undefined
    const extra =
      typeof merged === "number" ? ` · ${merged} merged` : typeof claims === "number" ? ` · ${claims} claims` : ""
    return `${processed}/${totalItems}${extra}`
  }
  return ""
}

/** Group jobs by the source (or topic) they act on, preserving input order. */
function groupBySource(jobs: Job[]): { name: string; jobs: Job[] }[] {
  const order: string[] = []
  const map = new Map<string, Job[]>()
  for (const j of jobs) {
    // A job tied to a source whose title didn't resolve (deleted/renamed source)
    // is not corpus-wide — keep it out of the general bucket so that group stays
    // meaningful.
    const key = j.target_name || (j.source_id ? "Unknown source" : GENERAL_GROUP)
    if (!map.has(key)) {
      map.set(key, [])
      order.push(key)
    }
    map.get(key)!.push(j)
  }
  return order.map((name) => ({ name, jobs: map.get(name)! }))
}

function JobRow({ job }: { job: Job }) {
  const hint = TYPE_HINT[job.type]
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1.5 border-b last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
        <span className="truncate" title={hint}>
          {typeLabel(job.type)}
          {hint && <span className="ml-1 text-muted-foreground/60 cursor-help">ⓘ</span>}
        </span>
      </div>
      <div className="text-xs text-muted-foreground text-right shrink-0">
        {job.status === "failed" && job.error ? (
          <span className="text-destructive" title={job.error}>
            {job.error.slice(0, 60)}
          </span>
        ) : (
          progressLabel(job)
        )}
      </div>
    </div>
  )
}

function SourceGroup({ name, jobs }: { name: string; jobs: Job[] }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-sm font-medium mb-1 truncate" title={name}>
        {name}
      </div>
      <div>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </div>
    </div>
  )
}

export function JobQueuePanel() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [running, setRunning] = useState(false)
  const [showDone, setShowDone] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/jobs", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      setJobs(data.jobs || [])
      setCounts(data.counts || {})
    } catch {
      /* transient — next poll retries */
    }
  }, [])

  useEffect(() => {
    refresh()
    const active = (counts.running || 0) + (counts.queued || 0) > 0
    const interval = setInterval(refresh, active ? 2000 : 8000)
    return () => clearInterval(interval)
  }, [refresh, counts.running, counts.queued])

  async function runWorker() {
    setRunning(true)
    try {
      await fetch("/api/worker/tick", { method: "POST" })
      await refresh()
    } finally {
      setRunning(false)
    }
  }

  const active = (counts.running || 0) + (counts.queued || 0)
  const activeJobs = jobs.filter((j) => j.status !== "done")
  const doneJobs = jobs.filter((j) => j.status === "done")
  const activeGroups = groupBySource(activeJobs)
  const doneGroups = groupBySource(doneJobs)

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-lg">
          Processing queue
          {active > 0 && <span className="text-muted-foreground text-sm font-normal"> · {active} active</span>}
        </CardTitle>
        <Button size="sm" variant="secondary" onClick={runWorker} disabled={running}>
          {running ? "Running…" : "Run worker now"}
        </Button>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          <div className="space-y-3">
            {activeJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs in progress.</p>
            ) : (
              activeGroups.map((g) => <SourceGroup key={g.name} name={g.name} jobs={g.jobs} />)
            )}

            {doneJobs.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowDone((v) => !v)}
                  className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  <span className="w-3 shrink-0">{showDone ? "▾" : "▸"}</span>
                  {showDone ? "Hide" : "Show"} {doneJobs.length} completed
                </button>
                {showDone && (
                  <div className="space-y-3 mt-2">
                    {doneGroups.map((g) => (
                      <SourceGroup key={g.name} name={g.name} jobs={g.jobs} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
