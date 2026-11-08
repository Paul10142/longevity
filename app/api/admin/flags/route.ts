import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { selectAllPaged } from "@/lib/pagination"
import { statusAfterResolution } from "@/lib/claimGate"
import { planReviewAction } from "@/lib/flagReview"
import { generateEmbedding, insightEmbeddingText } from "@/lib/embeddings"

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
  /** Set when the reviewer parked the flag as "needs video check" (migration 036). */
  needs_video_check_at?: string | null
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

  // Migration 036 adds needs_video_check_at. Until the runner has applied it the
  // column does not exist and PostgREST rejects the whole select, so fall back to
  // the old column list: the screen then works, minus the video-check list.
  const load = (columns: string) =>
    selectAllPaged<FlagRow>((from, to) =>
      db
        .from("claim_flags")
        .select(columns)
        .is("resolved_at", null)
        // Stable order is required for paging; rule-then-created_at also gives the
        // UI its grouping for free.
        .order("rule", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    )

  let rows: FlagRow[]
  let videoCheckAvailable = true
  try {
    try {
      rows = await load("id, claim_id, rule, detail, evidence, created_at, needs_video_check_at, claims(canonical_statement)")
    } catch (err) {
      if (!/needs_video_check_at/.test(err instanceof Error ? err.message : "")) throw err
      videoCheckAvailable = false
      rows = await load("id, claim_id, rule, detail, evidence, created_at, claims(canonical_statement)")
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load flags" },
      { status: 500 }
    )
  }

  return NextResponse.json({ flags: rows, videoCheckAvailable })
}

/**
 * Resolve a single flag. Mirrors resolveFlag() in scripts/flagClaims.ts exactly:
 * validate the resolution against the allowed set, then set resolved_at = now()
 * and resolution on the one row, 404 if nothing matched. Dismissing a
 * quarantining flag as a false alarm also un-hides its claim.
 */
export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const db = supabaseAdmin

  let body: { flagId?: unknown; resolution?: unknown; action?: unknown; statement?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { flagId, resolution } = body
  if (typeof flagId !== "string" || !flagId) {
    return NextResponse.json({ error: "flagId is required" }, { status: 400 })
  }
  if (body.action !== undefined) return reviewAction(db, flagId, body.action, body.statement)
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

  // A false alarm on a quarantining flag (lib/claimGate.ts) puts the hidden
  // claim back where articles can read it. Mirrors applyResolutionToClaim() in
  // scripts/flagClaims.ts.
  const { claim_id, rule } = data as { claim_id: string; rule: string }
  const { data: claim, error: cErr } = await db.from("claims").select("status").eq("id", claim_id).maybeSingle()
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
  const next = claim ? statusAfterResolution((claim as { status: string }).status, rule, resolution) : null
  if (next) {
    const { error: uErr } = await db.from("claims").update({ status: next }).eq("id", claim_id).eq("status", "flagged")
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, claimStatus: next ?? undefined })
}

/**
 * The review screen's four choices (lib/flagReview.ts decides what each does):
 * approve as is, reject, edit the wording and approve, needs video check.
 * Only an OPEN flag can be ruled on, so a double click or a stale tab cannot
 * apply a ruling twice.
 */
async function reviewAction(
  db: NonNullable<typeof supabaseAdmin>,
  flagId: string,
  action: unknown,
  statement: unknown
) {
  if (typeof action !== "string") {
    return NextResponse.json({ error: "action must be a string" }, { status: 400 })
  }

  const { data: flag, error: fErr } = await db
    .from("claim_flags")
    .select("id, claim_id, rule, evidence, resolved_at, claims(status, canonical_statement, context_note)")
    .eq("id", flagId)
    .maybeSingle()
  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })
  if (!flag) return NextResponse.json({ error: "Flag not found" }, { status: 404 })
  const f = flag as unknown as {
    id: string; claim_id: string; rule: string; evidence: Record<string, unknown> | null; resolved_at: string | null
    claims: { status: string; canonical_statement: string; context_note: string | null } | null
  }
  if (f.resolved_at) return NextResponse.json({ error: "This flag was already resolved" }, { status: 409 })
  if (!f.claims) return NextResponse.json({ error: "Claim not found" }, { status: 404 })

  const plan = planReviewAction(action, {
    currentStatus: f.claims.status,
    rule: f.rule,
    currentStatement: f.claims.canonical_statement,
    statement,
  })
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 })

  // 1. Edited wording first, so a failure here leaves the flag open and retryable.
  let embeddingRefreshed: boolean | undefined
  if (plan.newStatement) {
    const { error } = await db
      .from("claims")
      .update({ canonical_statement: plan.newStatement, needs_tagging: true })
      .eq("id", f.claim_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // The vector must follow the text it indexes (lib/consolidation.ts does the same).
    // Best effort: the wording is already saved, and a missed refresh only dulls search.
    try {
      const vector = await generateEmbedding(
        insightEmbeddingText({ statement: plan.newStatement, context_note: f.claims.context_note })
      )
      const { error: eErr } = await db
        .from("claim_embeddings")
        .upsert({ claim_id: f.claim_id, embedding: vector, updated_at: new Date().toISOString() }, { onConflict: "claim_id" })
      embeddingRefreshed = !eErr
    } catch {
      embeddingRefreshed = false
    }
  }

  // 2. The flag: closed with a resolution, or parked on the video-check list.
  if (plan.closesFlag) {
    const evidence = plan.newStatement
      ? { ...(f.evidence ?? {}), previous_statement: f.claims.canonical_statement }
      : f.evidence
    const { data: closed, error } = await db
      .from("claim_flags")
      .update({ resolved_at: new Date().toISOString(), resolution: plan.resolution, evidence })
      .eq("id", flagId)
      .is("resolved_at", null)
      .select("id")
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!closed) return NextResponse.json({ error: "This flag was already resolved" }, { status: 409 })
  } else if (plan.markVideoCheck) {
    const { error } = await db
      .from("claim_flags")
      .update({ needs_video_check_at: new Date().toISOString() })
      .eq("id", flagId)
      .is("resolved_at", null)
    if (error) {
      const missing = /needs_video_check_at/.test(error.message)
      return NextResponse.json(
        { error: missing ? "Needs Video Check is not available yet: migration 036 has not been applied." : error.message },
        { status: missing ? 409 : 500 }
      )
    }
  }

  // 3. The claim's visibility, decided by lib/claimGate.ts.
  if (plan.claimStatus) {
    const { error } = await db.from("claims").update({ status: plan.claimStatus }).eq("id", f.claim_id).eq("status", "flagged")
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    claimStatus: plan.claimStatus ?? undefined,
    statement: plan.newStatement ?? undefined,
    embeddingRefreshed,
  })
}
