import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { enqueueJob, pingWorker } from "@/lib/jobs"

/**
 * Bulk-enqueue synthesis. Body: { minClaims?: number, staleOnly?: boolean }.
 * Defaults to topics with >= 5 claims. `staleOnly` re-generates only topics
 * whose newest claim/link is newer than their latest article snapshot.
 */
export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const body = await request.json().catch(() => ({}))
  const minClaims = typeof body.minClaims === "number" ? body.minClaims : 5
  const staleOnly = body.staleOnly === true

  const { data: topics, error } = await supabaseAdmin
    .from("topics")
    .select("id, claim_count")
    .eq("status", "active")
    .gte("claim_count", minClaims)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let queued = 0
  for (const t of (topics ?? []) as { id: string; claim_count: number }[]) {
    if (staleOnly && !(await isStale(t.id))) continue
    const { deduped } = await enqueueJob("generate_topic", { topic_id: t.id })
    if (!deduped) queued++
  }

  pingWorker(request.nextUrl.origin)
  return NextResponse.json({ ok: true, queued })
}

/** A topic is stale if its latest article predates its newest claim change. */
async function isStale(topicId: string): Promise<boolean> {
  if (!supabaseAdmin) return false
  const { data: latest } = await supabaseAdmin
    .from("topic_articles")
    .select("claims_snapshot_at")
    .eq("topic_id", topicId)
    .order("version", { ascending: false })
    .limit(1)
  const snapshot = latest?.[0]?.claims_snapshot_at as string | undefined
  if (!snapshot) return true // never generated

  const { data: links } = await supabaseAdmin.from("claim_topics").select("claim_id").eq("topic_id", topicId)
  const claimIds = (links ?? []).map((l: { claim_id: string }) => l.claim_id)
  if (claimIds.length === 0) return false
  const { data: newest } = await supabaseAdmin
    .from("claims")
    .select("updated_at")
    .in("id", claimIds)
    .order("updated_at", { ascending: false })
    .limit(1)
  const newestChange = newest?.[0]?.updated_at as string | undefined
  return !!newestChange && newestChange > snapshot
}
