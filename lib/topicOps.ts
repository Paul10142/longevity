/**
 * Shared taxonomy-edit operations.
 *
 * These are the human-curation primitives — rename, describe, re-parent,
 * archive, merge — used by BOTH the per-topic audit route
 * (`app/api/admin/topics/[id]/route.ts`) and the batch change-plan route
 * (`app/api/admin/topics/curate/route.ts`). They live here so the subtle
 * merge logic (M:N `claim_topics` batching + the concurrent-`tag_claims`
 * claim-link-loss fix, commit ebe3697) is written once and can't drift
 * between the two callers.
 *
 * Every op marks `reviewed_by_human = true` — a human touched the topic.
 * None of these check `is_spine`: the pipeline forbids the AI from editing
 * spine branches, but this curation surface IS the sanctioned human
 * exception, so the guard lives in the UI (a warning), not here.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { generateEmbedding } from "@/lib/embeddings"

type Db = SupabaseClient

/** Rename a topic and re-embed for future matching. NEVER changes the slug —
 * the slug is the stable identifier URLs and generated articles depend on. */
export async function renameTopic(db: Db, id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("name required")
  const embedding = await generateEmbedding(trimmed)
  const { error } = await db
    .from("topics")
    .update({ name: trimmed, embedding, reviewed_by_human: true })
    .eq("id", id)
  if (error) throw new Error(error.message)
}

export async function describeTopic(db: Db, id: string, description: string | null): Promise<void> {
  const { error } = await db
    .from("topics")
    .update({ description: description ?? null, reviewed_by_human: true })
    .eq("id", id)
  if (error) throw new Error(error.message)
}

/** Move a topic under a new parent (null = top level). Rejects self-parent and cycles. */
export async function reparentTopic(db: Db, id: string, parentId: string | null): Promise<void> {
  const parent = parentId || null
  if (parent) {
    if (parent === id) throw new Error("A topic cannot be its own parent")
    if (await createsCycle(db, id, parent)) throw new Error("That would create a cycle")
  }
  const { error } = await db
    .from("topics")
    .update({ parent_id: parent, reviewed_by_human: true })
    .eq("id", id)
  if (error) throw new Error(error.message)
}

/** Archive a topic. Its children are lifted to its parent so they don't dangle;
 * claims keep any other topics they belong to. */
export async function archiveTopic(db: Db, id: string): Promise<void> {
  const { data: topic } = await db.from("topics").select("parent_id").eq("id", id).single()
  await db.from("topics").update({ parent_id: topic?.parent_id ?? null }).eq("parent_id", id)
  const { error } = await db
    .from("topics")
    .update({ status: "archived", reviewed_by_human: true })
    .eq("id", id)
  if (error) throw new Error(error.message)
}

/**
 * Fold `id`'s claims and children into `intoId`, then archive `id` (recording
 * the survivor so its old slug 301-redirects).
 *
 * Claim links are drained in batches, and only the exact claim_ids just moved
 * are deleted — a blanket `delete().eq("topic_id", id)` would also destroy
 * links a concurrent `tag_claims` job added after our read, silently dropping
 * a claim's topic instead of moving it. Batching also dodges PostgREST's
 * default 1000-row read cap.
 */
export async function mergeTopics(db: Db, id: string, intoId: string): Promise<void> {
  if (!intoId || intoId === id) throw new Error("valid merge target required")
  if (await createsCycle(db, intoId, id)) {
    // Merging a topic into one of its own descendants would orphan the subtree.
    throw new Error("Cannot merge a topic into its own descendant")
  }
  const MERGE_BATCH = 500
  for (let pass = 0; pass < 100; pass++) {
    const { data: links } = await db
      .from("claim_topics")
      .select("claim_id")
      .eq("topic_id", id)
      .limit(MERGE_BATCH)
    const claimIds = ((links ?? []) as { claim_id: string }[]).map((l) => l.claim_id)
    if (claimIds.length === 0) break
    for (const claimId of claimIds) {
      await db
        .from("claim_topics")
        .upsert(
          { claim_id: claimId, topic_id: intoId, assigned_by: "human" },
          { onConflict: "claim_id,topic_id" }
        )
    }
    await db.from("claim_topics").delete().eq("topic_id", id).in("claim_id", claimIds)
  }
  // Move children under the merge target, then archive the merged topic.
  await db.from("topics").update({ parent_id: intoId }).eq("parent_id", id)
  const { error } = await db
    .from("topics")
    .update({ status: "archived", merged_into_id: intoId, reviewed_by_human: true })
    .eq("id", id)
  if (error) throw new Error(error.message)
  await db.from("topics").update({ reviewed_by_human: true }).eq("id", intoId)
}

/** Would setting parent(childId) = ancestorId create a cycle? */
export async function createsCycle(db: Db, childId: string, ancestorId: string): Promise<boolean> {
  let cursor: string | null = ancestorId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === childId) return true
    if (seen.has(cursor)) return true
    seen.add(cursor)
    const { data }: { data: { parent_id: string | null } | null } = await db
      .from("topics")
      .select("parent_id")
      .eq("id", cursor)
      .single()
    cursor = data?.parent_id ?? null
  }
  return false
}
