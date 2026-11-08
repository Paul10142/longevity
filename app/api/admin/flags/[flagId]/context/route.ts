import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { loadFlagContext } from "@/lib/flagContext"

export const dynamic = "force-dynamic"

/**
 * Everything the review screen shows for one flag: the claim with the judge's
 * reason, the surrounding transcript with the quoted span marked, and the
 * YouTube link ~30 s before the claim. Read-only. The route is behind the
 * /admin gate (middleware.ts).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ flagId: string }> }) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { flagId } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(flagId)) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 })
  }
  try {
    const ctx = await loadFlagContext(supabaseAdmin, flagId)
    if (!ctx) return NextResponse.json({ error: "Flag not found" }, { status: 404 })
    return NextResponse.json({ context: ctx })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load context" }, { status: 500 })
  }
}
