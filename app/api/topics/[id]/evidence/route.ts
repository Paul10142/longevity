import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 25

/**
 * Paginated claims for a topic and its descendants, ranked by importance /
 * corroboration. The Evidence tab's backbone. Member raw insights (the
 * provenance drill-down) are loaded per-claim via /api/claims/[id]/members.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params
  const page = Math.max(0, parseInt(request.nextUrl.searchParams.get("page") || "0", 10))

  // Topic + descendant ids.
  const { data: allTopics } = await supabaseAdmin.from("topics").select("id, parent_id").eq("status", "active")
  const childrenOf = new Map<string, string[]>()
  for (const t of (allTopics ?? []) as { id: string; parent_id: string | null }[]) {
    if (!t.parent_id) continue
    if (!childrenOf.has(t.parent_id)) childrenOf.set(t.parent_id, [])
    childrenOf.get(t.parent_id)!.push(t.id)
  }
  const topicIds: string[] = []
  const stack = [id]
  while (stack.length) {
    const t = stack.pop()!
    topicIds.push(t)
    for (const c of childrenOf.get(t) ?? []) stack.push(c)
  }

  const { data: links } = await supabaseAdmin.from("claim_topics").select("claim_id").in("topic_id", topicIds)
  const claimIds = Array.from(new Set((links ?? []).map((l: { claim_id: string }) => l.claim_id)))
  if (claimIds.length === 0) return NextResponse.json({ claims: [], total: 0, page, pageSize: PAGE_SIZE })

  const { data: claims } = await supabaseAdmin
    .from("claims")
    .select("id, canonical_statement, context_note, best_evidence_type, max_importance, member_count, source_count")
    .in("id", claimIds)
    .eq("status", "active")
    .order("max_importance", { ascending: false, nullsFirst: false })
    .order("source_count", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  return NextResponse.json({
    claims: claims ?? [],
    total: claimIds.length,
    page,
    pageSize: PAGE_SIZE,
  })
}
