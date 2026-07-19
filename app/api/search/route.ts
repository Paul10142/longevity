import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { generateEmbedding } from "@/lib/embeddings"

export const dynamic = "force-dynamic"

/**
 * Semantic search over claims. Embeds the query and runs the match_claims ANN
 * RPC, then attaches each claim's primary topic for linking. POST { query }.
 */
export async function POST(request: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  try {
    const { query } = await request.json()
    if (!query || typeof query !== "string" || !query.trim()) {
      return NextResponse.json({ error: "query required" }, { status: 400 })
    }

    const embedding = await generateEmbedding(query.trim())
    const { data: matches, error } = await supabaseAdmin.rpc("match_claims", {
      query_embedding: embedding,
      match_threshold: 0.15, // low floor: search wants recall, not dedup precision
      match_count: 30,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const claims = (matches ?? []) as { id: string; canonical_statement: string; similarity: number }[]
    if (claims.length === 0) return NextResponse.json({ results: [] })

    // Attach one topic per claim for linking.
    const { data: links } = await supabaseAdmin
      .from("claim_topics")
      .select("claim_id, topics ( name, slug )")
      .in("claim_id", claims.map((c) => c.id))
    const topicByClaim = new Map<string, { name: string; slug: string }>()
    for (const l of (links ?? []) as { claim_id: string; topics: { name: string; slug: string } | null }[]) {
      if (l.topics && !topicByClaim.has(l.claim_id)) topicByClaim.set(l.claim_id, l.topics)
    }

    const results = claims.map((c) => ({
      id: c.id,
      statement: c.canonical_statement,
      similarity: c.similarity,
      topic: topicByClaim.get(c.id) ?? null,
    }))
    return NextResponse.json({ results })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
