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
    .select("id, type, status, progress, attempts, error, created_at, started_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(25)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const counts: Record<string, number> = {}
  for (const j of jobs ?? []) counts[j.status] = (counts[j.status] || 0) + 1

  return NextResponse.json({ jobs: jobs ?? [], counts })
}
