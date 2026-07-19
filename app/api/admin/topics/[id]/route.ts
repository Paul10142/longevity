import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { generateEmbedding } from "@/lib/embeddings"
import { recomputeTopicCounts } from "@/lib/taxonomy"

/**
 * Audit actions on an AI-created topic. Every action marks reviewed_by_human.
 *   rename    { name }              — updates name + re-embeds for future matching
 *   reparent  { parent_id|null }    — moves under a new parent (rejects cycles)
 *   describe  { description }
 *   archive                          — hides the topic (claims keep other topics)
 *   merge     { into_id }            — folds this topic's claims into another, archives this
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const { id } = await params
  const body = await request.json()
  const action = body.action as string

  const { data: topic, error: findErr } = await supabaseAdmin
    .from("topics")
    .select("id, name, parent_id")
    .eq("id", id)
    .single()
  if (findErr || !topic) return NextResponse.json({ error: "Topic not found" }, { status: 404 })

  switch (action) {
    case "rename": {
      const name = String(body.name ?? "").trim()
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })
      const embedding = await generateEmbedding(name)
      await supabaseAdmin.from("topics").update({ name, embedding, reviewed_by_human: true }).eq("id", id)
      break
    }
    case "describe": {
      await supabaseAdmin
        .from("topics")
        .update({ description: body.description ?? null, reviewed_by_human: true })
        .eq("id", id)
      break
    }
    case "reparent": {
      const parentId = body.parent_id || null
      if (parentId) {
        if (parentId === id) return NextResponse.json({ error: "A topic cannot be its own parent" }, { status: 400 })
        if (await createsCycle(id, parentId)) {
          return NextResponse.json({ error: "That would create a cycle" }, { status: 400 })
        }
      }
      await supabaseAdmin.from("topics").update({ parent_id: parentId, reviewed_by_human: true }).eq("id", id)
      break
    }
    case "archive": {
      // Re-parent this topic's children to its parent so they don't dangle.
      await supabaseAdmin.from("topics").update({ parent_id: topic.parent_id }).eq("parent_id", id)
      await supabaseAdmin.from("topics").update({ status: "archived", reviewed_by_human: true }).eq("id", id)
      break
    }
    case "merge": {
      const intoId = body.into_id as string
      if (!intoId || intoId === id) return NextResponse.json({ error: "valid into_id required" }, { status: 400 })
      // Move claim links (ignore conflicts where the claim is already in the target).
      const { data: links } = await supabaseAdmin.from("claim_topics").select("claim_id").eq("topic_id", id)
      for (const l of (links ?? []) as { claim_id: string }[]) {
        await supabaseAdmin
          .from("claim_topics")
          .upsert({ claim_id: l.claim_id, topic_id: intoId, assigned_by: "human" }, { onConflict: "claim_id,topic_id" })
      }
      await supabaseAdmin.from("claim_topics").delete().eq("topic_id", id)
      // Move children under the merge target.
      await supabaseAdmin.from("topics").update({ parent_id: intoId }).eq("parent_id", id)
      await supabaseAdmin.from("topics").update({ status: "archived", reviewed_by_human: true }).eq("id", id)
      await supabaseAdmin.from("topics").update({ reviewed_by_human: true }).eq("id", intoId)
      await recomputeTopicCounts()
      break
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}

/** Would setting parent(childId) = ancestorId create a cycle? */
async function createsCycle(childId: string, ancestorId: string): Promise<boolean> {
  if (!supabaseAdmin) return false
  let cursor: string | null = ancestorId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === childId) return true
    if (seen.has(cursor)) return true
    seen.add(cursor)
    const { data }: { data: { parent_id: string | null } | null } = await supabaseAdmin
      .from("topics")
      .select("parent_id")
      .eq("id", cursor)
      .single()
    cursor = data?.parent_id ?? null
  }
  return false
}
