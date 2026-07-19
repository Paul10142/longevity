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
}

const STATUS_VARIANT: Record<Job["status"], "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  queued: "secondary",
  done: "outline",
  failed: "destructive",
}

function progressLabel(job: Job): string {
  const p = job.progress || {}
  const idx = p.chunk_index as number | undefined
  const total = p.total_chunks as number | undefined
  const created = p.insights_created as number | undefined
  if (typeof idx === "number" && typeof total === "number") {
    return `${idx}/${total} chunks${typeof created === "number" ? ` · ${created} insights` : ""}`
  }
  return ""
}

export function JobQueuePanel() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [running, setRunning] = useState(false)

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
          <div className="space-y-2">
            {jobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between gap-3 text-sm border-b pb-2 last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
                  <span className="font-mono text-xs truncate">{job.type}</span>
                </div>
                <div className="text-xs text-muted-foreground text-right shrink-0">
                  {job.status === "failed" && job.error ? (
                    <span className="text-destructive" title={job.error}>{job.error.slice(0, 60)}</span>
                  ) : (
                    progressLabel(job)
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
