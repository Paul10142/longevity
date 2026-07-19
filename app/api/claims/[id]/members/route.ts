import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

/**
 * The provenance drill-down for one claim: every raw insight that supports it,
 * with its source and locator. This is the leaf of the chain
 * article paragraph → claim → raw insight → source (+ timestamp/locator).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params

  const { data, error } = await supabaseAdmin
    .from("claim_members")
    .select(
      `raw_insight_id, matched_by,
       raw_insights (
         statement, locator, start_ms, end_ms, evidence_type, confidence,
         sources ( id, title, type, url )
       )`
    )
    .eq("claim_id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const members = (data ?? []).map((m: {
    raw_insight_id: string
    matched_by: string
    raw_insights: {
      statement: string; locator: string; start_ms: number | null; end_ms: number | null
      evidence_type: string; confidence: string
      sources: { id: string; title: string; type: string; url: string | null } | null
    } | null
  }) => ({
    raw_insight_id: m.raw_insight_id,
    matched_by: m.matched_by,
    statement: m.raw_insights?.statement,
    locator: m.raw_insights?.locator,
    start_ms: m.raw_insights?.start_ms ?? null,
    evidence_type: m.raw_insights?.evidence_type,
    confidence: m.raw_insights?.confidence,
    source: m.raw_insights?.sources ?? null,
  }))

  return NextResponse.json({ members })
}
