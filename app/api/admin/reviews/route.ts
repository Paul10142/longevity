import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { selectAllPaged } from "@/lib/pagination"
import { describeSkippedSources, loadSkippedSources, skippedOnlyClaims, skippedSourcesOf } from "@/lib/skippedItems"

export const dynamic = "force-dynamic"

const SELECT =
  `id, similarity, model_verdict, model_confidence, model_reasoning, created_at,
   claim:claims!merge_reviews_claim_id_fkey (id, canonical_statement, context_note, member_count, source_count),
   candidate:claims!merge_reviews_candidate_claim_id_fkey (id, canonical_statement, context_note, member_count, source_count)`

type ClaimRef = { id: string; canonical_statement: string } | null
type ReviewRow = { id: string; claim: ClaimRef; candidate: ClaimRef }

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
    // A pair where either fact comes only from skipped or non-full items leaves the
    // queue for one collapsed list (lib/skippedItems.ts). Fails open.
    const skipped = await loadSkippedSources(db)
    const claimIds = reviews.flatMap(r => [r.claim?.id, r.candidate?.id]).filter((x): x is string => !!x)
    const { hidden, sourcesByClaim } = await skippedOnlyClaims(db, claimIds, skipped)
    const isHidden = (r: ReviewRow) => (!!r.claim && hidden.has(r.claim.id)) || (!!r.candidate && hidden.has(r.candidate.id))
    const skippedReviews = reviews.filter(isHidden).map(r => {
      const side = r.claim && hidden.has(r.claim.id) ? r.claim : r.candidate
      const d = describeSkippedSources(skippedSourcesOf(side ? sourcesByClaim.get(side.id) : undefined, skipped))
      return {
        id: r.id,
        title: d.title,
        reason: d.reason,
        detail: [r.claim?.canonical_statement, r.candidate?.canonical_statement].filter(Boolean).join("  |  "),
      }
    })
    const visible = reviews.filter(r => !isHidden(r))
    return NextResponse.json({ reviews: visible, skippedReviews, total: visible.length })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
