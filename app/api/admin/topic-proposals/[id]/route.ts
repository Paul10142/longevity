import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { generateEmbedding } from "@/lib/embeddings"

/**
 * Decide a topic proposal.
 *   approve → create the topic under a chosen parent, then re-flag the claims
 *             that motivated it so tagging can file them into the new home.
 *   reject  → close the proposal; the claims keep their approximate filing.
 *
 * The name and parent are editable at approval time — the model's suggestion is
 * a starting point, not a decision.
 */

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const db = supabaseAdmin

  const { id } = await params
  const body = await request.json()
  const action = body.action

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 })
  }

  const { data: proposal, error } = await db
    .from("topic_proposals")
    .select("id, name, proposed_parent_id, claim_ids, status")
    .eq("id", id)
    .single()
  if (error || !proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 })
  }
  if (proposal.status !== "pending") {
    return NextResponse.json({ error: "Proposal already decided" }, { status: 409 })
  }

  if (action === "reject") {
    await db
      .from("topic_proposals")
      .update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: "admin" })
      .eq("id", id)
    return NextResponse.json({ ok: true })
  }

  // ── approve ──────────────────────────────────────────────
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : proposal.name
  const parentId = body.parent_id ?? proposal.proposed_parent_id
  if (!parentId) {
    return NextResponse.json(
      { error: "A parent branch is required — new top-level branches are not created from proposals." },
      { status: 400 }
    )
  }

  // The parent must be curated. Without this check a caller could pass any
  // topic id and hang the approved topic off a legacy AI-minted root, which is
  // the sprawl this queue exists to stop.
  const { data: parent } = await db
    .from("topics")
    .select("id")
    .eq("id", parentId)
    .eq("status", "active")
    .eq("is_spine", true)
    .maybeSingle()
  if (!parent) {
    return NextResponse.json(
      { error: "Parent must be a curated (spine) topic." },
      { status: 400 }
    )
  }

  // Reuse an existing topic of the same name rather than creating a duplicate.
  // Scoped to active rows AND to this parent, matching the
  // `topics_active_name_per_parent_idx` index: uniqueness is per-sibling-set, so
  // "Hormones" may legitimately exist under both Risks and Endocrinology. A
  // name-only lookup could match both and blow up on maybeSingle(), and reusing
  // a same-named topic from a different branch would be wrong anyway.
  const { data: clash } = await db
    .from("topics")
    .select("id")
    .eq("status", "active")
    .eq("parent_id", parentId)
    .ilike("name", name)
    .maybeSingle()
  let topicId = clash?.id as string | undefined

  if (!topicId) {
    // Embed BEFORE inserting: a topic with no embedding is invisible to the
    // match_topics ANN search, which would silently degrade tagging. Failing
    // here leaves nothing half-created.
    let embedding: number[]
    try {
      embedding = await generateEmbedding(name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { error: `Could not embed the new topic, so nothing was created: ${message}` },
        { status: 502 }
      )
    }

    let slug = slugify(name) || "topic"
    for (let n = 2; ; n++) {
      const { data: slugClash } = await db.from("topics").select("id").eq("slug", slug).limit(1)
      if (!slugClash || slugClash.length === 0) break
      slug = `${slugify(name)}-${n}`
    }

    const { data: created, error: insErr } = await db
      .from("topics")
      .insert({
        name,
        slug,
        parent_id: parentId,
        created_by: "human",
        reviewed_by_human: true,
        embedding,
      })
      .select("id")
      .single()
    if (insErr || !created) {
      return NextResponse.json(
        { error: `Failed to create topic: ${insErr?.message}` },
        { status: 500 }
      )
    }
    topicId = created.id
  }

  // Re-tag the motivating claims so they can be filed into the new topic.
  const claimIds: string[] = proposal.claim_ids ?? []
  for (let i = 0; i < claimIds.length; i += 200) {
    await db.from("claims").update({ needs_tagging: true }).in("id", claimIds.slice(i, i + 200))
  }

  await db
    .from("topic_proposals")
    .update({
      status: "approved",
      created_topic_id: topicId,
      decided_at: new Date().toISOString(),
      decided_by: "admin",
    })
    .eq("id", id)

  return NextResponse.json({ ok: true, topicId, reflagged: claimIds.length })
}
