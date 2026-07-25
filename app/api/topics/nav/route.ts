import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

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

  type Row = { id: string; name: string; slug: string; parent_id: string | null; claim_count: number | null }
  const rows = (data ?? []) as Row[]

  const childrenByParent = new Map<string, Row[]>()
  for (const r of rows) {
    if (!r.parent_id) continue
    const list = childrenByParent.get(r.parent_id) ?? []
    list.push(r)
    childrenByParent.set(r.parent_id, list)
  }

  const MAX_CHILDREN = 6
  const pillars = rows
    .filter((r) => !r.parent_id)
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
