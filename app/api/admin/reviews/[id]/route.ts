import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { mergeClaims } from "@/lib/consolidation"

/**
 * Decide a merge review.
 *   accept → the provisional claim IS the candidate: merge them.
 *   reject → they are distinct: keep both, close the review.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }

  const { id } = await params
  const { action } = await request.json()
  if (action !== "accept" && action !== "reject") {
    return NextResponse.json({ error: "action must be 'accept' or 'reject'" }, { status: 400 })
  }

  const { data: review, error } = await supabaseAdmin
    .from("merge_reviews")
    .select("id, claim_id, candidate_claim_id, status")
    .eq("id", id)
    .single()
  if (error || !review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 })
  }
  if (review.status !== "pending") {
    return NextResponse.json({ error: "Review already decided" }, { status: 409 })
  }

  if (action === "accept") {
    // Merge the provisional claim (claim_id) into the existing candidate.
    await mergeClaims(review.claim_id, review.candidate_claim_id)
  }

  await supabaseAdmin
    .from("merge_reviews")
    .update({
      status: action === "accept" ? "accepted" : "rejected",
      decided_at: new Date().toISOString(),
      decided_by: "admin",
    })
    .eq("id", id)

  return NextResponse.json({ ok: true })
}
