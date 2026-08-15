import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { recomputeTopicCounts } from "@/lib/taxonomy"
import { renameTopic, reparentTopic, archiveTopic, mergeTopics } from "@/lib/topicOps"

/**
 * Apply a staged taxonomy change-plan as one batch.
 *
 * Body: { operations: Op[] } applied IN ORDER against the live DB, so each op
 * sees the effect of the ones before it (cycle checks, merged parents, etc.
 * all read consistent state). One `recomputeTopicCounts()` runs at the end.
 *
 * Op =
 *   | { type: "rename",   id, name }
 *   | { type: "reparent", id, parent_id | null }
 *   | { type: "merge",    id, into_id }
 *   | { type: "archive",  id }
 *
 * Each op's outcome is returned individually; a failed op does not abort the
 * rest, so the client can show exactly what applied and what didn't.
 */
type Op =
  | { type: "rename"; id: string; name: string }
  | { type: "review"; id: string }
  | { type: "reparent"; id: string; parent_id: string | null }
  | { type: "merge"; id: string; into_id: string }
  | { type: "archive"; id: string }

export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const db = supabaseAdmin
  const body = await request.json()
  const operations = (body.operations ?? []) as Op[]
  if (!Array.isArray(operations) || operations.length === 0) {
    return NextResponse.json({ error: "operations array required" }, { status: 400 })
  }
  if (operations.length > 500) {
    return NextResponse.json({ error: "too many operations (max 500)" }, { status: 400 })
  }

  const results: { index: number; type: string; ok: boolean; error?: string }[] = []

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    try {
      switch (op.type) {
        case "rename":
          await renameTopic(db, op.id, op.name)
          break
        case "reparent":
          await reparentTopic(db, op.id, op.parent_id ?? null)
          break
        case "merge":
          await mergeTopics(db, op.id, op.into_id)
          break
        case "archive":
          await archiveTopic(db, op.id)
          break
        case "review": {
          // Sign-off as-is: no structural change, just the human's approval.
          const { error } = await db.from("topics").update({ reviewed_by_human: true }).eq("id", op.id)
          if (error) throw new Error(error.message)
          break
        }
        default:
          throw new Error(`unknown op type: ${(op as { type: string }).type}`)
      }
      results.push({ index: i, type: op.type, ok: true })
    } catch (e) {
      results.push({ index: i, type: op.type, ok: false, error: (e as Error).message })
    }
  }

  // Counts shift on merge/reparent/archive; refresh once for the whole batch.
  await recomputeTopicCounts()

  const applied = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  return NextResponse.json({ ok: failed.length === 0, applied, failed, results })
}
