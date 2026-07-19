import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

/** Pending merge reviews with both claims' statements, for the review queue. */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }

  const { data, error } = await supabaseAdmin
    .from("merge_reviews")
    .select(
      `id, similarity, model_verdict, model_confidence, model_reasoning, created_at,
       claim:claims!merge_reviews_claim_id_fkey (id, canonical_statement, context_note, member_count, source_count),
       candidate:claims!merge_reviews_candidate_claim_id_fkey (id, canonical_statement, context_note, member_count, source_count)`
    )
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reviews: data ?? [] })
}
