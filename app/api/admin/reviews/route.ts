import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { selectAllPaged } from "@/lib/pagination"

export const dynamic = "force-dynamic"

const SELECT =
  `id, similarity, model_verdict, model_confidence, model_reasoning, created_at,
   claim:claims!merge_reviews_claim_id_fkey (id, canonical_statement, context_note, member_count, source_count),
   candidate:claims!merge_reviews_candidate_claim_id_fkey (id, canonical_statement, context_note, member_count, source_count)`

type ReviewRow = { id: string }

/** Pending merge reviews with both claims' statements, for the review queue.
 *
 *  Paged, not `.limit(100)`. The cap was invisible: the queue stood at 74 on
 *  2026-08-17 and grows ~7/hour while extraction runs, so it crosses 100 inside
 *  one overnight run — and a truncated read renders as an empty queue, i.e. the
 *  reviewer is told they are finished when they are not. Same class as the
 *  truncation bugs in `lib/pagination.ts`'s header. */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }

  const db = supabaseAdmin
  try {
    const reviews = await selectAllPaged<ReviewRow>((from, to) =>
      db
        .from("merge_reviews")
        .select(SELECT)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to)
    )
    return NextResponse.json({ reviews, total: reviews.length })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
