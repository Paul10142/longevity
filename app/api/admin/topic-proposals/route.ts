import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

/**
 * Pending new-topic proposals, with the claims that motivated each one so the
 * reviewer can judge the suggestion against real evidence rather than a name.
 */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }

  const { data: proposals, error } = await supabaseAdmin
    .from("topic_proposals")
    .select("id, name, proposed_parent_name, proposed_parent_id, rationale, claim_ids, claim_count, created_at")
    .eq("status", "pending")
    .order("claim_count", { ascending: false })
    .limit(100)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = proposals ?? []

  // Sample statements per proposal (a few each) for context in the UI.
  const allClaimIds = Array.from(
    new Set(rows.flatMap((p: any) => (p.claim_ids ?? []).slice(0, 5)))
  ) as string[]

  const statementById = new Map<string, string>()
  if (allClaimIds.length > 0) {
    const { data: claims } = await supabaseAdmin
      .from("claims")
      .select("id, canonical_statement")
      .in("id", allClaimIds)
    for (const c of claims ?? []) statementById.set(c.id, c.canonical_statement)
  }

  // Only curated topics are offerable parents — a spine root or an approved
  // topic beneath one. Filtering on `is_spine` rather than "has no parent"
  // matters: the tree still carries legacy AI-minted roots, and offering those
  // as parents would let the approval queue rebuild the sprawl it exists to
  // prevent. `parent_id` comes back so the UI can nest the options.
  const { data: branches } = await supabaseAdmin
    .from("topics")
    .select("id, name, parent_id")
    .eq("status", "active")
    .eq("is_spine", true)
    .order("name", { ascending: true })

  return NextResponse.json({
    proposals: rows.map((p: any) => ({
      ...p,
      sampleClaims: (p.claim_ids ?? [])
        .slice(0, 5)
        .map((cid: string) => statementById.get(cid))
        .filter(Boolean),
    })),
    branches: branches ?? [],
  })
}
