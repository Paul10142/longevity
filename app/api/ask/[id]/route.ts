import { NextRequest, NextResponse } from "next/server"
import { isAdmin } from "@/lib/isAdmin"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { loadAnswer } from "@/lib/ask/store"
import { loadClaimEvidence, rankEpisodes } from "@/lib/ask/provenance"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A stored answer, for sharing a link and for the admin log: the text, the
 * numbered citations, the cited claims' representative evidence, the episodes
 * behind them ("Go deeper") and the nearest topic pages.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  try {
    const a = await loadAnswer(id)
    if (!a) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const evidence = await loadClaimEvidence(a.cited_claim_ids)
    return NextResponse.json({
      id: a.id,
      question: a.question,
      status: a.status,
      body: a.body_markdown,
      cited: a.cited_claim_ids.map((claim_id, i) => ({ n: i + 1, claim_id })),
      follow_ups: a.follow_ups ?? [],
      thin: a.thin,
      related_topics: a.related_topics ?? [],
      // Keyed by claim id; the evidence panel can open without another round trip.
      claims: Object.fromEntries(evidence),
      episodes: rankEpisodes(a.cited_claim_ids, evidence),
      answered_at: a.created_at,
      latency_ms: a.latency_ms,
      groundedness_score: a.groundedness_score,
      error: a.error,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 })
  }
}
