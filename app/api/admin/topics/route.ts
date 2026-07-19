import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

/** All active topics with claim counts, for the audit tree. */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const { data, error } = await supabaseAdmin
    .from("topics")
    .select("id, name, slug, description, parent_id, created_by, reviewed_by_human, claim_count, created_at")
    .eq("status", "active")
    .order("name", { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ topics: data ?? [] })
}
