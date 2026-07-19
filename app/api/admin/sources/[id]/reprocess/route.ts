import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { enqueueJob, pingWorker } from "@/lib/jobs"

/**
 * Re-extract a source. v2: wipes this source's prior derived data
 * (raw_insights — chunks are cleared by the extractor) and enqueues a fresh
 * `extract_source` job. Claims from other sources are untouched; consolidation
 * re-links this source's new raw insights on the next stage.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const { id } = await params

    const { data: source, error: sourceError } = await supabaseAdmin
      .from("sources")
      .select("id, transcript")
      .eq("id", id)
      .single()

    if (sourceError || !source) {
      return NextResponse.json(
        { error: `Source not found: ${sourceError?.message}` },
        { status: 404 }
      )
    }
    if (!source.transcript) {
      return NextResponse.json(
        { error: "Source has no transcript to process" },
        { status: 400 }
      )
    }

    // Clear this source's prior raw insights. Their claim_members rows cascade;
    // claims left with zero members are cleaned up by the consolidation stage.
    const { error: delErr } = await supabaseAdmin
      .from("raw_insights")
      .delete()
      .eq("source_id", id)
    if (delErr) {
      return NextResponse.json(
        { error: `Failed to clear prior insights: ${delErr.message}` },
        { status: 500 }
      )
    }

    await supabaseAdmin
      .from("sources")
      .update({ processing_status: "pending", processing_error: null })
      .eq("id", id)

    await enqueueJob("extract_source", { source_id: id })
    pingWorker(request.nextUrl.origin)

    return NextResponse.json({
      success: true,
      sourceId: id,
      message: "Re-extraction queued.",
    })
  } catch (error) {
    console.error("Error in POST /api/admin/sources/[id]/reprocess:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
