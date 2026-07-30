import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { selectAllPaged } from "@/lib/pagination"

export const dynamic = "force-dynamic"

/** The resolve vocabulary, kept exactly in step with resolveFlag() in
 *  scripts/flagClaims.ts and the CHECK constraint from migration 014. */
const ALLOWED_RESOLUTIONS = [
  "approved",
  "edited",
  "split",
  "narrowed",
  "archived",
  "false_positive",
  "reworded",
] as const

type FlagRow = {
  id: string
  claim_id: string
  rule: string
  detail: string | null
  evidence: Record<string, unknown> | null
  created_at: string
  claims: { canonical_statement: string } | null
}

/**
 * Open claim flags (resolved_at IS NULL) joined to their claim's canonical
 * statement, grouped by rule for the reviewer. Read-only.
 *
 * The set is paged defensively: PostgREST caps every response at 1000 rows on
 * this project (see lib/pagination.ts), and the open-flag count can in principle
 * cross that, so we walk .range() rather than trusting a single .limit().
 */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const db = supabaseAdmin

  let rows: FlagRow[]
  try {
    rows = await selectAllPaged<FlagRow>((from, to) =>
      db
        .from("claim_flags")
        .select("id, claim_id, rule, detail, evidence, created_at, claims(canonical_statement)")
        .is("resolved_at", null)
        // Stable order is required for paging; rule-then-created_at also gives the
        // UI its grouping for free.
        .order("rule", { ascending: true })
        .order("created_at", { ascending: true })
        .range(from, to)
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load flags" },
      { status: 500 }
    )
  }

  return NextResponse.json({ flags: rows })
}

/**
 * Resolve a single flag. Mirrors resolveFlag() in scripts/flagClaims.ts exactly:
 * validate the resolution against the allowed set, then set resolved_at = now()
 * and resolution on the one row, 404 if nothing matched.
 */
export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const db = supabaseAdmin

  let body: { flagId?: unknown; resolution?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { flagId, resolution } = body
  if (typeof flagId !== "string" || !flagId) {
    return NextResponse.json({ error: "flagId is required" }, { status: 400 })
  }
  if (
    typeof resolution !== "string" ||
    !(ALLOWED_RESOLUTIONS as readonly string[]).includes(resolution)
  ) {
    return NextResponse.json(
      { error: `resolution must be one of: ${ALLOWED_RESOLUTIONS.join(", ")}` },
      { status: 400 }
    )
  }

  const { data, error } = await db
    .from("claim_flags")
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq("id", flagId)
    .select("claim_id, rule")
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Flag not found" }, { status: 404 })

  return NextResponse.json({ ok: true })
}
