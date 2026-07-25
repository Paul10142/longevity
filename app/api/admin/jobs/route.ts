import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

/** Recent jobs + queue summary, for the admin queue panel. */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }

  const { data: jobs, error } = await supabaseAdmin
    .from("jobs")
    .select("id, type, status, payload, progress, attempts, error, created_at, started_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = jobs ?? []

  // Resolve the human name each job acts on, so the panel can group/label by
  // source (or topic) instead of showing bare job types. Source/topic ids live
  // in the job payload; batch two lookups rather than one join per row.
  const sourceIds = new Set<string>()
  const topicIds = new Set<string>()
  for (const j of rows) {
    const p = (j.payload || {}) as Record<string, unknown>
    if (typeof p.source_id === "string") sourceIds.add(p.source_id)
    if (typeof p.topic_id === "string") topicIds.add(p.topic_id)
  }

  const [sourcesRes, topicsRes] = await Promise.all([
    sourceIds.size
      ? supabaseAdmin.from("sources").select("id, title").in("id", [...sourceIds])
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
    topicIds.size
      ? supabaseAdmin.from("topics").select("id, name").in("id", [...topicIds])
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ])
  const sourceTitle = new Map((sourcesRes.data ?? []).map((s) => [s.id, s.title]))
  const topicName = new Map((topicsRes.data ?? []).map((t) => [t.id, t.name]))

  const enriched = rows.map((j) => {
    const p = (j.payload || {}) as Record<string, unknown>
    const sid = typeof p.source_id === "string" ? p.source_id : null
    const tid = typeof p.topic_id === "string" ? p.topic_id : null
    return {
      id: j.id,
      type: j.type,
      status: j.status,
      progress: j.progress,
      attempts: j.attempts,
      error: j.error,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
      source_id: sid,
      target_name: sid ? sourceTitle.get(sid) ?? null : tid ? topicName.get(tid) ?? null : null,
    }
  })

  const counts: Record<string, number> = {}
  for (const j of rows) counts[j.status] = (counts[j.status] || 0) + 1

  return NextResponse.json({ jobs: enriched, counts })
}
