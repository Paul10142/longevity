import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { recomputeTopicCounts } from "@/lib/taxonomy"
import {
  renameTopic,
  describeTopic,
  reparentTopic,
  archiveTopic,
  mergeTopics,
} from "@/lib/topicOps"

/**
 * Audit actions on a single topic. Every action marks reviewed_by_human.
 *   rename    { name }              — updates name + re-embeds for future matching
 *   reparent  { parent_id|null }    — moves under a new parent (rejects cycles)
 *   describe  { description }
 *   archive                          — hides the topic (claims keep other topics)
 *   merge     { into_id }            — folds this topic's claims into another, archives this
 *
 * The operation bodies live in `lib/topicOps.ts`, shared with the batch
 * change-plan route (`../curate`).
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
    .select("id")
    .eq("id", id)
    .single()
  if (findErr || !topic) return NextResponse.json({ error: "Topic not found" }, { status: 404 })

  try {
    switch (action) {
      case "rename":
        await renameTopic(supabaseAdmin, id, String(body.name ?? ""))
        break
      case "describe":
        await describeTopic(supabaseAdmin, id, body.description ?? null)
        break
      case "reparent":
        await reparentTopic(supabaseAdmin, id, body.parent_id || null)
        break
      case "archive":
        await archiveTopic(supabaseAdmin, id)
        break
      case "review":
        // Sign-off with no structural change — "I looked at this topic and it's
        // fine as-is." Every other action implies review; this is the explicit one.
        {
          const { error } = await supabaseAdmin
            .from("topics")
            .update({ reviewed_by_human: true })
            .eq("id", id)
          if (error) throw new Error(error.message)
        }
        break
      case "merge":
        await mergeTopics(supabaseAdmin, id, body.into_id as string)
        await recomputeTopicCounts()
        break
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
