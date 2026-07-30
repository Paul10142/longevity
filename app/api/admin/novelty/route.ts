import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { computeNovelty } from "@/lib/novelty"

export const dynamic = "force-dynamic"

/**
 * Per-source NOVELTY report (spec §9): the engine's dedup value, made visible.
 *
 * Read-only, HTTP-facing twin of `npm run pipeline -- novelty` (scripts/
 * pipeline.ts, case 'novelty'). The classification lives in lib/novelty.ts so
 * this route, the admin page, and the CLI all agree. No writes, no LLM.
 */
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured. Please set up environment variables." },
      { status: 500 }
    )
  }

  try {
    const report = await computeNovelty(supabaseAdmin)
    return NextResponse.json(report)
  } catch (error) {
    console.error("Error in GET /api/admin/novelty:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
