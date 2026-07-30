import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { subtreeClaimCounts, isVisibleCount } from "@/lib/topicVisibility"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * Topic tree for the header mega-menu: top-level pillars, each with its most
 * substantial child topics. One flat read (well under the 1000-row cap) shaped
 * into a tree in JS, rather than a query per pillar.
 */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ pillars: [] })
  }

  const { data, error } = await supabaseAdmin
    .from("topics")
    .select("id, name, slug, parent_id, claim_count")
    .eq("status", "active")
    .order("claim_count", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // `is_hidden` is intentionally NOT selected above (migration 018 not applied
  // yet); it stays optional here so the future curator override is type-wired
  // without the read depending on the column existing.
  type Row = { id: string; name: string; slug: string; parent_id: string | null; claim_count: number | null; is_hidden?: boolean | null }
  const rows = (data ?? []) as Row[]

  // Visibility gate: the mega-menu is a public surface, so only advertise topics
  // whose subtree has matured past the threshold. Thin topics still exist (admins
  // see them under /admin/topics) but never appear in public navigation.
  const counts = subtreeClaimCounts(rows)
  const visible = (r: Row) => isVisibleCount(counts.get(r.id) ?? 0, r.is_hidden)

  const childrenByParent = new Map<string, Row[]>()
  for (const r of rows) {
    if (!r.parent_id) continue
    if (!visible(r)) continue
    const list = childrenByParent.get(r.parent_id) ?? []
    list.push(r)
    childrenByParent.set(r.parent_id, list)
  }

  const MAX_CHILDREN = 6
  const pillars = rows
    .filter((r) => !r.parent_id && visible(r))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const kids = childrenByParent.get(p.id) ?? []
      return {
        name: p.name,
        slug: p.slug,
        childCount: kids.length,
        children: kids.slice(0, MAX_CHILDREN).map((c) => ({ name: c.name, slug: c.slug })),
      }
    })

  return NextResponse.json({ pillars })
}
