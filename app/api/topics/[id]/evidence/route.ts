import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 25

/**
 * Paginated claims for a topic and its descendants, ranked by the composite
 * score. Backed by the topic_claims() RPC — scoring, subtree rollup, and
 * pagination all happen in SQL (no app-side IN of claim ids). Member raw
 * insights + verified references are loaded per-claim via /api/claims/[id].
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params
  const page = Math.max(0, parseInt(request.nextUrl.searchParams.get("page") || "0", 10))

  const [{ data: claims, error }, { data: total }] = await Promise.all([
    supabaseAdmin.rpc("topic_claims", {
      p_topic_id: id,
      p_audience: null,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    }),
    supabaseAdmin.rpc("topic_claim_count", { p_topic_id: id }),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    claims: claims ?? [],
    total: typeof total === "number" ? total : 0,
    page,
    pageSize: PAGE_SIZE,
  })
}
