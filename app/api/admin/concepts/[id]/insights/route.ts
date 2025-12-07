import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

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
    const body = await request.json()
    const { insight_ids } = body

    if (!Array.isArray(insight_ids)) {
      return NextResponse.json(
        { error: "insight_ids must be an array" },
        { status: 400 }
      )
    }

    // Delete existing links for this concept
    const { error: deleteError } = await supabaseAdmin
      .from("insight_concepts")
      .delete()
      .eq("concept_id", id)

    if (deleteError) {
      console.error("Error deleting existing links:", deleteError)
      return NextResponse.json(
        { error: `Failed to clear existing links: ${deleteError.message}` },
        { status: 500 }
      )
    }

    // Insert new links
    if (insight_ids.length > 0) {
      const linksToInsert = insight_ids.map((insightId: string) => ({
        concept_id: id,
        insight_id: insightId,
      }))

      const { error: insertError } = await supabaseAdmin
        .from("insight_concepts")
        .insert(linksToInsert)

      if (insertError) {
        console.error("Error inserting links:", insertError)
        return NextResponse.json(
          { error: `Failed to create links: ${insertError.message}` },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({
      success: true,
      message: `Linked ${insight_ids.length} insights to concept`,
    })
  } catch (error) {
    console.error("Error in POST /api/admin/concepts/[id]/insights:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

